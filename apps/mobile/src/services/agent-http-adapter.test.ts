import { describe, expect, it, vi } from 'vitest';
import { createAgentTurnTransport } from './agent-http-adapter';
import {
  AgentMessageShapeError,
  AgentPolicyError,
  AgentTurnInvalidError,
  AgentAuthError,
  AgentRateLimitError,
  AgentServerError,
  AgentNetworkError,
  StaleTurnError,
} from './agent-errors';
import { runAgentLoop } from './advice-agent-loop';
import { adviceStateFixture } from './advice-context.fixtures';

const turn = {
  version: 1 as const,
  turnId: 'turn',
  userMessageId: 'message',
  sessionId: 'session',
  scenarioId: null,
  stateRevision: 0,
  language: 'vi' as const,
  currency: 'VND' as const,
};
const call = {
  id: 'call',
  type: 'function' as const,
  function: {
    name: 'get_financial_snapshot',
    arguments: JSON.stringify({ months: 6, fields: ['monthly_income_avg'] }),
  },
};
const policy = {
  sessionId: 'session',
  scenarioId: null,
  stateRevision: 0,
  grants: [
    {
      name: 'get_financial_snapshot',
      params: { months: 6, fields: ['monthly_income_avg'] },
    },
  ],
};
const response = (extra: object = {}) =>
  Response.json({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { role: 'assistant', content: null, tool_calls: [call] },
      },
    ],
    continuationToken: 'token',
    deadline: 1,
    policy,
    ...extra,
  });
const step = {
  turnId: 'turn',
  sessionId: 'session',
  userMessageId: 'message',
  stateRevision: 0,
  question: 'question',
  allowedTools: ['get_financial_snapshot'],
  messages: [{ role: 'user' as const, content: 'question' }],
  timeoutMs: 15000,
};
const signal = new AbortController().signal;

