import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { config } from '../config';
import { quotaService } from '../services/quota-service';
import { rateLimitService } from '../services/rate-limit-service';
import { upstreamAiService } from '../services/upstream-ai';

const previous = { ...config };
const question = 'Tính kế hoạch tiết kiệm giúp tôi';
const turn = {
  version: 1,
  turnId: 'turn-1',
  userMessageId: 'message-1',
  sessionId: 'session-1',
  scenarioId: 'scenario-1',
  stateRevision: 1,
  language: 'vi',
  currency: 'VND',
};
const firstMessages = [{ role: 'user', content: question }];
const call = {
  id: 'call-1',
  type: 'function',
  function: { name: 'plan_savings_goal', arguments: '{}' },
};
const assistant = { role: 'assistant', content: null, tool_calls: [call] };
const toolResult = {
  status: 'ok',
  data: {
    monthlyAvailable: 5000000,
    requiredMonthlySaving: 4000000,
    remainingAfterSaving: 1000000,
    months: 6,
    goalAmount: 24000000,
    savingsForGoal: 0,
  },
  stateRevision: 1,
  calculationVersion: 1,
};
const resultMessage = (data: unknown = toolResult) => ({
  role: 'tool',
  tool_call_id: 'call-1',
  content: JSON.stringify(data),
});
const jsonReply = (message: unknown = assistant) =>
  Response.json({
    choices: [{ index: 0, finish_reason: 'tool_calls', message }],
  });
const sse =
  'data: {"choices":[{"delta":{"content":"Kết quả tư vấn."}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
let app: FastifyInstance;
const fetchMock = vi.fn<typeof fetch>();
function request(extra: Record<string, unknown> = {}, device = 'turn-device') {
  return app.inject({
    method: 'POST',
    url: '/v1/advice/step',
    headers: { 'x-device-id': device },
    payload: {
      turn,
      messages: firstMessages,
      allowedTools: ['plan_savings_goal'],
      allowTools: true,
      stream: false,
      ...extra,
    },
  });
}
async function begin() {
  const response = await request();
  expect(response.statusCode).toBe(200);
  expect(response.json().continuationToken).toEqual(expect.any(String));
  return response.json().continuationToken as string;
}
function next(token: string, extra: Record<string, unknown> = {}) {
  return request({
    continuationToken: token,
    messages: [...firstMessages, assistant, resultMessage()],
    allowTools: false,
    stream: true,
    ...extra,
  });
}
function context(sourceText = 'Thu nhập 15 triệu mỗi tháng.') {
  const unknown = { status: 'unknown' as const };
  return {
    sessionId: turn.sessionId,
    revision: turn.stateRevision,
    activeScenario: {
      id: turn.scenarioId,
      topic: 'savings_plan',
      mode: 'actual',
      currency: 'VND',
      cashFlowBasis: unknown,
      observationRange: unknown,
      income: unknown,
      expenseTotal: unknown,
      expenseIncludes: unknown,
      expenseItems: [],
      debtMonthlyPayments: [],
      debtOutstanding: unknown,
      goalTarget: unknown,
      monthlySavingsGoal: unknown,
      savingsForGoal: unknown,
      savingsMonths: unknown,
      purchasePrice: unknown,
      monthlyPayment: unknown,
      paymentMonths: unknown,
    },
    pendingFields: [],
    sourceMessages: [{ id: 'source-1', role: 'user', text: sourceText }],
  };
}
beforeEach(async () => {
  Object.assign(config, {
    nodeEnv: 'test',
    unlimitedAiTesting: false,
    dailyLimitPerDevice: 10,
    agentModelAllowlist: ['test-model'],
  });
  quotaService.resetForTesting();
  rateLimitService.resetForTesting();
  fetchMock.mockReset().mockImplementation(async () => jsonReply());
  upstreamAiService.setFetchForTesting(fetchMock);
  app = buildApp({ logger: false });
  await app.ready();
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  upstreamAiService.setFetchForTesting(fetch);
  Object.assign(config, previous);
  vi.restoreAllMocks();
});

