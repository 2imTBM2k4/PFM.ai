import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  AdviceCompleteRequestSchema,
  AdvicePlanRequestSchema,
  type AdviceValidationContext,
} from '@pfm/contracts';
import { classifyAdviceScope } from '@pfm/domain';
import { buildApp } from '../src/app';
import { upstreamAiService } from '../src/services/upstream-ai';
import { quotaService } from '../src/services/quota-service';
import { rateLimitService } from '../src/services/rate-limit-service';

let app: FastifyInstance;
const requestId = 'c47ac10b-58cc-4372-a567-0e02b2c3d470';
const headers = { 'x-device-id': 'context-test-device' };
const question = 'Tính kế hoạch tiết kiệm giúp tôi';
const selection = { metrics: [], scenario: { conversationFacts: [] } };
function makeContext(): AdviceValidationContext {
  const unknown = { status: 'unknown' as const };
  const known = <T>(value: T, factId: string, messageId: string) => ({
    status: 'known' as const,
    value,
    factIds: [factId],
    sourceMessageIds: [messageId],
    source: 'user_statement' as const,
  });
  return {
    sessionId: 'session-1',
    revision: 1,
    activeScenario: {
      id: 'scenario-1',
      topic: 'savings_plan',
      mode: 'actual',
      currency: 'VND',
      cashFlowBasis: known('monthly' as const, 'income', 'm1'),
      observationRange: unknown,
      income: known(15_000_000, 'income', 'm1'),
      expenseTotal: known(10_000_000, 'expense', 'm2'),
      expenseIncludes: known(['debt'] as 'debt'[], 'expense', 'm2'),
      expenseItems: [],
      debtMonthlyPayments: [],
      debtOutstanding: unknown,
      goalTarget: known(24_000_000, 'goal', 'm3'),
      monthlySavingsGoal: unknown,
      savingsForGoal: known(0, 'saved', 'm4'),
      savingsMonths: known(6, 'goal', 'm3'),
      purchasePrice: unknown,
      monthlyPayment: unknown,
      paymentMonths: unknown,
    },
    pendingFields: [],
    sourceMessages: [
      'Thu nhập 15 triệu mỗi tháng.',
      'Tổng chi 10 triệu mỗi tháng đã gồm trả nợ.',
      'Mục tiêu tiết kiệm 24 triệu trong 6 tháng.',
      'Tiền dành riêng là 0 đồng.',
    ].map((text, index) => ({ id: `m${index + 1}`, text, role: 'user' })),
  };
}
function plan(body: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/advice/plan',
    headers,
    payload: {
      requestId,
      question,
      history: [],
      language: 'vi',
      currency: 'VND',
      ...body,
    },
  });
}
function complete(body: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/advice/complete',
    headers,
    payload: {
      requestId,
      question,
      history: [],
      language: 'vi',
      currency: 'VND',
      planToken: 'invalid-unless-supplied',
      results: {},
      ...body,
    },
  });
}
beforeEach(async () => {
  quotaService.resetForTesting();
  rateLimitService.resetForTesting();
  vi.spyOn(upstreamAiService, 'callPrompt').mockResolvedValue({
    answer: JSON.stringify(selection),
    model: 'test',
  });
  app = buildApp({ logger: false });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('resolved classifier gaps from 2.3a', () => {
  it.each([
    [
      'Thu nhập 15tr, chi 10tr, mục tiêu 24tr trong 6 tháng',
      'allowed',
      'savings_plan',
      'SUPPORTED_SAVINGS',
    ],
    [
      'Cho tôi vay tiền mặt nhanh',
      'restricted',
      null,
      'SPECIFIC_PRODUCT_RECOMMENDATION',
    ],
  ] as const)('classifies %s explicitly', (input, status, topic, reason) => {
    expect(classifyAdviceScope(input)).toEqual({
      status,
      topic,
      reason,
    });
  });
});

describe('legacy omission and explicit null', () => {
  it.each([undefined, null])(
    'accepts legacy context %s in both request schemas',
    (context) => {
      const input = {
        requestId,
        question,
        ...(context === undefined ? {} : { context }),
      };
      expect(AdvicePlanRequestSchema.safeParse(input).success).toBe(true);
      expect(
        AdviceCompleteRequestSchema.safeParse({
          ...input,
          planToken: 'token',
          results: {},
        }).success,
      ).toBe(true);
    },
  );
  it.each([undefined, null])(
    'keeps both legacy endpoints working for context %s',
    async (context) => {
      const extra = context === undefined ? {} : { context };
      const response = await plan(extra);
      expect(response.statusCode).toBe(200);
      expect(response.json().selection).toEqual(selection);
      expect(
        vi.mocked(upstreamAiService.callPrompt).mock.calls[0][0],
      ).not.toContain('Validated advice topic:');
      vi.mocked(upstreamAiService.callPrompt).mockResolvedValue({
        answer: 'Kết quả dựa trên dữ liệu đã kiểm tra.',
        model: 'test',
      });
      const answer = await complete({
        ...extra,
        planToken: response.json().planToken,
      });
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toMatchObject({
        success: true,
        answer: 'Kết quả dựa trên dữ liệu đã kiểm tra.',
      });
      expect(answer.json()).not.toHaveProperty('topic');
    },
  );
});

describe.each(['plan', 'complete'] as const)(
  'state safety in /%s',
  (endpoint) => {
    const send = (input: Record<string, unknown>) =>
      endpoint === 'plan' ? plan(input) : complete(input);
    it.each([
      ['Số điện thoại tôi là 0912345678', 400, 'PII_DETECTED'],
      ['Cách nấu phở', 422, 'ADVICE_OUT_OF_SCOPE'],
      ['Nên chọn ngân hàng nào để vay?', 422, 'ADVICE_RESTRICTED'],
      ['Có', 422, 'ADVICE_AMBIGUOUS'],
    ])(
      'rejects the current question before any AI call: %s',
      async (question, status, code) => {
        const response = await send({ question, context: makeContext() });
        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject({ success: false, code });
        expect(upstreamAiService.callPrompt).not.toHaveBeenCalled();
      },
    );
    it('rejects malformed context with INVALID_CONTEXT', async () => {
      const response = await send({ context: { revision: 1 } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        success: false,
        code: 'INVALID_CONTEXT',
      });
      expect(upstreamAiService.callPrompt).not.toHaveBeenCalled();
    });
    it.each(['history', 'sourceMessages'] as const)(
      'checks PII in %s',
      async (location) => {
        const context = makeContext();
        const unsafe = {
          id: 'private',
          role: 'user' as const,
          text: 'Email: minh@example.com',
        };
        const response = await send({
          context:
            location === 'sourceMessages'
              ? { ...context, sourceMessages: [unsafe] }
              : context,
          ...(location === 'history' ? { history: [unsafe] } : {}),
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('PII_DETECTED');
        expect(upstreamAiService.callPrompt).not.toHaveBeenCalled();
      },
    );
    it.each(['history', 'sourceMessages'] as const)(
      'checks scope in %s',
      async (location) => {
        const context = makeContext();
        const unsafe = {
          id: 'unrelated',
          role: 'user' as const,
          text: 'Cách nấu phở',
        };
        const response = await send({
          context:
            location === 'sourceMessages'
              ? { ...context, sourceMessages: [unsafe] }
              : context,
          ...(location === 'history' ? { history: [unsafe] } : {}),
        });
        expect(response.statusCode).toBe(422);
        expect(response.json().code).toBe('ADVICE_OUT_OF_SCOPE');
        expect(upstreamAiService.callPrompt).not.toHaveBeenCalled();
      },
    );
    it('keeps restricted evidence blocked', async () => {
      const context = makeContext();
      context.sourceMessages = [
        {
          id: 'restricted',
          role: 'user',
          text: 'Nên chọn ngân hàng nào để vay?',
        },
      ];
      const response = await send({ context });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('ADVICE_RESTRICTED');
      expect(upstreamAiService.callPrompt).not.toHaveBeenCalled();
    });
  },
);

describe('state topic and cross-endpoint consistency', () => {
  it('uses the current checked topic instead of trusting a different client topic', async () => {
    const context = makeContext();
    context.activeScenario.topic = 'budget_review';
    expect((await plan({ context })).statusCode).toBe(200);
    const systemPrompt = vi.mocked(upstreamAiService.callPrompt).mock
      .calls[0][0];
    expect(systemPrompt).toContain('Validated advice topic: savings_plan.');
    expect(systemPrompt).not.toContain(
      'Validated advice topic: budget_review.',
    );
  });
  it.each([question, 'Thế còn tháng này?', '6 tháng'])(
    'uses the checked topic in both prompts for %s',
    async (input) => {
      const context = makeContext();
      context.pendingFields = ['savingsMonths'];
      const response = await plan({ question: input, context });
      expect(response.statusCode).toBe(200);
      expect(
        vi.mocked(upstreamAiService.callPrompt).mock.calls[0][0],
      ).toContain('Validated advice topic: savings_plan.');
      vi.mocked(upstreamAiService.callPrompt).mockResolvedValue({
        answer: 'Kết quả dựa trên dữ liệu đã kiểm tra.',
        model: 'test',
      });
      const answer = await complete({
        question: input,
        context,
        planToken: response.json().planToken,
      });
      expect(answer.statusCode).toBe(200);
      expect(
        vi.mocked(upstreamAiService.callPrompt).mock.calls.at(-1)?.[0],
      ).toContain('Validated advice topic: savings_plan.');
      expect(response.json()).not.toHaveProperty('topic');
    },
  );
});

const cases = [
  [
    'S1',
    'Cho tôi xem thu nhập và chi tiêu trung bình mỗi tháng trong 6 tháng hoàn chỉnh gần nhất.',
  ],
  [
    'S2',
    'Ngân sách Ăn uống tháng 11/2026 đã dùng bao nhiêu, còn bao nhiêu và có vượt không?',
  ],
  [
    'S3',
    'Thu nhập của tôi 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn đủ 24 triệu trong 6 tháng, tiền dành riêng hiện là 0 đồng. Mỗi tháng cần để dành bao nhiêu và còn bao nhiêu sau đó?',
  ],
  [
    'S4',
    'Cho tôi xem 3 khoản chi ăn uống gần nhất từ 01/11/2026 đến 16/11/2026.',
  ],
  [
    'D1',
    'Cho tôi xem thu nhập, chi tiêu trung bình trong 6 tháng hoàn chỉnh gần nhất, đồng thời kiểm tra ngân sách Ăn uống tháng 11/2026. Trình bày riêng hai phần.',
  ],
  [
    'D2',
    'Kiểm tra ngân sách Ăn uống tháng 11/2026 và cho tôi xem 3 khoản chi ăn uống gần nhất từ 01/11/2026 đến 16/11/2026 để biết các khoản nào liên quan.',
  ],
  [
    'D3',
    'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ, mục tiêu 24 triệu trong 6 tháng và tôi chưa dành riêng đồng nào. Tính mức tiết kiệm cần thiết; đồng thời cho biết riêng số dư khả dụng hiện có trong ứng dụng.',
  ],
  [
    'C1',
    'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn đủ 24 triệu trong 6 tháng; mỗi tháng phải dành bao nhiêu?',
  ],
  [
    'C2',
    'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn tiết kiệm đủ 24 triệu, hiện tiền dành riêng là 0 đồng. Mỗi tháng cần dành bao nhiêu?',
  ],
] as const;
describe('semantic /plan equivalence for the existing nine questions', () => {
  it.each(cases)(
    '%s keeps the same admission decision and checked topic',
    async (id, input) => {
      const a = await plan({ question: input });
      const context = makeContext();
      const scope = classifyAdviceScope(input);
      const expectedTopics: Record<string, string | null> = {
        S1: 'spending_overview',
        S2: 'budget_review',
        S3: 'savings_plan',
        S4: 'spending_overview',
        D1: 'budget_review',
        D2: 'budget_review',
        D3: 'savings_plan',
        C1: 'spending_overview',
        C2: 'savings_plan',
      };
      expect(scope.topic).toBe(expectedTopics[id]);
      if (['S1', 'S2', 'S4', 'D1', 'D2'].includes(id)) {
        for (const [field, value] of Object.entries(context.activeScenario)) {
          if (typeof value === 'object' && value !== null && 'status' in value)
            Object.assign(context.activeScenario, {
              [field]: { status: 'unknown' },
            });
        }
        context.sourceMessages = [];
        context.activeScenario.topic = scope.topic ?? 'general';
      } else {
        context.sourceMessages = [{ id: 'current', role: 'user', text: input }];
        for (const value of Object.values(context.activeScenario)) {
          if (
            typeof value === 'object' &&
            value !== null &&
            'status' in value &&
            value.status === 'known'
          )
            value.sourceMessageIds = ['current'];
        }
      }
      if (id === 'C1') {
        context.activeScenario.savingsForGoal = { status: 'unknown' };
        context.pendingFields = ['savingsForGoal'];
      }
      if (id === 'C2') {
        context.activeScenario.savingsMonths = { status: 'unknown' };
        context.pendingFields = ['savingsMonths'];
      }
      const b = await plan({ question: input, context });
      if (id === 'S1' || id === 'S4') {
        expect(a.statusCode).toBe(200);
        expect(b.statusCode).toBe(200);
      }
      expect(b.statusCode).toBe(a.statusCode);
      if (a.statusCode === 200) {
        expect(b.json().selection).toEqual(a.json().selection);
        expect(
          vi.mocked(upstreamAiService.callPrompt).mock.calls.at(-1)?.[0],
        ).toContain(`Validated advice topic: ${scope.topic}.`);
      } else {
        expect(b.json().code).toBe(a.json().code);
      }
    },
  );
});