describe('agent turn transport', () => {
  it('rejects stale current metadata before final request and keeps token for cancellation', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(Response.json({}));
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
      getCurrentMetadata: () => ({ stateRevision: 1, scenarioId: null }),
    });
    await transport.selectTools(step, signal);
    await expect(
      transport.finalize({ ...step, observations: [] }, signal),
    ).rejects.toBeInstanceOf(StaleTurnError);
    expect(fetchFn).toHaveBeenCalledOnce();
    await transport.onTurnEnd({
      turnId: 'turn',
      outcome: 'fallback',
      messages: [],
    });
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toMatchObject({
      action: 'cancel',
      continuationToken: 'token',
    });
  });
  it.each(['closed', 'allowed', 'message', 'stale'])(
    'rejects invalid finalize precondition %s before fetch',
    async (variant) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(Response.json({}));
      const transport = createAgentTurnTransport({
        baseUrl: 'https://example.test',
        turn,
        fetchFn,
      });
      await transport.selectTools(step, signal);
      if (variant === 'closed')
        await transport.onTurnEnd({
          turnId: 'turn',
          outcome: 'completed',
          messages: [],
        });
      const input = {
        ...step,
        observations: [],
        ...(variant === 'allowed'
          ? { allowedTools: ['plan_savings_goal'] }
          : {}),
        ...(variant === 'message'
          ? { messages: [{ role: 'tool' as const, content: 'bad' }] }
          : {}),
        ...(variant === 'stale' ? { stateRevision: 1 } : {}),
      };
      const cls =
        variant === 'closed'
          ? AgentTurnInvalidError
          : variant === 'allowed'
            ? AgentPolicyError
            : variant === 'message'
              ? AgentMessageShapeError
              : StaleTurnError;
      await expect(transport.finalize(input, signal)).rejects.toBeInstanceOf(
        cls,
      );
      expect(fetchFn).toHaveBeenCalledOnce();
    },
  );
  it.each([
    [
      'event: delta\ndata: {"seq":1,"text":"verified","verification":"segment_passed"}\n\nevent: done\ndata: {"incomplete":false,"verification":"passed"}\n\n',
      'completed',
      'verified',
    ],
    [
      'event: delta\ndata: {"seq":1,"text":"verified","verification":"segment_passed"}\n\nevent: error\ndata: {"code":"VERIFICATION_FAILED","incomplete":true,"verification":"failed"}\n\n',
      'incomplete',
      'verified',
    ],
    [
      'event: error\ndata: {"code":"VERIFICATION_FAILED","incomplete":true,"verification":"failed"}\n\n',
      'fallback',
      undefined,
    ],
  ])(
    'integrates final SSE with the real loop case %#',
    async (events, status, expectedText) => {
      const stop = response({
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: null, tool_calls: [] },
          },
        ],
        continuationToken: 'second',
      });
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(stop)
        .mockResolvedValueOnce(
          new Response(events, {
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
      const transport = createAgentTurnTransport({
        baseUrl: 'https://example.test',
        turn,
        fetchFn,
      });
      const executeTool = vi.fn().mockResolvedValue({
        status: 'ok',
        stateRevision: 0,
        calculationVersion: 1,
        data: {},
      });
      const result = await runAgentLoop(
        { ...step, state: null },
        {
          ...transport,
          now: () => 0,
          readRevision: async () => null,
          executeTool,
        },
      );
      expect(result.status).toBe(status);
      if (expectedText) expect(result).toMatchObject({ text: expectedText });
      else expect(result).toMatchObject({ reason: 'VERIFICATION_FAILED' });
      expect(fetchFn).toHaveBeenCalledTimes(3);
    },
  );
  it('keeps token after final HTTP error and attempts cancellation', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(
        Response.json({ code: 'INVALID_TOKEN' }, { status: 401 }),
      )
      .mockResolvedValueOnce(Response.json({}));
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    await transport.selectTools(step, signal);
    await expect(
      transport.finalize({ ...step, observations: [] }, signal),
    ).rejects.toBeInstanceOf(AgentTurnInvalidError);
    await transport.onTurnEnd({
      turnId: 'turn',
      outcome: 'fallback',
      messages: [],
    });
    expect(JSON.parse(fetchFn.mock.calls[2][1].body)).toMatchObject({
      action: 'cancel',
      continuationToken: 'token',
    });
  });
  it('rejects a non-SSE final response without attempting cancellation', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(Response.json({}));
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    await transport.selectTools(step, signal);
    await expect(
      transport.finalize({ ...step, observations: [] }, signal),
    ).rejects.toMatchObject({
      name: 'AgentServerError',
      status: 200,
      code: 'INVALID_CONTENT_TYPE',
    });
    await transport.onTurnEnd({
      turnId: 'turn',
      outcome: 'fallback',
      messages: [],
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it('posts the verified final stream and does not cancel a claimed final turn', async () => {
    const events =
      'event: delta\ndata: {"seq":1,"text":"verified","verification":"segment_passed"}\n\nevent: done\ndata: {"incomplete":false,"verification":"passed"}\n\n';
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(
        new Response(events, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    const onDelta = vi.fn();
    const onVerifiedSegment = vi.fn();
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
      onDelta,
    });
    await transport.selectTools(step, signal);
    expect(
      await transport.finalize(
        { ...step, observations: [], onVerifiedSegment },
        signal,
      ),
    ).toEqual({ verification: 'passed', text: 'verified', incomplete: false });
    const init = fetchFn.mock.calls[1][1];
    expect(init.headers.Accept).toBe('text/event-stream');
    expect(JSON.parse(init.body)).toMatchObject({
      allowTools: false,
      stream: true,
      continuationToken: 'token',
      messages: step.messages,
    });
    expect(onVerifiedSegment).toHaveBeenCalledWith('verified');
    expect(onDelta).toHaveBeenCalledOnce();
    expect(onVerifiedSegment.mock.invocationCallOrder[0]).toBeLessThan(
      onDelta.mock.invocationCallOrder[0],
    );
    await transport.onTurnEnd({
      turnId: 'turn',
      outcome: 'completed',
      messages: [],
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it('cancels the saved prefix when the real loop detects a stale scenario', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(Response.json({}));
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
      getCurrentMetadata: () => ({ stateRevision: 0, scenarioId: 'changed' }),
    });
    const executeTool = vi.fn().mockResolvedValue({
      status: 'ok',
      stateRevision: 0,
      calculationVersion: 1,
      data: {},
    });
    expect(
      await runAgentLoop(
        { ...step, state: null },
        {
          ...transport,
          now: () => 0,
          readRevision: async () => null,
          executeTool,
        },
      ),
    ).toMatchObject({ status: 'fallback', reason: 'STALE_TURN' });
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toMatchObject({
      turn,
      continuationToken: 'token',
      action: 'cancel',
      messages: [
        step.messages[0],
        { role: 'assistant', content: null, tool_calls: [call] },
      ],
    });
  });
  it.each(['DATA_ERROR', 'TIMEOUT'] as const)(
    'cancels the signed prefix after tool %s',
    async (code) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(Response.json({}));
      const transport = createAgentTurnTransport({
        baseUrl: 'https://example.test',
        turn,
        fetchFn,
      });
      const executeTool = vi
        .fn()
        .mockResolvedValue({ status: 'error', code, retryable: false });
      expect(
        await runAgentLoop(
          { ...step, state: null },
          {
            ...transport,
            now: () => 0,
            readRevision: async () => null,
            executeTool,
          },
        ),
      ).toMatchObject({ status: 'fallback', reason: code });
      expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toMatchObject({
        action: 'cancel',
        messages: [
          step.messages[0],
          { role: 'assistant', content: null, tool_calls: [call] },
        ],
      });
    },
  );
  it('closes a savings clarification with the real loop', async () => {
    const { state } = adviceStateFixture();
    const savingsTurn = {
      ...turn,
      sessionId: state.sessionId,
      scenarioId: state.activeScenario.id,
      stateRevision: state.revision,
    };
    const savingsCall = {
      id: 'savings',
      type: 'function',
      function: { name: 'plan_savings_goal', arguments: '{}' },
    };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [savingsCall],
              },
            },
          ],
          policy: {
            sessionId: state.sessionId,
            scenarioId: state.activeScenario.id,
            stateRevision: state.revision,
            grants: [{ name: 'plan_savings_goal', params: {} }],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: 'needs_clarification',
          fields: ['savingsForGoal'],
        }),
      );
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn: savingsTurn,
      fetchFn,
    });
    const executeTool = vi.fn().mockResolvedValue({
      status: 'needs_clarification',
      fields: ['savingsForGoal'],
    });
    const result = await runAgentLoop(
      {
        turnId: 'turn',
        sessionId: state.sessionId,
        userMessageId: 'message',
        question: 'question',
        state,
        allowedTools: ['plan_savings_goal'],
      },
      {
        ...transport,
        now: () => 0,
        readRevision: async () => state.revision,
        executeTool,
      },
    );
    expect(result).toMatchObject({
      status: 'needs_clarification',
      fields: ['savingsForGoal'],
    });
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toMatchObject({
      stream: true,
      allowTools: false,
      allowedTools: ['plan_savings_goal'],
    });
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).not.toHaveProperty(
      'action',
    );
  });
  it('sends the complete two-call clarification batch to close', async () => {
    const second = {
      ...call,
      id: 'second',
      function: {
        ...call.function,
        arguments: JSON.stringify({
          months: 3,
          fields: ['monthly_income_avg'],
        }),
      },
    };
    const secondGrant = {
      name: 'get_financial_snapshot',
      params: { months: 3, fields: ['monthly_income_avg'] },
    };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [call, second],
              },
            },
          ],
          policy: { ...policy, grants: [...policy.grants, secondGrant] },
        }),
      )
      .mockResolvedValueOnce(Response.json({}));
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    const executeTool = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'needs_clarification',
        fields: ['income'],
      })
      .mockResolvedValueOnce({
        status: 'ok',
        stateRevision: 0,
        calculationVersion: 1,
        data: {},
      });
    expect(
      await runAgentLoop(
        { ...step, state: null },
        {
          ...transport,
          now: () => 0,
          readRevision: async () => null,
          executeTool,
        },
      ),
    ).toMatchObject({ status: 'needs_clarification' });
    const close = JSON.parse(fetchFn.mock.calls[1][1].body);
    expect(
      close.messages
        .slice(-2)
        .map((item: { tool_call_id: string }) => item.tool_call_id),
    ).toEqual(['call', 'second']);
    expect(close.stream).toBe(true);
    expect(close).not.toHaveProperty('action');
  });
  it('executes a valid retry after a rejected batch and cancels after stop', async () => {
    const errors = [
      {
        tool_call_id: 'call',
        result: { status: 'error', code: 'INVALID_PARAMS', retryable: false },
      },
    ];
    const nextCall = { ...call, id: 'second' };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response({ toolErrors: errors }))
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [nextCall],
              },
            },
          ],
          continuationToken: 'second-token',
        }),
      )
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: null, tool_calls: [] },
            },
          ],
          continuationToken: 'third-token',
        }),
      )
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(Response.json({}));
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    const executeTool = vi.fn().mockResolvedValue({
      status: 'ok',
      stateRevision: 0,
      calculationVersion: 1,
      data: {},
    });
    expect(
      await runAgentLoop(
        { ...step, state: null },
        {
          ...transport,
          now: () => 0,
          readRevision: async () => null,
          executeTool,
        },
      ),
    ).toMatchObject({ status: 'fallback' });
    expect(executeTool).toHaveBeenCalledOnce();
    expect(
      JSON.parse(fetchFn.mock.calls[1][1].body).messages.at(-1).content,
    ).toBe(JSON.stringify(errors[0].result));
    expect(JSON.parse(fetchFn.mock.calls[4][1].body)).toMatchObject({
      continuationToken: 'third-token',
      action: 'cancel',
    });
  });
  it('continues despite an old server deadline and unchanged metadata', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => response());
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
      getCurrentMetadata: () => ({ stateRevision: 0, scenarioId: null }),
    });
    await transport.selectTools(step, signal);
    await transport.selectTools(step, signal);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchFn.mock.calls[1][1].body).continuationToken).toBe(
      'token',
    );
  });
  it.each([{ turnId: 'other' }, { stateRevision: 1 }, { sessionId: 'other' }])(
    'rejects mismatched step metadata %#',
    async (different) => {
      const fetchFn = vi.fn();
      const transport = createAgentTurnTransport({
        baseUrl: 'https://example.test',
        turn,
        fetchFn,
      });
      await expect(
        transport.selectTools({ ...step, ...different }, signal),
      ).rejects.toBeInstanceOf(StaleTurnError);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...policy, sessionId: 'other' },
    { ...policy, stateRevision: 2 },
    { ...policy, grants: [{ name: 'plan_savings_goal', params: {} }] },
  ])('rejects mismatched server policy %#', async (invalidPolicy) => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(response({ policy: invalidPolicy }));
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    await expect(transport.selectTools(step, signal)).rejects.toBeInstanceOf(
      AgentPolicyError,
    );
  });
  it.each([
    { messages: [{ role: 'tool', content: 'x' }] },
    { messages: [{ role: 'assistant', tool_calls: [] }] },
    { messages: [{ role: 'user', content: '' }] },
    { messages: [{ role: 'user', content: 'x'.repeat(501) }] },
  ])('rejects malformed messages %#', async ({ messages }) => {
    const fetchFn = vi.fn();
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    await expect(
      transport.selectTools(
        { ...step, messages: messages as unknown as typeof step.messages },
        signal,
      ),
    ).rejects.toBeInstanceOf(AgentMessageShapeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('normalizes IDs and strips undefined keys in assistant and tool messages', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response());
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    const messages = [
      { role: 'user' as const, content: 'question', tool_call_id: undefined },
      {
        role: 'assistant' as const,
        tool_calls: [
          {
            ...call,
            id: ' call ',
            function: { ...call.function, name: ' get_financial_snapshot ' },
          },
        ],
      },
      { role: 'tool' as const, tool_call_id: ' call ', content: '{}' },
    ];
    await transport.selectTools({ ...step, messages }, signal);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).messages).toEqual([
      step.messages[0],
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: 'call', content: '{}' },
    ]);
  });
  it('retains token after a network failure and cancels with the last signed prefix', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(Response.json({}));
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    await transport.selectTools(step, signal);
    await expect(transport.selectTools(step, signal)).rejects.toBeInstanceOf(
      AgentNetworkError,
    );
    await transport.onTurnEnd({
      turnId: 'turn',
      outcome: 'fallback',
      messages: [],
    });
    expect(JSON.parse(fetchFn.mock.calls[2][1].body)).toMatchObject({
      action: 'cancel',
      continuationToken: 'token',
    });
  });
  it('runs the real loop and cancels the signed stop prefix after final network failure', async () => {
    const stop = response({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: null, tool_calls: [] },
        },
      ],
      continuationToken: 'second',
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(stop)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(
        Response.json({ status: 'error', code: 'TURN_CANCELLED' }),
      );
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    const executeTool = vi.fn().mockResolvedValue({
      status: 'ok',
      stateRevision: 0,
      calculationVersion: 1,
      data: { indicators: { monthly_income_avg: 100 } },
    });
    const result = await runAgentLoop(
      { ...step, state: null },
      {
        ...transport,
        now: () => 0,
        readRevision: async () => null,
        executeTool,
      },
    );
    expect(result).toMatchObject({ status: 'fallback', reason: 'DATA_ERROR' });
    expect(executeTool).toHaveBeenCalledOnce();
    const second = JSON.parse(fetchFn.mock.calls[1][1].body);
    const cancel = JSON.parse(fetchFn.mock.calls[3][1].body);
    expect(second.continuationToken).toBe('token');
    expect(cancel).toMatchObject({
      action: 'cancel',
      continuationToken: 'second',
      messages: second.messages,
      allowedTools: step.allowedTools,
    });
  });
  it('closes a complete clarification batch without cancel', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(
        Response.json({ status: 'needs_clarification', fields: ['income'] }),
      );
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    const executeTool = vi
      .fn()
      .mockResolvedValue({ status: 'needs_clarification', fields: ['income'] });
    const result = await runAgentLoop(
      { ...step, state: null },
      {
        ...transport,
        now: () => 0,
        readRevision: async () => null,
        executeTool,
      },
    );
    expect(result).toMatchObject({
      status: 'needs_clarification',
      fields: ['income'],
    });
    const close = JSON.parse(fetchFn.mock.calls[1][1].body);
    expect(close).toMatchObject({
      continuationToken: 'token',
      allowTools: false,
      stream: true,
      allowedTools: step.allowedTools,
    });
    expect(close).not.toHaveProperty('action');
    expect(close.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call',
      content: JSON.stringify({
        status: 'needs_clarification',
        fields: ['income'],
      }),
    });
  });
  it('returns initial policy clarification without opening or closing a turn', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        Response.json({ status: 'needs_clarification', fields: ['income'] }),
      );
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    expect(await transport.selectTools(step, signal)).toEqual({
      status: 'needs_clarification',
      fields: ['income'],
    });
    await transport.onTurnEnd({
      turnId: 'turn',
      outcome: 'needs_clarification',
      messages: step.messages,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it('preserves server batch rejection and does not cancel a terminal rejection', async () => {
    const errors = [
      {
        tool_call_id: 'call',
        result: { status: 'error', code: 'TOOL_NOT_ALLOWED', retryable: false },
      },
    ];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response({ toolErrors: errors }))
      .mockResolvedValueOnce(
        Response.json({
          status: 'error',
          code: 'TOOL_NOT_ALLOWED',
          toolErrors: errors,
        }),
      );
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    const executeTool = vi.fn();
    expect(
      await runAgentLoop(
        { ...step, state: null },
        {
          ...transport,
          now: () => 0,
          readRevision: async () => null,
          executeTool,
        },
      ),
    ).toMatchObject({ status: 'fallback', reason: 'TOOL_NOT_ALLOWED' });
    expect(executeTool).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(fetchFn.mock.calls[1][1].body).messages.at(-1),
    ).toMatchObject({
      role: 'tool',
      tool_call_id: 'call',
      content: JSON.stringify(errors[0].result),
    });
  });
  it.each(['stateRevision', 'scenarioId'])(
    'cancels using the original snapshot when %s changes',
    async (changed) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(Response.json({}));
      const getCurrentMetadata = vi
        .fn()
        .mockReturnValue(
          changed === 'stateRevision'
            ? { stateRevision: 1, scenarioId: null }
            : { stateRevision: 0, scenarioId: 'other' },
        );
      const transport = createAgentTurnTransport({
        baseUrl: 'https://example.test',
        turn,
        fetchFn,
        getCurrentMetadata,
      });
      await transport.selectTools(step, signal);
      await expect(transport.selectTools(step, signal)).rejects.toBeInstanceOf(
        StaleTurnError,
      );
      expect(fetchFn).toHaveBeenCalledOnce();
      await transport.onTurnEnd({
        turnId: 'turn',
        outcome: 'fallback',
        messages: [],
      });
      expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toMatchObject({
        turn,
        continuationToken: 'token',
        action: 'cancel',
      });
    },
  );
  it('clones metadata and trims identifiers', async () => {
    const mutable = {
      ...turn,
      turnId: ' turn ',
      categories: [{ id: ' category ', name: 'category' }],
    };
    const fetchFn = vi.fn().mockResolvedValue(response());
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn: mutable,
      fetchFn,
    });
    mutable.categories[0].id = 'changed';
    await transport.selectTools(step, signal);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).turn).toMatchObject({
      turnId: 'turn',
      categories: [{ id: 'category' }],
    });
    expect(() =>
      createAgentTurnTransport({
        baseUrl: 'x',
        turn: { ...turn, turnId: ' ' },
        fetchFn,
      }),
    ).toThrow();
  });
  it.each([401, 429, 500, 502])('classifies HTTP %i', async (status) => {
    const fetchFn = vi.fn().mockResolvedValue(
      Response.json(
        {
          error: 'INVALID_TOKEN',
          code: status === 429 ? 'RATE_LIMIT_EXCEEDED' : undefined,
        },
        { status },
      ),
    );
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    const cls =
      status === 401
        ? AgentAuthError
        : status === 429
          ? AgentRateLimitError
          : AgentServerError;
    await expect(transport.selectTools(step, signal)).rejects.toBeInstanceOf(
      cls,
    );
  });
  it('classifies network rejection and propagates abort', async () => {
    const error = new Error('network');
    const fetchFn = vi.fn().mockRejectedValue(error);
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    await expect(transport.selectTools(step, signal)).rejects.toBeInstanceOf(
      AgentNetworkError,
    );
    const controller = new AbortController();
    controller.abort();
    await expect(transport.selectTools(step, controller.signal)).rejects.toBe(
      error,
    );
  });
  it('does not wait indefinitely for a cancellation that ignores abort', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockImplementationOnce(() => new Promise(() => {}));
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
      closeTimeoutMs: 5,
    });
    await transport.selectTools(step, signal);
    await expect(
      transport.onTurnEnd({
        turnId: 'turn',
        outcome: 'fallback',
        messages: [],
      }),
    ).resolves.toBeUndefined();
  });
  it('sends the first selection and stores the deadline', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response());
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test/',
      turn,
      fetchFn,
      authHeaders: { 'x-device-id': 'test' },
    });
    expect(await transport.selectTools(step, signal)).toMatchObject({
      finishReason: 'tool_calls',
      message: { tool_calls: [call] },
    });
    const init = fetchFn.mock.calls[0][1];
    expect(JSON.parse(init.body)).toEqual({
      turn,
      messages: step.messages,
      allowedTools: step.allowedTools,
      allowTools: true,
      stream: false,
    });
    expect(init.signal).toBe(signal);
    expect(init.headers['x-device-id']).toBe('test');
    expect(transport.getLastDeadline()).toBe(1);
  });
  it('retains token after a 401 and attempts cancellation once', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(
        Response.json({ code: 'INVALID_TOKEN' }, { status: 401 }),
      )
      .mockResolvedValueOnce(Response.json({}, { status: 401 }));
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    await transport.selectTools(step, signal);
    await expect(transport.selectTools(step, signal)).rejects.toBeInstanceOf(
      AgentTurnInvalidError,
    );
    await transport.onTurnEnd({
      turnId: 'turn',
      outcome: 'fallback',
      messages: [],
    });
    await transport.onTurnEnd({
      turnId: 'turn',
      outcome: 'fallback',
      messages: [],
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchFn.mock.calls[2][1].body)).toMatchObject({
      continuationToken: 'token',
      action: 'cancel',
      messages: [
        step.messages[0],
        { role: 'assistant', content: null, tool_calls: [call] },
      ],
    });
  });
  it('rejects locally denied calls after retaining the signed prefix', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response({ policy: { ...policy, grants: [] } }))
      .mockResolvedValueOnce(Response.json({}));
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    await expect(transport.selectTools(step, signal)).rejects.toBeInstanceOf(
      AgentPolicyError,
    );
    await transport.onTurnEnd({
      turnId: 'turn',
      outcome: 'fallback',
      messages: [],
    });
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toMatchObject({
      continuationToken: 'token',
      action: 'cancel',
    });
  });
  it('rejects whitespace-only message IDs before network access', async () => {
    const fetchFn = vi.fn();
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    await expect(
      transport.selectTools(
        {
          ...step,
          messages: [{ role: 'tool', tool_call_id: ' ', content: 'x' }],
        },
        signal,
      ),
    ).rejects.toBeInstanceOf(AgentMessageShapeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('requires a continuation token before finalization', async () => {
    const fetchFn = vi.fn();
    const transport = createAgentTurnTransport({
      baseUrl: 'https://example.test',
      turn,
      fetchFn,
    });
    await expect(
      transport.finalize({ ...step, observations: [] }, signal),
    ).rejects.toBeInstanceOf(AgentTurnInvalidError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
