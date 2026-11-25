import { describe, expect, it, vi } from 'vitest';
import {
  AdviceValidationContextSchema,
  type AdviceValidationContext,
} from '@pfm/contracts';
import { classifyAdviceScope } from '@pfm/domain';
import { buildApp } from '../app';
import { upstreamAiService } from './upstream-ai';
import { checkQuestionWithState } from './check-question-with-state';
import { scanPii } from './pii-scanner';

const options = { language: 'vi' as const };
function makeContext(topic = 'savings_plan'): AdviceValidationContext {
  const unknown = { status: 'unknown' as const };
  return {
    sessionId: 'session-1',
    revision: 1,
    activeScenario: {
      id: 'scenario-1',
      topic,
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
    sourceMessages: [],
  };
}
const check = (
  question: string,
  context: AdviceValidationContext | null = null,
) => checkQuestionWithState(question, context, options);

describe('hardened classifier admission with and without state', () => {
  it.each([null, makeContext()])(
    'accepts snapshots, lists and complete declarations with context %s',
    async (context) => {
      for (const [question, topic] of [
        [
          'Cho tôi xem thu nhập và chi tiêu trung bình mỗi tháng trong 6 tháng hoàn chỉnh gần nhất.',
          'spending_overview',
        ],
        [
          'Liệt kê 3 giao dịch chi Ăn uống gần nhất từ ngày 01/11/2026 đến hết ngày 16/11/2026.',
          'spending_overview',
        ],
        [
          'Thu nhập 15tr, chi 10tr, mục tiêu 24tr trong 6 tháng',
          'savings_plan',
        ],
      ]) {
        expect(await check(question, context)).toEqual({
          status: 'allowed',
          topic,
          reason: 'direct_match',
        });
      }
      expect(await check('Cho tôi vay tiền mặt nhanh.', context)).toEqual({
        status: 'rejected',
        reason: 'RESTRICTED',
      });
    },
  );
});

describe('A: direct matches', () => {
  it.each([null, makeContext()])(
    'allows a supported savings request with context %#',
    async (context) => {
      expect(await check('Tính kế hoạch tiết kiệm giúp tôi', context)).toEqual({
        status: 'allowed',
        topic: 'savings_plan',
        reason: 'direct_match',
      });
    },
  );
});

describe('B: independent safety checks', () => {
  it.each([null, makeContext()])(
    'rejects PII with context %#',
    async (context) => {
      expect(await check('Số điện thoại tôi là 0912345678', context)).toEqual({
        status: 'rejected',
        reason: 'PII',
      });
    },
  );
  it.each([
    ['Cách nấu phở', 'OUT_OF_SCOPE'],
    ['Nên chọn ngân hàng nào để vay?', 'RESTRICTED'],
  ])('rejects %s despite a savings scenario', async (question, reason) => {
    expect(await check(question, makeContext())).toEqual({
      status: 'rejected',
      reason,
    });
  });
});

describe('C: ambiguous without context', () => {
  it.each(['Thế còn tháng này?', 'Sửa lại'])(
    'requires context for %s',
    async (question) => {
      expect(await check(question)).toEqual({
        status: 'ambiguous',
        reason: 'INSUFFICIENT_CONTEXT',
      });
    },
  );
});

describe('D: narrow topic inheritance', () => {
  it('supports an English follow-up without changing the topic', async () => {
    expect(
      await checkQuestionWithState('What if 12,000,000?', makeContext(), {
        language: 'en',
      }),
    ).toEqual({
      status: 'allowed',
      topic: 'savings_plan',
      reason: 'context_inherited',
    });
  });
  it.each([
    ['Thế còn tháng này?', 'savings_plan'],
    ['Còn nếu 12 triệu thì sao?', 'savings_plan'],
    ['Thế còn tháng này?', 'spending_overview'],
  ])('inherits %s within %s', async (question, topic) => {
    expect(await check(question, makeContext(topic))).toEqual({
      status: 'allowed',
      topic,
      reason: 'context_inherited',
    });
  });
  it('rejects a null topic as invalid context', async () => {
    const context = {
      ...makeContext(),
      activeScenario: { ...makeContext().activeScenario, topic: null },
    };
    expect(
      await checkQuestionWithState(
        'Thế còn tháng này?',
        context as unknown as AdviceValidationContext,
        options,
      ),
    ).toEqual({ status: 'rejected', reason: 'INVALID_CONTEXT' });
  });
  it.each(['Có', 'Sửa lại', 'xyz'])(
    'does not inherit arbitrary ambiguous text: %s',
    async (question) => {
      expect(await check(question, makeContext())).toEqual({
        status: 'ambiguous',
        reason: 'AMBIGUOUS_CORRECTION',
      });
    },
  );
  it('does not inherit an unknown topic name', async () => {
    expect(await check('Thế còn tháng này?', makeContext('invented'))).toEqual({
      status: 'ambiguous',
      reason: 'AMBIGUOUS_CORRECTION',
    });
  });
  it('preserves multiple independent topics', async () => {
    expect(
      await check(
        'Vừa muốn vay mua nhà trả góp vừa muốn tính kế hoạch tiết kiệm nghỉ hưu sớm',
        makeContext(),
      ),
    ).toEqual({ status: 'ambiguous', reason: 'MULTIPLE_TOPICS' });
  });
});

describe('E: pending answers', () => {
  it.each([
    ['6 tháng', 'savingsMonths'],
    ['12 triệu', 'income'],
    ['8 triệu', 'expenseTotal'],
    ['0 đồng', 'savingsForGoal'],
  ])('accepts %s for %s', async (question, field) => {
    const context = makeContext();
    context.pendingFields = [field];
    expect(await check(question, context)).toEqual({
      status: 'allowed',
      topic: 'savings_plan',
      reason: 'pending_answer',
    });
  });
  it.each([
    ['Có', ['savingsMonths']],
    ['6 tháng', []],
    ['-6 tháng', ['savingsMonths']],
    ['2 lít', ['income']],
  ])(
    'does not accept an unverified pending answer %#',
    async (question, pendingFields) => {
      const context = makeContext();
      context.pendingFields = pendingFields;
      expect(await check(question, context)).toEqual({
        status: 'ambiguous',
        reason: 'AMBIGUOUS_CORRECTION',
      });
    },
  );
});

describe('F: invalid context', () => {
  it('accepts exactly 8 source messages, 500 characters and 32 pending fields', async () => {
    const context = makeContext();
    context.pendingFields = Array(32).fill('income');
    context.sourceMessages = Array.from({ length: 8 }, (_, index) => ({
      id: `m${index}`,
      role: 'user',
      text: 'a'.repeat(500),
    }));
    expect(AdviceValidationContextSchema.safeParse(context).success).toBe(true);
    expect(await check('12 triệu', context)).toEqual({
      status: 'allowed',
      topic: 'savings_plan',
      reason: 'pending_answer',
    });
  });
  it.each([
    (context: AdviceValidationContext) => {
      const malformed: Partial<AdviceValidationContext> = { ...context };
      delete malformed.sessionId;
      return malformed;
    },
    (context: AdviceValidationContext) => ({ ...context, revision: 0 }),
    (context: AdviceValidationContext) => ({
      ...context,
      pendingFields: Array(33).fill('income'),
    }),
    (context: AdviceValidationContext) => ({
      ...context,
      sourceMessages: Array(9).fill({
        id: 'm',
        role: 'user',
        text: '12 triệu',
      }),
    }),
    (context: AdviceValidationContext) => ({
      ...context,
      sourceMessages: [{ id: 'm', role: 'user', text: 'a'.repeat(501) }],
    }),
  ])('rejects malformed context without throwing %#', async (malform) => {
    expect(
      await checkQuestionWithState(
        'Tính kế hoạch tiết kiệm',
        malform(makeContext()) as AdviceValidationContext,
        options,
      ),
    ).toEqual({ status: 'rejected', reason: 'INVALID_CONTEXT' });
  });
});

describe('G: invalid question', () => {
  it('accepts a supported question of exactly 500 characters', async () => {
    expect(await check('Tính kế hoạch tiết kiệm'.padEnd(500, ' '))).toEqual({
      status: 'allowed',
      topic: 'savings_plan',
      reason: 'direct_match',
    });
  });
  it.each(['', '   ', 'a'.repeat(501)])(
    'rejects invalid question %#',
    async (question) => {
      expect(await check(question)).toEqual({
        status: 'rejected',
        reason: 'INVALID_CONTEXT',
      });
    },
  );
});

describe('H: legacy safety equivalence without history', () => {
  it.each([
    ['Tính kế hoạch tiết kiệm giúp tôi', false],
    ['Số điện thoại tôi là 0912345678', true],
  ] as const)(
    'agrees with the existing /plan safety check: %s',
    async (question, hasPii) => {
      const upstream = vi
        .spyOn(upstreamAiService, 'callPrompt')
        .mockRejectedValue(new Error('UPSTREAM_DISABLED_FOR_TEST'));
      const app = buildApp({ logger: false });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/advice/plan',
          headers: { 'x-device-id': 'state-validation-test' },
          payload: {
            requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d470',
            question,
            history: [],
            language: 'vi',
            currency: 'VND',
          },
        });
        if (hasPii) {
          expect(response.statusCode).toBe(400);
          expect(response.json()).toMatchObject({ code: 'PII_DETECTED' });
          expect(upstream).not.toHaveBeenCalled();
          expect(await check(question)).toEqual({
            status: 'rejected',
            reason: 'PII',
          });
        } else {
          // Reaching the mocked model proves the private legacy check accepted the question.
          expect(upstream).toHaveBeenCalledOnce();
          expect(await check(question)).toEqual({
            status: 'allowed',
            topic: 'savings_plan',
            reason: 'direct_match',
          });
        }
      } finally {
        await app.close();
        upstream.mockRestore();
      }
    },
  );
  it('agrees with the unchanged legacy scope classifier on a clear question', async () => {
    const question = 'Tính kế hoạch tiết kiệm giúp tôi';
    const legacyScope = classifyAdviceScope(question);
    expect(legacyScope.status).toBe('allowed');
    expect(await check(question)).toMatchObject({
      status: 'allowed',
      topic: legacyScope.topic,
    });
  });
  it('rejects the same PII as the legacy scanner', async () => {
    const question = 'Email của tôi minh@example.com';
    expect(scanPii(question).hasPii).toBe(true);
    expect(await check(question)).toEqual({
      status: 'rejected',
      reason: 'PII',
    });
  });
});

describe('I: server safety cannot be bypassed by topic or pending fields', () => {
  it('does not mutate context while resolving a pending answer', async () => {
    const context = makeContext();
    context.pendingFields = ['income'];
    const before = structuredClone(context);
    await check('12 triệu', context);
    expect(context).toEqual(before);
  });
  it.each([
    ['Thế còn 0912345678?', 'PII'],
    ['Cách nấu phở', 'OUT_OF_SCOPE'],
    ['Nên chọn ngân hàng nào để vay?', 'RESTRICTED'],
  ])('rejects %s before using pending income', async (question, reason) => {
    const context = makeContext();
    context.pendingFields = ['income'];
    expect(await check(question, context)).toEqual({
      status: 'rejected',
      reason,
    });
  });
});
