import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '@pfm/contracts';
import { StaleTurnError } from './agent-errors';
import { adviceStateFixture } from './advice-context.fixtures';
import {
  runAgentLoop,
  type AgentLoopDependencies,
  type AgentLoopInput,
} from './advice-agent-loop';

const snapshotParams = { months: 6, fields: ['monthly_income_avg'] };
function selection(
  name = 'get_financial_snapshot',
  params: unknown = snapshotParams,
  id = 'call-1',
) {
  return {
    finishReason: 'tool_calls',
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(params) },
        },
      ],
    },
  };
}
function setup() {
  const input: AgentLoopInput = {
    sessionId: 'session-1',
    userMessageId: 'message-1',
    question: 'Cho tôi xem thu nhập trung bình sáu tháng.',
    state: null,
    allowedTools: ['get_financial_snapshot'],
  };
  const result: ToolResult = {
    status: 'ok',
    stateRevision: 0,
    calculationVersion: 1,
    data: { indicators: { monthly_income_avg: 15_000_000 } },
  };
  const deps = {
    now: vi.fn(() => 0),
    selectTools: vi
      .fn<AgentLoopDependencies['selectTools']>()
      .mockImplementation(async (request) =>
        request.messages.length === 1
          ? selection()
          : {
              finishReason: 'stop',
              message: { role: 'assistant', content: null },
            },
      ),
    executeTool: vi
      .fn<AgentLoopDependencies['executeTool']>()
      .mockResolvedValue(result),
    readRevision: vi
      .fn<AgentLoopDependencies['readRevision']>()
      .mockResolvedValue(null),
    finalize: vi
      .fn<AgentLoopDependencies['finalize']>()
      .mockResolvedValue({ verification: 'passed' }),
  };
  return { input, deps, result };
}
afterEach(() => vi.useRealTimers());

