import { afterEach, expect, it, vi } from 'vitest';
import { AdvicePlanRequestSchema } from '@pfm/contracts';
import {
  buildAdviceContext,
  adviceContextToHistory,
  createInitialAdviceState,
} from './advice-context';
import { validateConversationStateFacts } from './advice-state-validation';
import { adviceStateFixture } from './advice-context.fixtures';
import { buildAdviceHistory, RemoteAIService } from './ai-service';

vi.mock('expo-crypto', () => ({
  randomUUID: () => '11111111-2222-4333-8444-555555555555',
}));
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('./ai-auth', () => ({
  readAIAuth: async () => ({ mode: 'guest', deviceId: 'test-device' }),
  aiAuthHeaders: () => ({}),
}));
vi.mock('@/state/preferences', () => ({
  usePreferences: {
    getState: () => ({ language: 'vi', currency: 'VND', exchangeRate: null }),
  },
  formatCurrencyAmount: (value: number) => String(value),
}));
vi.mock('@/data/connection', () => ({
  withDatabase: async (task: (db: unknown) => Promise<unknown>) => task({}),
}));
vi.mock('@/data/analysis', () => ({ readAnalysisSummary: async () => null }));
vi.mock('@/data/advice-groups', () => ({ readAdviceGroups: async () => [] }));
vi.mock('@/data/advice-insights', () => ({
  readCashFlow: async () => ({
    totalIncome: 15_000_000,
    totalExpense: 10_000_000,
    net: 5_000_000,
    incomeCount: 1,
    expenseCount: 1,
    hasData: true,
  }),
  readExpenseByCategory: async () => ({
    totalExpense: 3_500_000,
    topCategories: [],
    otherAmount: 3_500_000,
    uncategorizedAmount: 0,
    uncategorizedCount: 0,
    transactionCount: 3,
    hasData: true,
  }),
}));

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
  ['FOLLOWUP', 'Thế mức dành mỗi tháng giúp tôi?'],
] as const;
const options = { language: 'vi' as const, currency: 'VND' as const };
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

it.each(cases)(
  '%s preserves routing, plan calls and user-visible clarification across both representations',
  async (id, question) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T08:00:00.000Z'));
    const fixture = adviceStateFixture();
    const usesFacts = ['S3', 'D3', 'C1', 'C2', 'FOLLOWUP'].includes(id);
    if (id === 'C1') {
      // Match the legacy classifier's primary topic for this self-contained question.
      fixture.state.activeScenario.topic = 'spending_overview';
      fixture.state.activeScenario.savingsForGoal = { status: 'unknown' };
      fixture.state.pendingFields = ['savingsForGoal'];
    }
    if (id === 'C2') {
      fixture.state.activeScenario.savingsMonths = { status: 'unknown' };
      fixture.state.pendingFields = ['savingsMonths'];
    }
    const state = usesFacts
      ? fixture.state
      : createInitialAdviceState('session-1', question, options);
    const payload = buildAdviceContext(state, question, {
      ...options,
      sourceMessages: fixture.sourceMessages,
    });
    expect(
      validateConversationStateFacts(
        payload.activeFacts,
        fixture.sourceMessages,
        { sessionId: state.sessionId, scenario: payload.scenario },
      ),
    ).toEqual({ valid: true });
    const replies =
      id === 'FOLLOWUP'
        ? Object.fromEntries(
            fixture.sourceMessages.map(({ id }) => [
              id,
              {
                id: `ai-${id}`,
                userMessageId: id,
                replyText: 'Bạn muốn tính mức để dành mỗi tháng?',
                createdAt: '2026-11-15T00:00:00.000Z',
              },
            ]),
          )
        : {};
    const legacy = buildAdviceHistory(
      question,
      fixture.sourceMessages.map(({ id, text }) => ({ id, text })).reverse(),
      replies,
    );
    const stateHistory = adviceContextToHistory(payload);
    const context = {
      balance: 12_000_000,
      monthlyIncome: 15_000_000,
      monthlyExpense: 10_000_000,
      monthlyNet: 5_000_000,
      topCategories: [],
      budgetsCount: 1,
      goalsCount: 1,
    };

    async function run(history: typeof legacy) {
      const requests: { path: string; body: Record<string, unknown> }[] = [];
      global.fetch = vi.fn(async (url, init) => {
        const path = String(url);
        const body = JSON.parse(String(init?.body));
        requests.push({ path, body });
        if (path.endsWith('/plan')) {
          expect(AdvicePlanRequestSchema.safeParse(body).success).toBe(true);
          return new Response(
            JSON.stringify({
              success: true,
              requestId: '11111111-2222-4333-8444-555555555555',
              planToken: 'test-plan',
              selection: usesFacts
                ? {
                    metrics: ['savings_required_monthly'],
                    scenario: {
                      savingsTarget: 24_000_000,
                      ...(id !== 'C1' ? { savingsForGoal: 0 } : {}),
                      ...(id !== 'C2' ? { savingsMonths: 6 } : {}),
                      conversationFacts: fixture.state.facts
                        .slice(0, 3)
                        .map((fact) => ({
                          ...fact,
                          source_message_id:
                            id === 'FOLLOWUP'
                              ? fact.source_message_id
                              : 'current',
                        })),
                    },
                  }
                : { metrics: ['monthly_income_avg'], scenario: {} },
            }),
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            answer: 'Kết quả dựa trên dữ liệu đã kiểm tra.',
          }),
        );
      });
      const result = await new RemoteAIService({
        baseUrl: 'https://proxy.example',
      }).sendMessage(question, context, 'current', history);
      return {
        result,
        plans: requests.filter(({ path }) => path.endsWith('/plan')),
        completions: requests.filter(({ path }) => path.endsWith('/complete')),
      };
    }
    const a = await run(legacy);
    const b = await run(stateHistory);
    expect(b.plans.length).toBe(a.plans.length);
    expect(b.completions.length).toBe(a.completions.length);
    expect(b.result.replyText).toBe(a.result.replyText);
    if (id === 'C1' || id === 'C2') {
      expect(a.plans, a.result.replyText).toHaveLength(1);
      expect(a.completions).toHaveLength(0);
      expect(a.result.replyText).toContain(
        id === 'C1' ? 'dành riêng' : 'bao nhiêu tháng',
      );
      expect(payload.pendingFields).toEqual([
        id === 'C1' ? 'savingsForGoal' : 'savingsMonths',
      ]);
    } else if (usesFacts) {
      expect(a.plans, a.result.replyText).toHaveLength(1);
      expect(a.completions).toHaveLength(1);
      expect(a.completions[0].body.results).toMatchObject({
        savings_required_monthly: 4_000_000,
      });
      expect(b.completions[0].body.results).toEqual(
        a.completions[0].body.results,
      );
    }
  },
);