describe('versioned turn admission', () => {
  it('accepts a stop selection after successful tools, then issues a distinct final SSE step', async () => {
    const firstToken = await begin();
    fetchMock.mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Đã đủ dữ kiện.' },
          },
        ],
      }),
    );
    const selected = await next(firstToken, {
      allowTools: true,
      stream: false,
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().choices[0].finish_reason).toBe('stop');
    expect(selected.json().continuationToken).not.toBe(firstToken);
    fetchMock.mockResolvedValue(
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    );
    expect((await next(selected.json().continuationToken)).statusCode).toBe(
      200,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(quotaService.checkQuota('turn-device').remaining).toBe(9);
  });
  it('does not carry unverified selection prose into the signed transcript', async () => {
    fetchMock.mockResolvedValue(
      jsonReply({ ...assistant, content: 'Tôi sẽ kiểm tra các dữ kiện.' }),
    );
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBeNull();
    fetchMock.mockResolvedValue(
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    );
    expect((await next(response.json().continuationToken)).statusCode).toBe(
      200,
    );
  });
  it('closes a valid failed tool result immediately without another model call', async () => {
    const token = await begin();
    const response = await next(token, {
      messages: [
        ...firstMessages,
        assistant,
        resultMessage({
          status: 'error',
          code: 'DATA_ERROR',
          retryable: false,
        }),
      ],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      status: 'error',
      code: 'DATA_ERROR',
    });
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await next(token)).statusCode).toBe(401);
  });
  it('cancels a signed pending batch without executing tools or calling a model', async () => {
    const token = await begin();
    const response = await request({
      continuationToken: token,
      messages: [...firstMessages, assistant],
      action: 'cancel',
      allowTools: false,
      stream: false,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'error',
      code: 'TURN_CANCELLED',
    });
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await next(token)).statusCode).toBe(401);
  });
  it('does not use cancellation to bypass a changed signed prefix', async () => {
    const token = await begin();
    const response = await request({
      continuationToken: token,
      messages: [...firstMessages, { ...assistant, content: 'altered' }],
      action: 'cancel',
      allowTools: false,
      stream: false,
    });
    expect(response.statusCode).toBe(401);
    expect(quotaService.checkQuota('turn-device').remaining).toBe(9);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('counts valid tool-error closures toward the two-failed-turn guard', async () => {
    for (let index = 1; index <= 2; index++) {
      const metadata = { ...turn, turnId: `failure-${index}` };
      const first = await request({ turn: metadata });
      expect(first.statusCode).toBe(200);
      const closed = await next(first.json().continuationToken, {
        turn: metadata,
        messages: [
          ...firstMessages,
          assistant,
          resultMessage({
            status: 'error',
            code: 'DATA_ERROR',
            retryable: false,
          }),
        ],
      });
      expect(closed.statusCode).toBe(422);
    }
    expect(
      (await request({ turn: { ...turn, turnId: 'failure-3' } })).statusCode,
    ).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
  });
  it('rejects a forged continuation before calling the model', async () => {
    expect((await next('forged-token')).statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    'Số điện thoại của tôi là 0912345678',
    'Cách nấu phở',
    'Nên chọn ngân hàng nào để vay?',
  ])('checks bounded source evidence independently: %s', async (text) => {
    expect(
      (await request({ turn: { ...turn, context: context(text) } })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('binds source context and metadata across endpoints without retaining its plaintext in the token', async () => {
    const metadata = { ...turn, context: context() };
    const response = await request({ turn: metadata });
    expect(response.statusCode).toBe(200);
    const token = response.json().continuationToken;
    expect(
      Buffer.from(token.split('.')[0], 'base64url').toString(),
    ).not.toContain('Thu nhập');
    const changed = {
      ...metadata,
      context: context('Thu nhập 12 triệu mỗi tháng.'),
    };
    expect((await next(token, { turn: changed })).statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('refunds final upstream HTTP errors without retrying', async () => {
    const token = await begin();
    fetchMock.mockResolvedValue(
      new Response('private failure', { status: 500 }),
    );
    const response = await next(token);
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('private failure');
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('refunds a stalled final stream when the model step deadline expires', async () => {
    const token = await begin();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"Dở dang"}}]}\n\n',
              ),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const pending = next(token);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(15001);
    const response = await pending;
    expect(response.body).not.toContain('Dở dang');
    expect(response.body).toContain('event: error');
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
  });
  it('keeps a verified sentence and refunds on a stalled final tail', async () => {
    const token = await begin();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"Hãy cân nhắc. Đang phân tích"}}]}\n\n',
              ),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const pending = next(token);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(15001);
    const result = await pending;
    expect(result.body).toContain('Hãy cân nhắc.');
    expect(result.body).not.toContain('Đang phân tích');
    expect(result.body).toContain('STREAM_TIMEOUT');
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('aborts a model call at 15 seconds even if fetch ignores its signal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = request();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15001);
    const response = await pending;
    expect(response.statusCode).toBe(502);
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('includes stalled response JSON reading in the 15-second call limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchMock.mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({}), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const pending = request();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15001);
    expect((await pending).statusCode).toBe(502);
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
  });
  it('does not extend the 30-second turn deadline with another token', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await app.close();
    app = buildApp({ logger: false });
    await app.ready();
    const token = await begin();
    now += 30001;
    expect((await next(token)).statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
  });
  it('rejects model changes between steps', async () => {
    config.agentModelAllowlist.push('other-test-model');
    const token = await begin();
    expect((await next(token, { model: 'other-test-model' })).statusCode).toBe(
      401,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('binds the granted tool list across steps', async () => {
    const token = await begin();
    expect(
      (await next(token, { allowedTools: ['get_financial_snapshot'] }))
        .statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('shares the guest sliding quota with the legacy plan endpoint', async () => {
    await begin();
    const legacy = await app.inject({
      method: 'POST',
      url: '/v1/advice/plan',
      headers: { 'x-device-id': 'turn-device' },
      payload: {
        requestId: '11111111-2222-4333-8444-000000000001',
        question: 'Quỹ dự phòng là gì?',
      },
    });
    expect(legacy.statusCode).toBe(429);
    expect(legacy.json().code).toBe('GUEST_RATE_LIMIT_EXCEEDED');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('shares the last daily slot across legacy and agent admissions without leaking a sliding hold', async () => {
    config.dailyLimitPerDevice = 1;
    quotaService.consumeQuota('turn-device');
    expect((await request()).statusCode).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    quotaService.resetForTesting();
    expect(
      (await request({ turn: { ...turn, turnId: 'turn-2' } })).statusCode,
    ).toBe(200);
  });
  it('refunds abandoned expired turns before admitting a new one', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await app.close();
    app = buildApp({ logger: false });
    await app.ready();
    await begin();
    now += 30001;
    const second = await request({ turn: { ...turn, turnId: 'turn-2' } });
    expect(second.statusCode).toBe(200);
    expect(quotaService.checkQuota('turn-device').remaining).toBe(9);
  });
  it('does not accept a token after restarting the server', async () => {
    const token = await begin();
    await app.close();
    app = buildApp({ logger: false });
    await app.ready();
    expect((await next(token)).statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('does not accept a valid token from another device', async () => {
    const token = await begin();
    const response = await request(
      {
        continuationToken: token,
        messages: [...firstMessages, assistant, resultMessage()],
        allowTools: false,
        stream: true,
      },
      'another-device',
    );
    expect(response.statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('stops after three selections but permits one final answer', async () => {
    const messages: Record<string, unknown>[] = [...firstMessages];
    let token = await begin();
    for (let index = 1; index <= 2; index++) {
      messages.push(
        { ...assistant, tool_calls: [{ ...call, id: `call-${index}` }] },
        { ...resultMessage(), tool_call_id: `call-${index}` },
      );
      fetchMock.mockResolvedValue(
        jsonReply({
          ...assistant,
          tool_calls: [{ ...call, id: `call-${index + 1}` }],
        }),
      );
      const response = await request({ continuationToken: token, messages });
      expect(response.statusCode).toBe(200);
      token = response.json().continuationToken;
    }
    messages.push(
      { ...assistant, tool_calls: [{ ...call, id: 'call-3' }] },
      { ...resultMessage(), tool_call_id: 'call-3' },
    );
    expect(
      (await request({ continuationToken: token, messages })).statusCode,
    ).toBe(401);
    fetchMock.mockResolvedValue(
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    );
    expect(
      (
        await request({
          continuationToken: token,
          messages,
          allowTools: false,
          stream: true,
        })
      ).statusCode,
    ).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(quotaService.checkQuota('turn-device').remaining).toBe(9);
  });
  it('denies a second consecutive invalid batch without issuing another token', async () => {
    const invalid = {
      ...assistant,
      tool_calls: [
        { ...call, function: { name: 'get_transactions', arguments: '{}' } },
      ],
    };
    fetchMock.mockResolvedValue(jsonReply(invalid));
    const token = await begin();
    fetchMock.mockResolvedValue(
      jsonReply({
        ...invalid,
        tool_calls: [{ ...invalid.tool_calls[0], id: 'call-2' }],
      }),
    );
    const response = await request({
      continuationToken: token,
      messages: [
        ...firstMessages,
        invalid,
        resultMessage({
          status: 'error',
          code: 'TOOL_NOT_ALLOWED',
          retryable: false,
        }),
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'error',
      code: 'TOOL_NOT_ALLOWED',
    });
    expect(response.json()).not.toHaveProperty('continuationToken');
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
  });
  it('rejects fabricated successful results for a denied batch', async () => {
    const invalid = {
      ...assistant,
      tool_calls: [
        { ...call, function: { name: 'get_transactions', arguments: '{}' } },
      ],
    };
    fetchMock.mockResolvedValue(jsonReply(invalid));
    const token = await begin();
    expect(
      (
        await next(token, {
          messages: [...firstMessages, invalid, resultMessage()],
        })
      ).statusCode,
    ).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each([
    'Số điện thoại tôi là 0912345678',
    'Cách nấu phở',
    'Nên chọn ngân hàng nào để vay?',
  ])('keeps safety checks ahead of turn admission: %s', async (content) => {
    expect(
      (await request({ messages: [{ role: 'user', content }] })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
  });
  it('rejects direct prose without tools instead of trusting an ungrounded answer', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Bịa kết quả' },
          },
        ],
      }),
    );
    expect((await request()).statusCode).toBe(502);
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('issues a continuation and charges once across selection and final SSE', async () => {
    const token = await begin();
    expect(quotaService.checkQuota('turn-device').remaining).toBe(9);
    fetchMock.mockResolvedValue(
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const final = await next(token);
    expect(final.statusCode).toBe(200);
    expect(final.body).toContain('event: done');
    expect(final.body).toContain('"verification":"passed"');
    expect(quotaService.checkQuota('turn-device').remaining).toBe(9);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('accepts a clean stop and EOF after the transport adds DONE', async () => {
    const token = await begin();
    const body =
      'data: {"choices":[{"index":0,"delta":{"content":"Cần tiết kiệm mỗi tháng 4.000.000 đ."},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
    fetchMock.mockResolvedValue(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const final = await next(token);
    expect(final.body).toContain('event: done');
    expect(final.body).toContain('"verification":"passed"');
    expect(quotaService.checkQuota('turn-device').remaining).toBe(9);
  });
  it('rejects calling budget remainder an account balance and refunds quota', async () => {
    const budgetCall = {
      id: 'budget-call',
      type: 'function',
      function: {
        name: 'calculate_budget_status',
        arguments: JSON.stringify({
          month: '2026-11',
          budget_id: 'budget-food',
        }),
      },
    };
    const budgetAssistant = {
      role: 'assistant',
      content: null,
      tool_calls: [budgetCall],
    };
    const budgetTurn = {
      ...turn,
      budgets: [{ id: 'budget-food', name: 'Ăn uống' }],
    };
    const budgetMessages = [
      {
        role: 'user',
        content:
          'Ngân sách Ăn uống tháng 11/2026 đã dùng bao nhiêu, còn bao nhiêu và có vượt không?',
      },
    ];
    fetchMock.mockResolvedValueOnce(jsonReply(budgetAssistant));
    const first = await request({
      turn: budgetTurn,
      messages: budgetMessages,
      allowedTools: ['calculate_budget_status'],
    });
    expect(first.statusCode).toBe(200);
    const token = first.json().continuationToken;
    const budgetResult = {
      status: 'ok',
      data: {
        budgets: [
          {
            id: 'budget-food',
            category_id: null,
            limit_amount: 1000000,
            spent_amount: 500000,
            remaining_amount: 500000,
            overspent_amount: 0,
          },
        ],
      },
      stateRevision: 1,
      calculationVersion: 1,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"content":"Số dư tài khoản còn 500.000 đ."}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const result = await request({
      turn: budgetTurn,
      messages: [
        ...budgetMessages,
        budgetAssistant,
        {
          role: 'tool',
          tool_call_id: 'budget-call',
          content: JSON.stringify(budgetResult),
        },
      ],
      allowedTools: ['calculate_budget_status'],
      continuationToken: token,
      allowTools: false,
      stream: true,
    });
    expect(result.body).toContain('VERIFICATION_FAILED');
    expect(result.body).not.toContain('500.000');
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['Cần tiết kiệm mỗi tháng 4.000.000 đ.', true],
    ['Cần tiết kiệm mỗi tháng 9.000.000 đ.', false],
    ['Cần tiết kiệm mỗi tháng 5.000.000 đ.', false],
    ['Thiếu 1.000.000 đ.', false],
  ])(
    'verifies the final answer against validated savings results: %s',
    async (answer, valid) => {
      const token = await begin();
      const chunk = (delta: object, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      fetchMock.mockResolvedValue(
        new Response(
          chunk({ content: answer }) + chunk({}, 'stop') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
      const final = await next(token);
      expect(final.body).toContain(
        valid ? 'event: done' : 'VERIFICATION_FAILED',
      );
      if (!valid) expect(final.body).not.toContain(answer);
      expect(quotaService.checkQuota('turn-device').remaining).toBe(
        valid ? 9 : 10,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
  it('does not expose tools outside the question-derived policy', async () => {
    await request({ allowedTools: ['plan_savings_goal', 'get_transactions'] });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).tools.map(
        (tool: { function: { name: string } }) => tool.function.name,
      ),
    ).toEqual(['plan_savings_goal']);
  });
  it('requires versioned mode in production while keeping dev harness independent', async () => {
    config.nodeEnv = 'production';
    expect((await request({ turn: undefined })).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    { messages: [...firstMessages, assistant, resultMessage()] },
    { allowTools: false, stream: true },
  ])(
    'rejects preloaded transcript or final-first admission %j',
    async (extra) => {
      expect((await request(extra)).statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
    },
  );
  it('rejects a duplicate first turn before a second model call', async () => {
    await begin();
    expect((await request()).statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each([
    { turn: { ...turn, stateRevision: 2 } },
    { turn: { ...turn, sessionId: 'other' } },
    { turn: { ...turn, scenarioId: 'other' } },
    {
      messages: [
        { role: 'user', content: 'Tính kế hoạch tiết kiệm khác giúp tôi' },
        assistant,
        resultMessage(),
      ],
    },
    {
      messages: [
        ...firstMessages,
        { ...assistant, content: 'changed' },
        resultMessage(),
      ],
    },
    { messages: [...firstMessages, assistant] },
    {
      messages: [...firstMessages, assistant, resultMessage(), resultMessage()],
    },
    {
      messages: [
        ...firstMessages,
        assistant,
        resultMessage(),
        { role: 'user', content: question },
      ],
    },
  ])(
    'rejects changed bindings/prefix or unmatched results %j',
    async (extra) => {
      const token = await begin();
      expect((await next(token, extra)).statusCode).toBeGreaterThanOrEqual(400);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
  it('allows only one concurrent consumer of the same token', async () => {
    const token = await begin();
    fetchMock.mockImplementation(
      async () =>
        new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const responses = await Promise.all([next(token), next(token)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 401,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...toolResult, stateRevision: 2 },
    { ...toolResult, data: {} },
    { ...toolResult, calculationVersion: 0 },
    { status: 'error', code: 'DATA_ERROR', retryable: false },
  ])('cannot finalize with invalid/unsuccessful results %j', async (result) => {
    const token = await begin();
    expect(
      (
        await next(token, {
          messages: [...firstMessages, assistant, resultMessage(result)],
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('closes clarification locally without final model call and keeps one business charge', async () => {
    const token = await begin();
    const response = await next(token, {
      messages: [
        ...firstMessages,
        assistant,
        resultMessage({
          status: 'needs_clarification',
          fields: ['savingsForGoal'],
        }),
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'needs_clarification',
      fields: ['savingsForGoal'],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(quotaService.checkQuota('turn-device').remaining).toBe(9);
  });
  it('refunds upstream failure and blocks after two failed turns without automatic retries', async () => {
    fetchMock.mockRejectedValue(new Error('private provider failure'));
    expect((await request()).statusCode).toBe(502);
    expect(
      (await request({ turn: { ...turn, turnId: 'turn-2' } })).statusCode,
    ).toBe(502);
    const third = await request({ turn: { ...turn, turnId: 'turn-3' } });
    expect(third.statusCode).toBe(429);
    expect(third.body).not.toContain('private provider');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
  });
  it('refunds an incomplete final stream instead of charging a partial answer', async () => {
    const token = await begin();
    fetchMock.mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"Dở dang"}}]}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const response = await next(token);
    expect(response.body).not.toContain('Dở dang');
    expect(response.body).toContain('event: error');
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
  });
  it('denies the entire outgoing batch and returns errors for every id', async () => {
    fetchMock.mockResolvedValue(
      jsonReply({
        ...assistant,
        tool_calls: [
          call,
          {
            ...call,
            id: 'call-2',
            function: { name: 'get_transactions', arguments: '{}' },
          },
        ],
      }),
    );
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json().toolErrors).toEqual([
      {
        tool_call_id: 'call-1',
        result: { status: 'error', code: 'TOOL_NOT_ALLOWED', retryable: false },
      },
      {
        tool_call_id: 'call-2',
        result: { status: 'error', code: 'TOOL_NOT_ALLOWED', retryable: false },
      },
    ]);
    expect(response.json().continuationToken).toEqual(expect.any(String));
  });
  it('denies every call if one savings call invents financial parameters', async () => {
    fetchMock.mockResolvedValue(
      jsonReply({
        ...assistant,
        tool_calls: [
          call,
          {
            ...call,
            id: 'call-2',
            function: {
              name: 'plan_savings_goal',
              arguments: '{"income":999}',
            },
          },
        ],
      }),
    );
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json().toolErrors).toHaveLength(2);
    expect(
      response
        .json()
        .toolErrors.every(
          (error: { result: { code: string } }) =>
            error.result.code === 'TOOL_NOT_ALLOWED',
        ),
    ).toBe(true);
  });
  it('rejects duplicate outgoing call ids rather than issuing an unusable continuation', async () => {
    fetchMock.mockResolvedValue(
      jsonReply({ ...assistant, tool_calls: [call, call] }),
    );
    const response = await request();
    expect(response.statusCode).toBe(502);
    expect(response.json()).not.toHaveProperty('continuationToken');
    expect(quotaService.checkQuota('turn-device').remaining).toBe(10);
  });
  it('allows default category labels such as Lãi & đầu tư without triggering ADVICE_RESTRICTED', async () => {
    fetchMock.mockResolvedValue(jsonReply());
    const response = await request({
      turn: {
        ...turn,
        categories: [
          { id: 'cat-food', name: 'Ăn uống' },
          { id: 'cat-invest', name: 'Lãi & đầu tư' },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().continuationToken).toEqual(expect.any(String));
  });
  it('still rejects category or budget labels that contain PII', async () => {
    const response = await request({
      turn: {
        ...turn,
        categories: [{ id: 'cat-pii', name: 'Liên hệ 0912345678' }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('PII_DETECTED');
  });
});