describe('bounded advice agent loop', () => {
  it('falls back when finalization times out before a verified segment', async () => {
    vi.useFakeTimers();
    const { input, deps } = setup();
    deps.finalize.mockImplementation(() => new Promise(() => {}));
    const pending = runAgentLoop(input, deps);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toMatchObject({
      status: 'fallback',
      reason: 'MODEL_TIMEOUT',
    });
  });
  it.each([true, false])(
    'handles shared turn timeout with verified prefix=%s',
    async (hasPrefix) => {
      vi.useFakeTimers();
      const { input, deps } = setup();
      let time = 0;
      deps.now.mockImplementation(() => time);
      deps.selectTools.mockImplementation(async (frame) => {
        time += 14000;
        return frame.messages.length === 1
          ? selection()
          : {
              finishReason: 'stop',
              message: { role: 'assistant', content: null },
            };
      });
      deps.finalize.mockImplementation((frame) => {
        if (hasPrefix) frame.onVerifiedSegment?.('verified');
        return new Promise(() => {});
      });
      const pending = runAgentLoop(input, deps);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toMatchObject(
        hasPrefix
          ? { status: 'incomplete', text: 'verified', reason: 'TURN_TIMEOUT' }
          : { status: 'fallback', reason: 'TURN_TIMEOUT' },
      );
    },
  );
  it('returns fallback if revision changes after a partial final response', async () => {
    const { input, deps } = setup();
    deps.readRevision
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(1);
    deps.finalize.mockResolvedValue({
      verification: 'failed',
      incomplete: true,
      text: 'verified',
      errorCode: 'VERIFICATION_FAILED',
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'STATE_ERROR',
    });
  });
  it('reports incomplete to turn cleanup', async () => {
    const { input, deps } = setup();
    deps.finalize.mockResolvedValue({
      verification: 'incomplete',
      incomplete: true,
      text: 'verified',
    });
    const onTurnEnd = vi.fn();
    expect(
      await runAgentLoop({ ...input, turnId: 'turn' }, { ...deps, onTurnEnd }),
    ).toMatchObject({ status: 'incomplete', reason: 'UNVERIFIED_FINAL' });
    expect(onTurnEnd).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'incomplete' }),
    );
  });
  it('returns verified final text when the finalizer completes', async () => {
    const { input, deps } = setup();
    deps.finalize.mockResolvedValue({
      verification: 'passed',
      text: 'verified',
      incomplete: false,
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'completed',
      text: 'verified',
    });
  });
  it('returns a verified prefix when final verification fails', async () => {
    const { input, deps } = setup();
    deps.finalize.mockResolvedValue({
      verification: 'failed',
      incomplete: true,
      text: 'verified',
      errorCode: 'VERIFICATION_FAILED',
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'incomplete',
      text: 'verified',
      reason: 'VERIFICATION_FAILED',
    });
  });
  it('returns fallback when no verified text remains', async () => {
    const { input, deps } = setup();
    deps.finalize.mockResolvedValue({
      verification: 'failed',
      incomplete: true,
      text: '',
      errorCode: 'VERIFICATION_FAILED',
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'VERIFICATION_FAILED',
    });
  });
  it('preserves the verified prefix on finalization timeout', async () => {
    vi.useFakeTimers();
    const { input, deps } = setup();
    deps.finalize.mockImplementation((frame) => {
      frame.onVerifiedSegment?.('verified');
      return new Promise(() => {});
    });
    const pending = runAgentLoop(input, deps);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toMatchObject({
      status: 'incomplete',
      text: 'verified',
      reason: 'MODEL_TIMEOUT',
    });
  });
  it('stops after two consecutive denied selections', async () => {
    const { input, deps } = setup();
    const denial = (id: string) => ({
      ...selection('get_financial_snapshot', snapshotParams, id),
      toolErrors: [
        {
          tool_call_id: id,
          result: {
            status: 'error',
            code: 'TOOL_NOT_ALLOWED',
            retryable: false,
          },
        },
      ],
    });
    deps.selectTools
      .mockResolvedValueOnce(denial('a'))
      .mockResolvedValueOnce(denial('b'));
    expect(await runAgentLoop(input, deps)).toMatchObject({
      reason: 'TOOL_NOT_ALLOWED',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it('counts a denial in the final round against the selection limit', async () => {
    const { input, deps } = setup();
    deps.selectTools
      .mockResolvedValueOnce(selection())
      .mockResolvedValueOnce(
        selection(
          'get_financial_snapshot',
          { months: 3, fields: ['monthly_income_avg'] },
          'b',
        ),
      )
      .mockResolvedValueOnce({
        ...selection('get_financial_snapshot', snapshotParams, 'c'),
        toolErrors: [
          {
            tool_call_id: 'c',
            result: { status: 'error', code: 'STATE_ERROR', retryable: false },
          },
        ],
      });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      reason: 'ROUND_LIMIT',
    });
    expect(deps.selectTools).toHaveBeenCalledTimes(3);
    expect(deps.executeTool).toHaveBeenCalledTimes(2);
  });
  it('ignores an empty denial list and allows the existing flow', async () => {
    const { input, deps } = setup();
    deps.selectTools.mockResolvedValueOnce({ ...selection(), toolErrors: [] });
    expect((await runAgentLoop(input, deps)).status).toBe('completed');
  });
  it('handles denied malformed arguments without parsing them', async () => {
    const { input, deps } = setup();
    const batch = selection();
    batch.message.tool_calls[0].function.arguments = '{';
    deps.selectTools
      .mockResolvedValueOnce({
        ...batch,
        toolErrors: [
          {
            tool_call_id: 'call-1',
            result: {
              status: 'error',
              code: 'INVALID_PARAMS',
              retryable: false,
            },
          },
        ],
      })
      .mockResolvedValueOnce(
        selection('get_financial_snapshot', snapshotParams, 'b'),
      );
    expect((await runAgentLoop(input, deps)).status).toBe('completed');
    expect(deps.executeTool).toHaveBeenCalledOnce();
  });
  it.each([
    'unknown',
    'missing',
    'duplicate',
    'different',
    'invalid',
    'retry',
    'no_calls',
  ])('rejects invalid selection denial %s', async (variant) => {
    const { input, deps } = setup();
    const batch = selection();
    batch.message.tool_calls.push(
      selection('get_financial_snapshot', snapshotParams, 'b').message
        .tool_calls[0],
    );
    const error = (id: string, code = 'INVALID_PARAMS', retryable = false) => ({
      tool_call_id: id,
      result: { status: 'error', code, retryable },
    });
    const variants = {
      unknown: [error('call-1'), error('unknown')],
      missing: [error('call-1')],
      duplicate: [error('call-1'), error('call-1')],
      different: [error('call-1'), error('b', 'STATE_ERROR')],
      invalid: [error('call-1', 'BAD'), error('b', 'BAD')],
      retry: [error('call-1', 'INVALID_PARAMS', true), error('b')],
      no_calls: [error('call-1')],
    };
    if (variant === 'no_calls') batch.message.tool_calls = [];
    deps.selectTools.mockResolvedValueOnce({
      ...batch,
      toolErrors: variants[variant as keyof typeof variants],
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      reason: 'INVALID_SELECTION',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it.each([
    [],
    [
      {
        tool_call_id: '',
        result: { status: 'error', code: 'STATE_ERROR', retryable: false },
      },
    ],
    [
      {
        tool_call_id: 'x',
        result: { status: 'error', code: 'WRONG', retryable: false },
      },
    ],
    [
      {
        tool_call_id: 'x',
        result: { status: 'error', code: 'STATE_ERROR', retryable: true },
      },
    ],
    Array.from({ length: 2 }, () => ({
      tool_call_id: 'x',
      result: { status: 'error', code: 'STATE_ERROR', retryable: false },
    })),
    [
      {
        tool_call_id: 'x',
        result: { status: 'error', code: 'STATE_ERROR', retryable: false },
      },
      {
        tool_call_id: 'y',
        result: { status: 'error', code: 'INVALID_PARAMS', retryable: false },
      },
    ],
    Array.from({ length: 3 }, (_, i) => ({
      tool_call_id: String(i),
      result: { status: 'error', code: 'STATE_ERROR', retryable: false },
    })),
  ])('rejects malformed terminal denial %#', async (...toolErrors) => {
    const { input, deps } = setup();
    deps.selectTools.mockResolvedValueOnce({
      status: 'error',
      code: 'TOOL_NOT_ALLOWED',
      toolErrors,
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'INVALID_SELECTION',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it.each([{ code: 'OTHER' }, { message: {} }, { finishReason: 'stop' }])(
    'rejects conflicting terminal denial %#',
    async (extra) => {
      const { input, deps } = setup();
      deps.selectTools.mockResolvedValueOnce({
        status: 'error',
        code: 'TOOL_NOT_ALLOWED',
        toolErrors: [
          {
            tool_call_id: 'x',
            result: { status: 'error', code: 'STATE_ERROR', retryable: false },
          },
        ],
        ...extra,
      });
      expect(await runAgentLoop(input, deps)).toMatchObject({
        reason: 'INVALID_SELECTION',
      });
      expect(deps.executeTool).not.toHaveBeenCalled();
    },
  );
  it.each([[], [' '], ['x'.repeat(121)], Array(33).fill('x')])(
    'rejects invalid policy clarification fields %#',
    async (...fields) => {
      const { input, deps } = setup();
      deps.selectTools.mockResolvedValueOnce({
        status: 'needs_clarification',
        fields,
      });
      expect(await runAgentLoop(input, deps)).toMatchObject({
        reason: 'INVALID_SELECTION',
      });
      expect(deps.executeTool).not.toHaveBeenCalled();
    },
  );
  it('rejects policy clarification after a completed tool', async () => {
    const { input, deps } = setup();
    deps.selectTools.mockResolvedValueOnce(selection()).mockResolvedValueOnce({
      status: 'needs_clarification',
      fields: ['income'],
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      reason: 'INVALID_SELECTION',
    });
    expect(deps.executeTool).toHaveBeenCalledOnce();
  });
  it('deduplicates clarification fields across the batch', async () => {
    const { input, deps } = setup();
    const batch = selection();
    batch.message.tool_calls.push(
      selection(
        'get_financial_snapshot',
        { months: 3, fields: ['monthly_income_avg'] },
        'call-2',
      ).message.tool_calls[0],
    );
    deps.selectTools.mockResolvedValueOnce(batch);
    deps.executeTool
      .mockResolvedValueOnce({
        status: 'needs_clarification',
        fields: ['a', 'b'],
      })
      .mockResolvedValueOnce({
        status: 'needs_clarification',
        fields: ['b', 'c'],
      });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'needs_clarification',
      fields: ['a', 'b', 'c'],
      observations: [expect.anything(), expect.anything()],
    });
  });
  it.each([0, 1])(
    'halts on a tool error at batch index %s',
    async (errorIndex) => {
      const { input, deps, result } = setup();
      const batch = selection();
      batch.message.tool_calls.push(
        selection(
          'get_financial_snapshot',
          { months: 3, fields: ['monthly_income_avg'] },
          'call-2',
        ).message.tool_calls[0],
      );
      deps.selectTools.mockResolvedValueOnce(batch);
      deps.executeTool
        .mockResolvedValueOnce(
          errorIndex
            ? { status: 'needs_clarification', fields: ['income'] }
            : { status: 'error', code: 'TIMEOUT', retryable: false },
        )
        .mockResolvedValueOnce(
          errorIndex
            ? { status: 'error', code: 'TIMEOUT', retryable: false }
            : result,
        );
      expect(await runAgentLoop(input, deps)).toMatchObject({
        status: 'fallback',
        reason: 'TIMEOUT',
      });
      expect(deps.executeTool).toHaveBeenCalledTimes(errorIndex + 1);
    },
  );
  it('copies the final transcript before cleanup can mutate it', async () => {
    const { input, deps } = setup();
    let finalMessages: unknown;
    deps.finalize.mockImplementation(async (frame) => {
      finalMessages = frame.messages;
      return { verification: 'passed' };
    });
    const onTurnEnd = vi.fn(
      async ({ messages }: { messages: { role: string }[] }) => {
        expect(messages).toEqual(finalMessages);
        messages[0].role = 'changed';
      },
    );
    await runAgentLoop({ ...input, turnId: 'turn-1' }, { ...deps, onTurnEnd });
    expect((finalMessages as { role: string }[])[0].role).toBe('user');
  });
  it('replays every rejected call in order and continues without executing it', async () => {
    const { input, deps } = setup();
    const first = selection();
    first.message.tool_calls.push(
      selection('get_financial_snapshot', snapshotParams, 'call-2').message
        .tool_calls[0],
    );
    const toolErrors = first.message.tool_calls.map(({ id }) => ({
      tool_call_id: id,
      result: { status: 'error', code: 'INVALID_PARAMS', retryable: false },
    }));
    deps.selectTools
      .mockReset()
      .mockResolvedValueOnce({ ...first, toolErrors })
      .mockResolvedValueOnce(
        selection('get_financial_snapshot', snapshotParams, 'call-3'),
      )
      .mockResolvedValueOnce({
        finishReason: 'stop',
        message: { role: 'assistant', content: null },
      });
    expect((await runAgentLoop(input, deps)).status).toBe('completed');
    expect(deps.executeTool).toHaveBeenCalledTimes(1);
    expect(deps.selectTools.mock.calls[1][0].messages.slice(1)).toEqual([
      first.message,
      ...first.message.tool_calls.map(({ id }) => ({
        role: 'tool',
        tool_call_id: id,
        content: '{"status":"error","code":"INVALID_PARAMS","retryable":false}',
      })),
    ]);
  });
  it('accepts the terminal denial frame without running tools', async () => {
    const { input, deps } = setup();
    const denied = (id: string) => [
      {
        tool_call_id: id,
        result: { status: 'error', code: 'INVALID_PARAMS', retryable: false },
      },
    ];
    deps.selectTools
      .mockReset()
      .mockResolvedValueOnce({ ...selection(), toolErrors: denied('call-1') })
      .mockResolvedValueOnce({
        status: 'error',
        code: 'TOOL_NOT_ALLOWED',
        toolErrors: denied('call-2'),
      });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'TOOL_NOT_ALLOWED',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });
  it('returns policy clarification without running tools', async () => {
    const { input, deps } = setup();
    deps.selectTools.mockResolvedValueOnce({
      status: 'needs_clarification',
      fields: ['income'],
    });
    expect(await runAgentLoop(input, deps)).toEqual({
      status: 'needs_clarification',
      fields: ['income'],
      observations: [],
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it('finishes the batch before returning clarification and passes the transcript to cleanup', async () => {
    const { input, deps } = setup();
    const first = selection();
    first.message.tool_calls.push(
      selection(
        'get_financial_snapshot',
        { months: 3, fields: ['monthly_income_avg'] },
        'call-2',
      ).message.tool_calls[0],
    );
    deps.selectTools.mockResolvedValueOnce(first);
    deps.executeTool.mockResolvedValueOnce({
      status: 'needs_clarification',
      fields: ['income'],
    });
    const onTurnEnd = vi.fn().mockResolvedValue(undefined);
    const result = await runAgentLoop(
      { ...input, turnId: 'turn-1' },
      { ...deps, onTurnEnd },
    );
    expect(result).toMatchObject({
      status: 'needs_clarification',
      fields: ['income'],
      observations: [expect.anything(), expect.anything()],
    });
    expect(deps.executeTool).toHaveBeenCalledTimes(2);
    expect(
      onTurnEnd.mock.calls[0][0].messages
        .slice(-2)
        .map((m: { tool_call_id: string }) => m.tool_call_id),
    ).toEqual(['call-1', 'call-2']);
  });
  it('propagates turnId to selections and finalization without adding an undefined key', async () => {
    const { input, deps } = setup();
    await runAgentLoop({ ...input, turnId: 'turn-1' }, deps);
    expect(deps.selectTools.mock.calls[0][0]).toHaveProperty(
      'turnId',
      'turn-1',
    );
    expect(deps.finalize.mock.calls[0][0]).toHaveProperty('turnId', 'turn-1');
    const next = setup();
    await runAgentLoop(next.input, next.deps);
    expect(next.deps.selectTools.mock.calls[0][0]).not.toHaveProperty('turnId');
  });
  it('calls onTurnEnd once with the completed outcome', async () => {
    const { input, deps } = setup();
    const onTurnEnd = vi.fn().mockResolvedValue(undefined);
    const result = await runAgentLoop(
      { ...input, turnId: 'turn-1' },
      { ...deps, onTurnEnd },
    );
    expect(result.status).toBe('completed');
    expect(onTurnEnd).toHaveBeenCalledExactlyOnceWith({
      messages: expect.any(Array),
      turnId: 'turn-1',
      outcome: 'completed',
    });
  });
  it('reports clarification to onTurnEnd', async () => {
    const { input, deps } = setup();
    const onTurnEnd = vi.fn().mockResolvedValue(undefined);
    deps.executeTool.mockResolvedValue({
      status: 'needs_clarification',
      fields: ['savingsForGoal'],
    });
    expect(
      (
        await runAgentLoop(
          { ...input, turnId: 'turn-1' },
          { ...deps, onTurnEnd },
        )
      ).status,
    ).toBe('needs_clarification');
    expect(onTurnEnd).toHaveBeenCalledExactlyOnceWith({
      messages: expect.any(Array),
      turnId: 'turn-1',
      outcome: 'needs_clarification',
    });
  });
  it('reports unexpected errors to onTurnEnd', async () => {
    const { input, deps } = setup();
    const onTurnEnd = vi.fn().mockResolvedValue(undefined);
    deps.selectTools.mockRejectedValueOnce(new Error('private data'));
    expect(
      await runAgentLoop(
        { ...input, turnId: 'turn-1' },
        { ...deps, onTurnEnd },
      ),
    ).toMatchObject({ reason: 'DATA_ERROR' });
    expect(onTurnEnd).toHaveBeenCalledExactlyOnceWith({
      messages: expect.any(Array),
      turnId: 'turn-1',
      outcome: 'fallback',
      fallbackReason: 'DATA_ERROR',
    });
  });
  it('reports the actual model timeout to onTurnEnd', async () => {
    vi.useFakeTimers();
    const { input, deps } = setup();
    const onTurnEnd = vi.fn().mockResolvedValue(undefined);
    deps.selectTools.mockImplementation(() => new Promise(() => {}));
    const pending = runAgentLoop(
      { ...input, turnId: 'turn-1' },
      { ...deps, onTurnEnd },
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({
      status: 'fallback',
      reason: 'MODEL_TIMEOUT',
    });
    expect(onTurnEnd).toHaveBeenCalledExactlyOnceWith({
      messages: expect.any(Array),
      turnId: 'turn-1',
      outcome: 'fallback',
      fallbackReason: 'MODEL_TIMEOUT',
    });
  });
  it('calls onTurnEnd even if the clock throws before the turn starts', async () => {
    const { input, deps } = setup();
    const onTurnEnd = vi.fn().mockResolvedValue(undefined);
    deps.now.mockImplementation(() => {
      throw new Error('clock failure');
    });
    await expect(
      runAgentLoop({ ...input, turnId: 'turn-1' }, { ...deps, onTurnEnd }),
    ).rejects.toThrow('clock failure');
    expect(onTurnEnd).toHaveBeenCalledExactlyOnceWith({
      messages: [],
      turnId: 'turn-1',
      outcome: 'fallback',
      fallbackReason: 'UNKNOWN',
    });
  });
  it('does not change the result or expose errors when cleanup fails', async () => {
    const { input, deps } = setup();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onTurnEnd = vi.fn().mockRejectedValue(new Error('private data'));
    try {
      expect(
        (
          await runAgentLoop(
            { ...input, turnId: 'turn-1' },
            { ...deps, onTurnEnd },
          )
        ).status,
      ).toBe('completed');
      expect(onTurnEnd).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledOnce();
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private data');
    } finally {
      warning.mockRestore();
    }
  });
  it('waits for asynchronous cleanup and skips it without a turn ID', async () => {
    const { input, deps } = setup();
    let finish!: () => void;
    const onTurnEnd = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let resolved = false;
    const pending = runAgentLoop(
      { ...input, turnId: 'turn-1' },
      { ...deps, onTurnEnd },
    ).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(onTurnEnd).toHaveBeenCalledOnce());
    expect(resolved).toBe(false);
    finish();
    await pending;
    expect(resolved).toBe(true);
    await runAgentLoop(input, { ...deps, onTurnEnd });
    expect(onTurnEnd).toHaveBeenCalledOnce();
  });
  it.each(['selectTools', 'executeTool'] as const)(
    'returns STALE_TURN when %s detects changed turn metadata',
    async (source) => {
      const { input, deps } = setup();
      deps[source].mockRejectedValueOnce(new StaleTurnError(2, 1));
      expect(await runAgentLoop(input, deps)).toMatchObject({
        status: 'fallback',
        reason: 'STALE_TURN',
      });
    },
  );
  it('allows a second parameter set for the same permitted tool before finalizing', async () => {
    const { input, deps } = setup();
    deps.selectTools
      .mockReset()
      .mockResolvedValueOnce(selection())
      .mockResolvedValueOnce(
        selection(
          'get_financial_snapshot',
          { months: 3, fields: ['monthly_income_avg'] },
          'second-period',
        ),
      )
      .mockResolvedValueOnce({
        finishReason: 'stop',
        message: { role: 'assistant', content: null },
      });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'completed',
    });
    expect(deps.executeTool).toHaveBeenCalledTimes(2);
    expect(deps.selectTools).toHaveBeenCalledTimes(3);
    expect(
      deps.finalize.mock.calls[0][0].observations.map((item) => item.params),
    ).toEqual([
      { months: 6, fields: ['monthly_income_avg'] },
      { months: 3, fields: ['monthly_income_avg'] },
    ]);
  });
  it.each([
    { status: 'unexpected' },
    { status: 'ok', stateRevision: 0 },
    { status: 'error', code: 'Private user data', retryable: false },
    { status: 'needs_clarification', fields: [] },
  ])(
    'rejects a malformed executor result without forwarding or caching it',
    async (result) => {
      const { input, deps } = setup();
      deps.executeTool.mockResolvedValue(result as never);
      const outcome = await runAgentLoop(input, deps);
      expect(outcome).toMatchObject({
        status: 'fallback',
        reason: 'DATA_ERROR',
        observations: [],
      });
      expect(deps.finalize).not.toHaveBeenCalled();
      expect(JSON.stringify(outcome)).not.toContain('Private user data');
    },
  );
  it('isolates fallback observations from a finalizer that mutates its input after timing out', async () => {
    vi.useFakeTimers();
    const { input, deps } = setup();
    deps.selectTools
      .mockReset()
      .mockResolvedValueOnce(selection())
      .mockResolvedValueOnce({
        finishReason: 'stop',
        message: { role: 'assistant', content: null },
      });
    let held!: Parameters<AgentLoopDependencies['finalize']>[0];
    deps.finalize.mockImplementation((request) => {
      held = request;
      return new Promise(() => {});
    });
    const pending = runAgentLoop(input, deps);
    await vi.advanceTimersByTimeAsync(15_000);
    const outcome = await pending;
    expect(outcome).toMatchObject({
      status: 'fallback',
      reason: 'MODEL_TIMEOUT',
    });
    const original = JSON.parse(JSON.stringify(outcome));
    const heldResult = held.observations[0].result;
    if (heldResult.status === 'ok') {
      const data = heldResult.data as {
        indicators: { monthly_income_avg: number };
      };
      data.indicators.monthly_income_avg = 1;
    }
    expect(outcome).toEqual(original);
    held.observations[0].result = {
      status: 'error',
      code: 'DATA_ERROR',
      retryable: false,
    };
    held.observations.length = 0;
    expect(outcome).toEqual(original);
  });
  it.each([
    null,
    { finishReason: 'stop', message: { role: 'user', content: 'wrong role' } },
    {
      finishReason: 'tool_calls',
      message: { role: 'assistant', tool_calls: 'not an array' },
    },
    {
      finishReason: 'stop',
      message: { role: 'assistant', content: 'x'.repeat(8193) },
    },
    { ...selection(), finishReason: 'stop' },
    { ...selection(), finishReason: 'unknown' },
  ])('rejects a malformed or inconsistent selection frame', async (frame) => {
    const { input, deps } = setup();
    deps.selectTools.mockResolvedValue(frame);
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'INVALID_SELECTION',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });
  it('rejects batches larger than two before checking permissions', async () => {
    const { input, deps } = setup();
    const batch = selection();
    batch.message.tool_calls.push(
      selection('get_financial_snapshot', snapshotParams, 'call-2').message
        .tool_calls[0],
      selection('get_financial_snapshot', snapshotParams, 'call-3').message
        .tool_calls[0],
    );
    deps.selectTools.mockResolvedValue(batch);
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'INVALID_SELECTION',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it('resets the denied streak on a permitted batch but never adds a fourth selection', async () => {
    const { input, deps } = setup();
    input.allowedTools.push('calculate_budget_status');
    deps.selectTools
      .mockResolvedValueOnce(selection('unknown', {}, 'bad-1'))
      .mockResolvedValueOnce(selection())
      .mockResolvedValueOnce(selection('unknown', {}, 'bad-3'));
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'ROUND_LIMIT',
    });
    expect(deps.selectTools).toHaveBeenCalledTimes(3);
    expect(deps.executeTool).toHaveBeenCalledOnce();
    expect(deps.finalize).not.toHaveBeenCalled();
  });
  it('rejects empty tool permissions before any model call', async () => {
    const { input, deps } = setup();
    input.allowedTools = [];
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'INVALID_INPUT',
    });
    expect(deps.selectTools).not.toHaveBeenCalled();
  });
  it('rejects state from another session', async () => {
    const { input, deps } = setup();
    input.state = adviceStateFixture().state;
    input.sessionId = 'another-session';
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'STATE_ERROR',
    });
    expect(deps.selectTools).not.toHaveBeenCalled();
  });
  it('does not forward an observation from an unexpected revision', async () => {
    const { input, deps, result } = setup();
    deps.executeTool.mockResolvedValue({ ...result, stateRevision: 1 });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'STATE_ERROR',
      observations: [],
    });
    expect(deps.finalize).not.toHaveBeenCalled();
  });
  it('does not accept an unverified final acknowledgement', async () => {
    const { input, deps } = setup();
    deps.finalize.mockResolvedValue({ verification: 'failed' } as never);
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'UNVERIFIED_FINAL',
    });
  });
  it('caps three selections and one final call while giving later steps only the remaining turn time', async () => {
    const { input, deps } = setup();
    input.allowedTools.push('calculate_budget_status');
    let time = 0;
    deps.now.mockImplementation(() => time);
    deps.selectTools
      .mockImplementationOnce(async () => {
        time = 14_000;
        return selection();
      })
      .mockImplementationOnce(async () => {
        time = 21_000;
        return selection('get_financial_snapshot', snapshotParams, 'cached-2');
      })
      .mockImplementationOnce(async () => {
        time = 28_000;
        return selection('get_financial_snapshot', snapshotParams, 'cached-3');
      });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'completed',
    });
    expect(deps.selectTools).toHaveBeenCalledTimes(3);
    expect(deps.executeTool).toHaveBeenCalledOnce();
    expect(
      deps.selectTools.mock.calls.map(([request]) => request.timeoutMs),
    ).toEqual([15_000, 15_000, 9_000]);
    expect(deps.finalize.mock.calls[0][0].timeoutMs).toBe(2_000);
    expect(deps.finalize).toHaveBeenCalledOnce();
  });
  it('rejects a late model response and aborts it without retrying', async () => {
    const { input, deps } = setup();
    let time = 0;
    deps.now.mockImplementation(() => time);
    deps.selectTools.mockImplementation(async () => {
      time = 15_001;
      return selection();
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'MODEL_TIMEOUT',
    });
    expect(deps.selectTools.mock.calls[0][1].aborted).toBe(true);
    expect(deps.selectTools).toHaveBeenCalledOnce();
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it('enforces the model timer even when the dependency ignores cancellation', async () => {
    vi.useFakeTimers();
    const { input, deps } = setup();
    deps.selectTools.mockImplementation(() => new Promise(() => {}));
    const pending = runAgentLoop(input, deps);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({
      status: 'fallback',
      reason: 'MODEL_TIMEOUT',
    });
    expect(deps.selectTools.mock.calls[0][1].aborted).toBe(true);
    expect(deps.executeTool).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('ignores a late SQLite result after 1.5 seconds without claiming to cancel SQLite itself', async () => {
    vi.useFakeTimers();
    const { input, deps, result } = setup();
    let resolveTool!: (result: ToolResult) => void;
    deps.executeTool.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTool = resolve;
        }),
    );
    const pending = runAgentLoop(input, deps);
    await vi.advanceTimersByTimeAsync(1_500);
    const outcome = await pending;
    expect(outcome).toMatchObject({
      status: 'fallback',
      reason: 'TOOL_TIMEOUT',
      observations: [],
    });
    resolveTool(result);
    await Promise.resolve();
    expect(outcome).toMatchObject({ observations: [] });
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('checks elapsed tool time even when a slow tool resolves before the timer callback runs', async () => {
    const { input, deps, result } = setup();
    let time = 0;
    deps.now.mockImplementation(() => time);
    deps.executeTool.mockImplementation(async () => {
      time = 1_501;
      return result;
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'TOOL_TIMEOUT',
      observations: [],
    });
    expect(deps.finalize).not.toHaveBeenCalled();
  });
  it('counts revision reads within the turn and never finalizes after 30 seconds', async () => {
    const { input, deps } = setup();
    let time = 0;
    deps.now.mockImplementation(() => time);
    deps.selectTools.mockImplementation(async () => {
      time = 30_001;
      return selection();
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'TURN_TIMEOUT',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });
  it('rejects a final response that completes after the shared deadline', async () => {
    const { input, deps } = setup();
    let time = 0;
    deps.now.mockImplementation(() => time);
    deps.selectTools.mockImplementationOnce(async () => {
      time = 14_000;
      return selection();
    });
    deps.finalize.mockImplementation(async () => {
      time = 30_001;
      return { verification: 'passed' };
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'TURN_TIMEOUT',
    });
    expect(deps.finalize).toHaveBeenCalledOnce();
  });
  it('does not hang forever while loading the current revision', async () => {
    vi.useFakeTimers();
    const { input, deps } = setup();
    deps.readRevision.mockImplementation(() => new Promise(() => {}));
    const pending = runAgentLoop(input, deps);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toMatchObject({
      status: 'fallback',
      reason: 'TOOL_TIMEOUT',
    });
    expect(deps.selectTools).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('checks revision again before finalizing', async () => {
    const { input, deps } = setup();
    deps.readRevision.mockResolvedValueOnce(null).mockResolvedValueOnce(1);
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'STATE_ERROR',
    });
    expect(deps.finalize).not.toHaveBeenCalled();
  });
  it('rejects revision changes while the final response is being verified', async () => {
    const { input, deps } = setup();
    deps.readRevision
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(1);
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'STATE_ERROR',
    });
  });
  it('requires final verification and never leaks dependency error messages', async () => {
    const { input, deps } = setup();
    deps.finalize.mockRejectedValue(
      new Error('Private user data must not escape'),
    );
    const outcome = await runAgentLoop(input, deps);
    expect(outcome).toMatchObject({ status: 'fallback', reason: 'DATA_ERROR' });
    expect(JSON.stringify(outcome)).not.toContain('Private user data');
  });
  it('executes a two-tool batch sequentially before finalizing', async () => {
    const { input, deps, result } = setup();
    input.allowedTools.push('calculate_budget_status');
    const batch = selection();
    batch.message.tool_calls.push(
      selection('calculate_budget_status', { month: '2026-11' }, 'call-2')
        .message.tool_calls[0],
    );
    deps.selectTools.mockResolvedValueOnce(batch);
    const events: string[] = [];
    deps.executeTool.mockImplementation(async (name) => {
      events.push(`start:${name}`);
      await Promise.resolve();
      events.push(`end:${name}`);
      return result;
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'completed',
    });
    expect(events).toEqual([
      'start:get_financial_snapshot',
      'end:get_financial_snapshot',
      'start:calculate_budget_status',
      'end:calculate_budget_status',
    ]);
    expect(
      deps.finalize.mock.calls[0][0].messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.tool_call_id),
    ).toEqual(['call-1', 'call-2']);
  });
  it('observes one result before selecting a second permitted tool', async () => {
    const { input, deps } = setup();
    input.allowedTools.push('calculate_budget_status');
    deps.selectTools
      .mockResolvedValueOnce(selection())
      .mockResolvedValueOnce(
        selection('calculate_budget_status', { month: '2026-11' }, 'call-2'),
      );
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'completed',
    });
    expect(deps.selectTools).toHaveBeenCalledTimes(3);
    expect(deps.selectTools.mock.calls[1][0].messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
    });
  });
  it.each(['savingsForGoal', 'savingsMonths'])(
    'ends locally when %s is missing',
    async (field) => {
      const { input, deps } = setup();
      input.state = adviceStateFixture().state;
      input.allowedTools = ['plan_savings_goal'];
      deps.readRevision.mockResolvedValue(1);
      deps.selectTools.mockResolvedValue(selection('plan_savings_goal', {}));
      deps.executeTool.mockResolvedValue({
        status: 'needs_clarification',
        fields: [field],
      });
      expect(await runAgentLoop(input, deps)).toMatchObject({
        status: 'needs_clarification',
        fields: [field],
      });
      expect(deps.finalize).not.toHaveBeenCalled();
      expect(deps.selectTools).toHaveBeenCalledOnce();
    },
  );
  it('accepts known zero and passes an isolated state to the existing executor', async () => {
    const { input, deps, result } = setup();
    input.state = adviceStateFixture().state;
    input.allowedTools = ['plan_savings_goal'];
    const original = JSON.parse(JSON.stringify(input));
    deps.readRevision.mockResolvedValue(1);
    deps.selectTools.mockResolvedValueOnce(selection('plan_savings_goal', {}));
    deps.executeTool.mockResolvedValue({ ...result, stateRevision: 1 });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'completed',
    });
    const context = deps.executeTool.mock.calls[0][3];
    expect(context.state?.activeScenario.savingsForGoal).toMatchObject({
      status: 'known',
      value: 0,
    });
    expect(context.state).not.toBe(input.state);
    expect(input).toEqual(original);
  });
  it('does not execute a savings tool without state', async () => {
    const { input, deps } = setup();
    input.allowedTools = ['plan_savings_goal'];
    deps.selectTools.mockResolvedValue(selection('plan_savings_goal', {}));
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'STATE_ERROR',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it('rejects a direct model answer before any successful tool', async () => {
    const { input, deps } = setup();
    deps.selectTools.mockResolvedValue({
      finishReason: 'stop',
      message: { role: 'assistant', content: 'Số tiền tự đoán' },
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'NO_TOOL_RESULT',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });
  it('denies every call in a mixed batch before checking arguments and allows one reselection', async () => {
    const { input, deps } = setup();
    const denied = selection();
    denied.message.tool_calls.push(
      selection('delete_everything', {}, 'bad-2').message.tool_calls[0],
    );
    denied.message.tool_calls[1].function.arguments = 'broken JSON';
    deps.selectTools
      .mockResolvedValueOnce(denied)
      .mockResolvedValueOnce(
        selection('get_financial_snapshot', snapshotParams, 'allowed-3'),
      );
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'completed',
    });
    expect(deps.executeTool).toHaveBeenCalledOnce();
    const messages = deps.selectTools.mock.calls[1][0].messages;
    expect(messages.filter((message) => message.role === 'tool')).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content:
          '{"status":"error","code":"TOOL_NOT_ALLOWED","retryable":false}',
      },
      {
        role: 'tool',
        tool_call_id: 'bad-2',
        content:
          '{"status":"error","code":"TOOL_NOT_ALLOWED","retryable":false}',
      },
    ]);
  });
  it('stops after two consecutive denied batches without executing any tool', async () => {
    const { input, deps } = setup();
    deps.selectTools
      .mockResolvedValueOnce(selection('unpermitted', {}, 'bad-1'))
      .mockResolvedValueOnce(selection('unpermitted', {}, 'bad-2'));
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'TOOL_NOT_ALLOWED',
    });
    expect(deps.selectTools).toHaveBeenCalledTimes(2);
    expect(deps.executeTool).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });
  it('validates all parameters before executing any member of a permitted batch', async () => {
    const { input, deps } = setup();
    input.allowedTools.push('calculate_budget_status');
    const batch = selection();
    batch.message.tool_calls.push(
      selection('calculate_budget_status', { month: 'bad' }, 'call-2').message
        .tool_calls[0],
    );
    deps.selectTools.mockResolvedValue(batch);
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'INVALID_PARAMS',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it.each(['{broken', '{"reason":"AI-only parameter"}', '{"income":15000000}'])(
    'rejects invalid savings arguments without stripping them: %s',
    async (args) => {
      const { input, deps } = setup();
      input.state = adviceStateFixture().state;
      input.allowedTools = ['plan_savings_goal'];
      deps.readRevision.mockResolvedValue(1);
      const batch = selection('plan_savings_goal', {});
      batch.message.tool_calls[0].function.arguments = args;
      deps.selectTools.mockResolvedValue(batch);
      expect(await runAgentLoop(input, deps)).toMatchObject({
        status: 'fallback',
        reason: 'INVALID_PARAMS',
      });
      expect(deps.executeTool).not.toHaveBeenCalled();
    },
  );
  it('rejects duplicated call IDs within a batch before execution', async () => {
    const { input, deps } = setup();
    const batch = selection();
    batch.message.tool_calls.push(batch.message.tool_calls[0]);
    deps.selectTools.mockResolvedValue(batch);
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'DUPLICATE_CALL_ID',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it('rejects a call ID reused in a later selection', async () => {
    const { input, deps } = setup();
    input.allowedTools.push('calculate_budget_status');
    deps.selectTools
      .mockResolvedValueOnce(selection())
      .mockResolvedValueOnce(
        selection('calculate_budget_status', { month: '2026-11' }),
      );
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'DUPLICATE_CALL_ID',
    });
    expect(deps.executeTool).toHaveBeenCalledOnce();
    expect(deps.finalize).not.toHaveBeenCalled();
  });
  it('reuses normalized tool results without re-executing or duplicating observations', async () => {
    const { input, deps } = setup();
    input.allowedTools.push('calculate_budget_status');
    deps.selectTools
      .mockResolvedValueOnce(selection())
      .mockResolvedValueOnce(
        selection('get_financial_snapshot', snapshotParams, 'cached-2'),
      )
      .mockResolvedValueOnce(
        selection('calculate_budget_status', { month: '2026-11' }, 'call-3'),
      );
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'completed',
      observations: expect.any(Array),
    });
    expect(deps.executeTool).toHaveBeenCalledTimes(2);
    expect(deps.finalize.mock.calls[0][0].observations).toHaveLength(2);
    expect(deps.selectTools).toHaveBeenCalledTimes(3);
  });
  it('discards intermediate prose and obtains a separate verified final', async () => {
    const { input, deps } = setup();
    input.allowedTools.push('calculate_budget_status');
    deps.selectTools.mockResolvedValueOnce(selection()).mockResolvedValueOnce({
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'Unverified intermediate prose',
      },
    });
    const result = await runAgentLoop(input, deps);
    expect(result.status).toBe('completed');
    expect(JSON.stringify(result)).not.toContain(
      'Unverified intermediate prose',
    );
    expect(
      deps.finalize.mock.calls[0][0].messages.some(
        (message) => message.content === 'Unverified intermediate prose',
      ),
    ).toBe(false);
  });
  it('does not finalize after an executor failure or retry the whole turn', async () => {
    const { input, deps } = setup();
    deps.executeTool.mockResolvedValue({
      status: 'error',
      code: 'DATA_ERROR',
      retryable: true,
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'DATA_ERROR',
    });
    expect(deps.executeTool).toHaveBeenCalledOnce();
    expect(deps.finalize).not.toHaveBeenCalled();
  });
  it('rejects truncated selection responses before executing tools', async () => {
    const { input, deps } = setup();
    deps.selectTools.mockResolvedValue({
      ...selection(),
      finishReason: 'length',
    });
    expect(await runAgentLoop(input, deps)).toMatchObject({
      status: 'fallback',
      reason: 'INVALID_SELECTION',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it('completes a permitted read with null state and only exposes verified tool observations', async () => {
    const { input, deps } = setup();
    const result = await runAgentLoop(input, deps);
    expect(result).toMatchObject({
      status: 'completed',
      observations: [
        {
          name: 'get_financial_snapshot',
          result: {
            status: 'ok',
            data: { indicators: { monthly_income_avg: 15_000_000 } },
          },
        },
      ],
    });
    expect(result).not.toHaveProperty('text');
    expect(deps.executeTool).toHaveBeenCalledOnce();
    expect(deps.selectTools).toHaveBeenCalledTimes(2);
    expect(deps.finalize).toHaveBeenCalledOnce();
    expect(deps.finalize.mock.calls[0][0].messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
    });
  });
});
