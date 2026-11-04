import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvicePlanRequestSchema } from '@pfm/contracts';
import type { Database, Queries } from '@/data/migrate';
import { vi as messages } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';
import {
  buildCategoryChartItems,
  buildAdviceHistory,
  applyAdviceDisclaimer,
  getProxyBaseUrl,
  loadPersistedAIReplyMap,
  mapTopicToIntent,
  MockAIService,
  RemoteAIService,
  savePersistedAIReply,
  savePersistedAIReplyIfMessageExists,
  type AIServiceContext,
} from './ai-service';

it('keeps the finance question and only necessary clarification turns for a follow-up', () => {
  const replies = {
    first: {
      id: 'ai-first',
      userMessageId: 'first',
      replyText: 'Bạn dự kiến tiết kiệm mỗi tháng bao nhiêu?',
      createdAt: '',
    },
    second: {
      id: 'ai-second',
      userMessageId: 'second',
      replyText: 'Bạn định mua xe trong bao lâu?',
      createdAt: '',
    },
    unrelated: {
      id: 'ai-unrelated',
      userMessageId: 'unrelated',
      replyText: 'Đã ghi nhận.',
      createdAt: '',
    },
  };
  const previous = [
    { id: 'second', text: 'Tôi tiết kiệm 3 triệu mỗi tháng' },
    { id: 'first', text: 'Tôi muốn mua xe máy khoảng 40 triệu' },
    { id: 'unrelated', text: 'Câu chuyện cũ' },
  ];
  expect(buildAdviceHistory('Trong 7 tháng', previous, replies)).toEqual([
    { role: 'user', text: previous[1].text },
    { role: 'assistant', text: replies.first.replyText },
    { role: 'user', text: previous[0].text },
    { role: 'assistant', text: replies.second.replyText },
  ]);
  expect(
    buildAdviceHistory('Tôi muốn lập ngân sách tháng này', previous, replies),
  ).toEqual([]);
  expect(
    buildAdviceHistory(
      '12 triệu',
      [{ id: 'unrelated', text: 'Câu chuyện cũ' }],
      replies,
    ),
  ).toEqual([]);
});

it('retains personal advice context for a bare month follow-up after a declarative reply', () => {
  const questions = [
    'Tình hình nợ và tiết kiệm của tôi thế nào',
    'Mục tiêu của tôi thế nào',
    'Thu nhập của tôi đến từ đâu',
  ];
  for (const text of questions) {
    expect(
      buildAdviceHistory('Tháng này', [{ id: 'previous', text }], {
        previous: {
          id: 'ai-previous',
          userMessageId: 'previous',
          replyText: 'Đây là phần tổng quan của bạn.',
          createdAt: '',
        },
      }),
    ).toEqual([
      { role: 'user', text },
      { role: 'assistant', text: 'Đây là phần tổng quan của bạn.' },
    ]);
  }
});

it('keeps only the nearest advice topic when a bare month follows mixed finance questions', () => {
  const previous = [
    { id: 'income', text: 'Thu nhập của tôi đến từ đâu?' },
    { id: 'goals', text: 'Mục tiêu của tôi thế nào?' },
    { id: 'savings', text: 'Tình hình nợ và tiết kiệm của tôi thế nào?' },
  ];
  const replies = Object.fromEntries(
    previous.map(({ id }) => [
      id,
      {
        id: `ai-${id}`,
        userMessageId: id,
        replyText: 'Bạn muốn xem tháng nào?',
        createdAt: '',
      },
    ]),
  );
  expect(buildAdviceHistory('Tháng này', previous, replies)).toEqual([
    { role: 'user', text: previous[0].text },
    { role: 'assistant', text: 'Bạn muốn xem tháng nào?' },
  ]);
});

it('keeps the numeric topic for a follow-up whose previous answer had no question', () => {
  const replies = {
    facts: {
      id: 'ai-facts',
      userMessageId: 'facts',
      replyText:
        'Từ 29/10 – 4/11, bạn đã chi 5.000.000 ₫.\n• Tiền nhà: 3.500.000 ₫ (70%)',
      createdAt: '',
    },
  };
  const previous = [
    { id: 'facts', text: 'Cho tôi biết những ngày qua tôi tiêu gì nhiều' },
  ];
  const history = buildAdviceHistory('Thế tháng trước?', previous, replies);
  expect(history).toHaveLength(2);
  expect(history[0]).toEqual({
    role: 'user',
    text: 'Cho tôi biết những ngày qua tôi tiêu gì nhiều',
  });
  expect(history[1].role).toBe('assistant');
  expect(history[1].text).toContain('Khoảng thời gian đã hỏi');
  expect(history[1].text).toContain('5.000.000');
  expect(history[1].text.length).toBeLessThanOrEqual(500);
});

it('does not build history for an advice question that only carries a period', () => {
  const replies = {
    first: {
      id: 'ai-first',
      userMessageId: 'first',
      replyText: 'Bạn dự kiến tiết kiệm mỗi tháng bao nhiêu?',
      createdAt: '',
    },
  };
  expect(
    buildAdviceHistory(
      'Tôi muốn lập ngân sách tháng này',
      [{ id: 'first', text: 'Tôi muốn mua xe máy khoảng 40 triệu' }],
      replies,
    ),
  ).toEqual([]);
});

it('appends the reference-only disclaimer on the device, not from the model', () => {
  const payload = {
    id: 'ai-1',
    userMessageId: 'msg-1',
    replyText: 'Bạn chi nhiều nhất cho Ăn uống.',
    createdAt: '',
  };
  const spending = applyAdviceDisclaimer(
    payload,
    'Tôi muốn để dành 3 triệu mỗi tháng, khoản nào có thể giảm?',
  );
  expect(spending.replyText).toContain(messages.aiAdviceDisclaimer);
  expect(spending.replyText).not.toContain(messages.aiAdviceBigDecision);

  const loan = applyAdviceDisclaimer(
    payload,
    'Trả góp 4 triệu trong 18 tháng có phù hợp không?',
  );
  expect(loan.replyText).toContain(messages.aiAdviceDisclaimer);
  expect(loan.replyText).toContain(messages.aiAdviceBigDecision);

  // Appending twice must never duplicate the text.
  expect(
    applyAdviceDisclaimer(
      loan,
      'Trả góp 4 triệu trong 18 tháng có phù hợp không?',
    ),
  ).toEqual(loan);
});

it('does not save an in-flight AI reply after its chat message was deleted', async () => {
  let writes = 0;
  const tx: Queries = {
    execAsync: async () => undefined,
    runAsync: async () => {
      writes++;
    },
    getFirstAsync: async () => null,
    getAllAsync: async () => [],
  };
  const db: Database = { ...tx, transaction: async (task) => task(tx) };
  expect(
    await savePersistedAIReplyIfMessageExists(db, {
      id: 'ai-deleted',
      userMessageId: 'deleted',
      replyText: 'Old reply',
      createdAt: '',
    }),
  ).toBe(false);
  expect(writes).toBe(0);
});

it('accepts the reported motorcycle follow-up as a valid contextual request', () => {
  const original =
    'Với tài chính hiện tại của tôi thì nếu như tôi muốn mua xe máy mới khoảng tầm 40m thì cần tiết kiệm trong bao lâu';
  const followup =
    'Hiện tại hàng tháng tôi đang nợ ngân hàng cake 1 khoản 912k và phải trả 8 tháng nữa. Hàng tháng tôi được trợ cấp 5m và tôi có làm thêm với mức lương không cố định khoảng 200k/ngày. Tiền nhà hàng tháng phải trả là 1m6';
  const replyText =
    'Hiện tại, bạn đang có sẵn 2308000 VND và số tiền còn thiếu cho mục tiêu mua xe 40000000 VND là 37692000 VND.\n\nDữ liệu hiện chưa có ước tính cụ thể về số tháng cần tiết kiệm. Mỗi tháng bạn có thể dành riêng bao nhiêu tiền cho mục tiêu mua xe này?';
  const history = buildAdviceHistory(
    followup,
    [{ id: 'first', text: original }],
    {
      first: {
        id: 'ai-first',
        userMessageId: 'first',
        replyText,
        createdAt: '',
      },
    },
  );
  const parsed = AdvicePlanRequestSchema.safeParse({
    requestId: '11111111-2222-4333-8444-555555555555',
    question: followup,
    history,
  });
  expect(parsed.success).toBe(true);
  expect(history).toHaveLength(2);
});

vi.mock('@/data/connection', () => ({
  withDatabase: async (fn: (db: unknown) => unknown) => fn({}),
}));

vi.mock('@/data/advice-insights', () => ({
  readExpenseByCategory: async () => ({
    totalExpense: 5_000_000,
    topCategories: [
      {
        name: 'Tiền nhà',
        systemKey: 'expense.housing.rent',
        amount: 3_500_000,
      },
      { name: 'Ăn uống', systemKey: 'expense.food', amount: 1_500_000 },
    ],
    otherAmount: 0,
    uncategorizedAmount: 0,
    uncategorizedCount: 0,
    transactionCount: 12,
    hasData: true,
  }),
  readCashFlow: async () => ({
    totalIncome: 15_000_000,
    totalExpense: 5_000_000,
    net: 10_000_000,
    incomeCount: 2,
    expenseCount: 4,
    hasData: true,
  }),
}));

vi.mock('@/data/analysis', () => ({
  readAnalysisSummary: async () => ({
    window: { monthsWithData: 6 },
    generatedAt: '2026-10-30T10:00:00.000Z',
    dataThroughDate: '2026-10-30',
    monthsSampled: 6,
    coverage: {
      firstTransactionDate: '2026-05-01',
      lastTransactionDate: '2026-10-30',
      totalTransactions: 100,
    },
    quality: {
      hasUncategorizedTransactions: false,
      uncategorizedShareBps: 0,
      isIncomeStable: true,
      incomeStabilityScore: 90,
      hasSufficientHistory: true,
      hasRecentActivity: true,
      missingMonthsCount: 0,
    },
    income: {
      monthlyAvg: 15_000_000,
      monthlyMedian: 15_000_000,
      monthlyMin: 14_000_000,
      monthlyMax: 16_000_000,
      p25: 14_500_000,
      p75: 15_500_000,
      cvBps: 500,
    },
    expense: {
      monthlyAvg: 5_000_000,
      monthlyMedian: 5_000_000,
      monthlyMin: 4_500_000,
      monthlyMax: 5_500_000,
      p25: 4_800_000,
      p75: 5_200_000,
      cvBps: 600,
      fixedMonthlyAvg: 3_000_000,
      variableMonthlyAvg: 2_000_000,
    },
    surplus: {
      monthlyAvg: 10_000_000,
      median: 10_000_000,
      monthlyMedian: 10_000_000,
      monthlyMin: 9_000_000,
      monthlyMax: 11_000_000,
      p25: 9_500_000,
      p75: 10_500_000,
    },
    currentMonth: {
      monthKey: '2026-10',
      incomeSoFar: 15_000_000,
      expenseSoFar: 5_000_000,
      projectedExpense: 5_200_000,
      daysElapsed: 30,
      daysInMonth: 31,
    },
    topExpenseCategories: [],
    commitments: {
      recurringMonthlyTotal: 0,
      debtMonthlyObligation: 0,
      totalCommittedMonthly: 0,
      freeCashFlowMonthlyAvg: 10_000_000,
    },
    savings: {
      liquidBalance: 20_000_000,
      allocatedToGoals: 5_000_000,
      availableForGoals: 15_000_000,
      emergencyFundMonths: 4,
    },
    debts: {
      totalActiveDebts: 0,
      outstandingBorrowed: 0,
      outstandingLent: 0,
      netDebtPosition: 0,
      monthlyDebtService: 0,
      dtiBps: 0,
    },
    spendingAnomaly: null,
  }),
}));

vi.mock('@/services/device-id', () => ({
  getOrCreateDeviceId: async () => 'test-device-uuid-999',
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => '11111111-2222-4333-8444-555555555555',
}));

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      hostUri: '192.168.1.100:8081',
    },
  },
}));

describe('AIService & MockAIService', () => {
  const dummyContext: AIServiceContext = {
    balance: 10_000_000,
    monthlyIncome: 15_000_000,
    monthlyExpense: 5_000_000,
    monthlyNet: 10_000_000,
    topCategories: [{ name: 'Ăn uống', amount: 5_000_000 }],
    budgetsCount: 1,
    goalsCount: 1,
  };

  it('computes real category percentage bar chart items from integer expenses', () => {
    const { items, isSample } = buildCategoryChartItems([
      { name: 'Ăn uống', amount: 3_000_000 },
      { name: 'Nhà ở', amount: 2_000_000 },
      { name: 'Di chuyển', amount: 1_000_000 },
    ]);

    expect(isSample).toBe(false);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      category: 'Ăn uống',
      percentage: 50,
      amount: 3_000_000,
    });
    expect(items[1]).toMatchObject({
      category: 'Nhà ở',
      percentage: 33,
      amount: 2_000_000,
    });
    expect(items[2]).toMatchObject({
      category: 'Di chuyển',
      percentage: 17,
      amount: 1_000_000,
    });
    for (const item of items) {
      expect(Number.isInteger(item.amount)).toBe(true);
      expect(Number.isInteger(item.percentage)).toBe(true);
    }
  });

  it('falls back to sample category breakdown when current month has zero expenses', () => {
    const { items, isSample } = buildCategoryChartItems([]);
    expect(isSample).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(4);
    const totalPercent = items.reduce((sum, item) => sum + item.percentage, 0);
    expect(totalPercent).toBe(100);
    for (const item of items) {
      expect(Number.isInteger(item.amount)).toBe(true);
    }
  });

  it('generates 50/30/20 Budget Planner chart with exact integer sum and zero float drift', async () => {
    const service = new MockAIService({ delayMs: 0 });
    const context: AIServiceContext = {
      balance: 25_000_000,
      monthlyIncome: 10_000_001,
      monthlyExpense: 4_000_000,
      monthlyNet: 6_000_001,
      topCategories: [{ name: 'Ăn uống', amount: 4_000_000 }],
      budgetsCount: 2,
      goalsCount: 1,
    };

    const reply = await service.sendMessage(
      'Budget Planner: Lập kế hoạch ngân sách 50/30/20',
      context,
      'msg-budget-1',
    );

    expect(reply.userMessageId).toBe('msg-budget-1');
    expect(reply.chartItems).toHaveLength(3);
    expect(reply.chartItems?.map((i) => i.percentage)).toEqual([50, 30, 20]);

    const sumAmounts =
      reply.chartItems?.reduce((sum, item) => sum + item.amount, 0) ?? 0;
    expect(sumAmounts).toBe(10_000_001);
    for (const item of reply.chartItems ?? []) {
      expect(Number.isInteger(item.amount)).toBe(true);
    }
  });

  it('generates Goal Tracker insights and handles zero-income edge case safely', async () => {
    const service = new MockAIService({ delayMs: 0 });
    const zeroIncomeContext: AIServiceContext = {
      balance: 0,
      monthlyIncome: 0,
      monthlyExpense: 0,
      monthlyNet: 0,
      topCategories: [],
      budgetsCount: 0,
      goalsCount: 2,
    };

    const reply = await service.sendMessage(
      'Goal Tracker: Mục tiêu tiết kiệm',
      zeroIncomeContext,
      'msg-goal-1',
    );

    expect(reply.replyText).toContain('chưa có đủ dữ liệu thu chi');
    expect(reply.chartItems).toBeUndefined();
  });

  it('generates Spending Insights with real category percentage breakdown', async () => {
    const service = new MockAIService({ delayMs: 0 });
    const context: AIServiceContext = {
      balance: 18_500_000,
      monthlyIncome: 25_000_000,
      monthlyExpense: 6_500_000,
      monthlyNet: 18_500_000,
      topCategories: [
        { name: 'Ăn uống', amount: 3_900_000 },
        { name: 'Hóa đơn', amount: 2_600_000 },
      ],
      budgetsCount: 3,
      goalsCount: 2,
    };

    const reply = await service.sendMessage(
      'Spending Insights: Phân tích chi tiêu tháng này',
      context,
      'msg-spend-1',
    );

    expect(reply.replyText).toContain('25.000.000 ₫');
    expect(reply.replyText).toContain('6.500.000 ₫');
    expect(reply.chartItems).toHaveLength(2);
    expect(reply.chartItems?.[0]?.percentage).toBe(60);
    expect(reply.chartItems?.[1]?.percentage).toBe(40);
  });

  it('returns fixed local Vietnamese reply without chart for out-of-scope prompts', async () => {
    const service = new MockAIService({ delayMs: 0 });
    const reply = await service.sendMessage(
      'viết code python',
      dummyContext,
      'msg-out-1',
    );
    expect(reply.userMessageId).toBe('msg-out-1');
    expect(reply.replyText).toBe(messages.aiReplyOutOfScope);
    expect(reply.chartItems).toBeUndefined();
    expect(reply.chartTitle).toBeUndefined();
  });

  it('returns fixed local Vietnamese reply without chart for restricted recommendations', async () => {
    const service = new MockAIService({ delayMs: 0 });
    const reply = await service.sendMessage(
      'ngân hàng nào tốt nhất để vay',
      dummyContext,
      'msg-rest-1',
    );
    expect(reply.userMessageId).toBe('msg-rest-1');
    expect(reply.replyText).toBe(messages.aiReplyRestricted);
    expect(reply.chartItems).toBeUndefined();
    expect(reply.chartTitle).toBeUndefined();
  });

  it('returns fixed local Vietnamese reply without chart for ambiguous prompts', async () => {
    const service = new MockAIService({ delayMs: 0 });
    const reply = await service.sendMessage(
      'giúp tôi',
      dummyContext,
      'msg-amb-1',
    );
    expect(reply.userMessageId).toBe('msg-amb-1');
    expect(reply.replyText).toBe(messages.aiReplyAmbiguous);
    expect(reply.chartItems).toBeUndefined();
    expect(reply.chartTitle).toBeUndefined();
  });

  it('persists and loads AI replies from the SQLite settings table', async () => {
    const store = new Map<string, string>();
    const fakeDb: Queries = {
      execAsync: async () => undefined,
      runAsync: async (_sql: string, ...params: unknown[]) => {
        const [key, value] = params as [string, string];
        store.set(key, value);
        return { changes: 1, lastInsertRowId: 1 };
      },
      getFirstAsync: async <T>(_sql: string, ...params: unknown[]) => {
        const [key] = params as [string];
        const value = store.get(key);
        return (value ? { value } : null) as T | null;
      },
      getAllAsync: async () => [],
    };

    const emptyMap = await loadPersistedAIReplyMap(fakeDb);
    expect(emptyMap).toEqual({});

    await savePersistedAIReply(fakeDb, {
      id: 'ai-msg-1',
      userMessageId: 'msg-1',
      replyText: 'Phân tích mẫu',
      chartTitle: 'Biểu đồ (%)',
      chartItems: [
        {
          category: 'Ăn uống',
          percentage: 100,
          amount: 150_000,
          color: '#7C5CFF',
        },
      ],
      createdAt: '2026-10-28T00:00:00.000Z',
    });

    const loaded = await loadPersistedAIReplyMap(fakeDb);
    expect(loaded['msg-1']?.replyText).toBe('Phân tích mẫu');
    expect(loaded['msg-1']?.chartItems?.[0]?.amount).toBe(150_000);
  });
});

describe('RemoteAIService, getProxyBaseUrl & mapTopicToIntent', () => {
  const dummyContext: AIServiceContext = {
    balance: 10_000_000,
    monthlyIncome: 15_000_000,
    monthlyExpense: 5_000_000,
    monthlyNet: 10_000_000,
    topCategories: [{ name: 'Ăn uống', amount: 5_000_000 }],
    budgetsCount: 1,
    goalsCount: 1,
  };

  const originalFetch = global.fetch;

  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_PROXY_URL;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('maps domain advice topics to contracts intent enum correctly', () => {
    expect(mapTopicToIntent('purchase_affordability')).toBe(
      'purchase_affordability',
    );
    expect(mapTopicToIntent('loan_estimate')).toBe('loan_estimate');
    expect(mapTopicToIntent('savings_plan')).toBe('savings_plan');
    expect(mapTopicToIntent('budget_review')).toBe('budget_review');
    expect(mapTopicToIntent('spending_overview')).toBe('spending_overview');
    expect(mapTopicToIntent('general')).toBe('general');
  });

  it('derives proxy base URL from expoConfig hostUri automatically', () => {
    expect(getProxyBaseUrl()).toBe('http://192.168.1.100:3000');

    process.env.EXPO_PUBLIC_PROXY_URL = 'https://ai.pfm.local';
    expect(getProxyBaseUrl()).toBe('https://ai.pfm.local');
  });

  it('intercepts out_of_scope prompts locally without calling remote fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const remoteService = new RemoteAIService({
      baseUrl: 'http://127.0.0.1:3000',
    });
    const reply = await remoteService.sendMessage(
      'viết code python',
      dummyContext,
      'msg-remote-out',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(reply.replyText).toBe(messages.aiReplyOutOfScope);
  });

  it('intercepts restricted prompts locally without calling remote fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const remoteService = new RemoteAIService({
      baseUrl: 'http://127.0.0.1:3000',
    });
    const reply = await remoteService.sendMessage(
      'ngân hàng nào tốt nhất để vay',
      dummyContext,
      'msg-remote-rest',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(reply.replyText).toBe(messages.aiReplyRestricted);
  });

  it('intercepts ambiguous prompts locally without calling remote fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const remoteService = new RemoteAIService({
      baseUrl: 'http://127.0.0.1:3000',
    });
    const reply = await remoteService.sendMessage(
      'giúp tôi',
      dummyContext,
      'msg-remote-amb',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(reply.replyText).toBe(messages.aiReplyAmbiguous);
  });

  it('retries a contextual question against a proxy that does not yet accept history', async () => {
    const bodies: Record<string, unknown>[] = [];
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1)
        return {
          ok: false,
          status: 400,
          json: async () => ({
            success: false,
            code: 'BAD_REQUEST',
            message: 'Dữ liệu yêu cầu không hợp lệ.',
            errors: [
              { path: '', message: "Unrecognized key(s) in object: 'history'" },
            ],
          }),
        };
      return {
        ok: true,
        status: 200,
        json: async () =>
          bodies.length === 2
            ? {
                success: true,
                requestId: '11111111-2222-4333-8444-555555555555',
                planToken: 'signed-plan',
                selection: {
                  metrics: ['purchase_months_median'],
                  scenario: { price: 40_000_000 },
                },
              }
            : { success: true, answer: 'Bạn cần khoảng 7 tháng.' },
      };
    });
    const history = [
      {
        role: 'user' as const,
        text: 'Với tài chính hiện tại của tôi thì nếu như tôi muốn mua xe máy mới khoảng tầm 40m thì cần tiết kiệm trong bao lâu',
      },
      {
        role: 'assistant' as const,
        text: 'Mỗi tháng bạn có thể dành riêng bao nhiêu tiền cho mục tiêu mua xe này?',
      },
    ];
    const reply = await new RemoteAIService({
      baseUrl: 'http://127.0.0.1:3000',
    }).sendMessage(
      'Hiện tại hàng tháng tôi đang nợ ngân hàng cake 1 khoản 912k và phải trả 8 tháng nữa. Hàng tháng tôi được trợ cấp 5m và tôi có làm thêm với mức lương không cố định khoảng 200k/ngày. Tiền nhà hàng tháng phải trả là 1m6',
      dummyContext,
      'followup',
      history,
    );
    expect(reply.replyText).toContain('7 tháng');
    expect(bodies).toHaveLength(3);
    expect(bodies[0].history).toEqual(history);
    expect(bodies[1].history).toBeUndefined();
    expect(bodies[1].question).toContain('40m');
    expect(String(bodies[1].question).length).toBeLessThanOrEqual(500);
    expect(bodies[1].question).toContain('AI hỏi:');
    expect(bodies[2].question).toBe(bodies[1].question);
    expect(bodies[2].history).toBeUndefined();
  });

  it('answers a numeric question from local data without any network call or AI quota', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const remoteService = new RemoteAIService({
      baseUrl: 'http://127.0.0.1:3000',
    });

    const reply = await remoteService.sendMessage(
      'Tháng này tôi chi bao nhiêu?',
      dummyContext,
      'msg-factual-flow',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(reply.replyText).toContain('15.000.000 ₫');
    expect(reply.replyText).toContain('5.000.000 ₫');
    expect(reply.replyText).toContain('1/11');
    expect(reply.chartItems).toBeUndefined();
  });

  it('answers a category question from local data and never shows sample chart data', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const remoteService = new RemoteAIService({
      baseUrl: 'http://127.0.0.1:3000',
    });

    const reply = await remoteService.sendMessage(
      'Cho tôi biết những ngày qua tôi tiêu gì nhiều',
      dummyContext,
      'msg-factual-category',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(reply.replyText).toContain('Tiền nhà');
    expect(reply.replyText).toContain('3.500.000 ₫');
    expect(reply.chartItems?.map((item) => item.category)).toEqual([
      'Tiền nhà',
      'Ăn uống',
    ]);
    expect(reply.chartTitle).not.toContain('mẫu');
  });

  it('asks one short period question instead of guessing a window', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const remoteService = new RemoteAIService({
      baseUrl: 'http://127.0.0.1:3000',
    });

    const reply = await remoteService.sendMessage(
      'Tôi tiêu gì nhiều?',
      dummyContext,
      'msg-factual-ask',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(reply.replyText).toContain('khoảng thời gian nào');
  });

  it('sends an advice question to the proxy with device ID and only selected metrics', async () => {
    const requests: {
      url: string;
      headers: HeadersInit;
      body: Record<string, unknown>;
    }[] = [];

    global.fetch = vi.fn().mockImplementation(async (url, init) => {
      requests.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return {
        ok: true,
        json: async () =>
          url.endsWith('/plan')
            ? {
                success: true,
                requestId: '11111111-2222-4333-8444-555555555555',
                planToken: 'signed-plan',
                selection: {
                  metrics: ['current_month_expense', 'months_with_data'],
                  scenario: {},
                },
              }
            : {
                success: true,
                requestId: '11111111-2222-4333-8444-555555555555',
                answer:
                  'Dựa trên số liệu thực tế, ngân sách tháng này của bạn đang duy trì tỷ lệ tích lũy tốt.',
              },
      };
    });

    const remoteService = new RemoteAIService({
      baseUrl: 'http://127.0.0.1:3000',
    });
    const question =
      'Tôi muốn để dành 3 triệu mỗi tháng, khoản nào có thể giảm?';
    const reply = await remoteService.sendMessage(
      question,
      dummyContext,
      'msg-remote-ok',
    );

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(requests[0].headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-device-id': 'test-device-uuid-999',
    });

    expect(requests[0].url).toMatch(/\/v1\/advice\/plan$/);
    expect(requests[0].body).toEqual({
      requestId: '11111111-2222-4333-8444-555555555555',
      question,
      language: 'vi',
      currency: 'VND',
      supportsRiskContext: true,
    });
    expect(requests[1].url).toMatch(/\/v1\/advice\/complete$/);
    expect(requests[1].body.results).toEqual({
      current_month_expense: 5_000_000,
      months_with_data: 6,
    });
    expect(JSON.stringify(requests)).not.toContain('15_000_000');

    expect(reply.replyText).toContain('Dựa trên số liệu thực tế');
    expect(reply.replyText).toContain(messages.aiAdviceDisclaimer);
    expect(reply.chartItems).toBeUndefined();
  });

  it('sends English USD context and converts selected money metrics with the current rate', async () => {
    const previous = usePreferences.getState();
    usePreferences.setState({
      language: 'en',
      currency: 'USD',
      exchangeRate: 25_000,
    });
    const requests: Record<string, unknown>[] = [];
    global.fetch = vi.fn().mockImplementation(async (url, init) => {
      requests.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () =>
          url.endsWith('/plan')
            ? {
                success: true,
                requestId: '11111111-2222-4333-8444-555555555555',
                planToken: 'signed-plan',
                selection: {
                  metrics: [
                    'monthly_income_avg',
                    'surplus_after_payment',
                    'payment_reserve_total',
                    'months_with_data',
                  ],
                  scenario: { monthlyPayment: 10.25, paymentMonths: 3 },
                },
              }
            : {
                success: true,
                answer: 'You can save $389.75 after the payment.',
              },
      };
    });
    try {
      const reply = await new RemoteAIService({
        baseUrl: 'http://127.0.0.1:3000',
      }).sendMessage(
        'How does a $10.25 monthly payment affect my budget?',
        dummyContext,
      );
      expect(requests[0]).toMatchObject({ language: 'en', currency: 'USD' });
      expect(requests[1]).toMatchObject({
        language: 'en',
        currency: 'USD',
        results: {
          monthly_income_avg: 600,
          surplus_after_payment: 389.75,
          payment_reserve_total: 30.75,
          months_with_data: 6,
        },
      });
      expect(reply.replyText).toContain('$389.75');
    } finally {
      usePreferences.setState({
        language: previous.language,
        currency: previous.currency,
        exchangeRate: previous.exchangeRate,
      });
    }
  });

  it('asks for missing inputs in English on the offline fallback without inventing income', async () => {
    const previous = usePreferences.getState();
    usePreferences.setState({ language: 'en', currency: 'VND' });
    try {
      const reply = await new MockAIService({ delayMs: 0 }).sendMessage(
        'How should I plan my budget?',
        {
          balance: 0,
          monthlyIncome: 0,
          monthlyExpense: 0,
          monthlyNet: 0,
          topCategories: [],
          budgetsCount: 0,
          goalsCount: 0,
        },
      );
      expect(reply.replyText).toContain('monthly income');
      expect(reply.replyText).not.toContain('10,000,000');
    } finally {
      usePreferences.setState({
        language: previous.language,
        currency: previous.currency,
      });
    }
  });

  it('handles QUOTA_EXCEEDED_DEVICE response from proxy gracefully', async () => {
    global.fetch = vi.fn().mockImplementation(async () => ({
      ok: false,
      status: 429,
      json: async () => ({
        success: false,
        message: 'Bạn đã dùng hết lượt hỏi AI hôm nay.',
        code: 'QUOTA_EXCEEDED_DEVICE',
        fallbackTemplate: 'Tóm tắt: Thu nhập 15.000.000 ₫, chi 5.000.000 ₫.',
      }),
    }));

    const remoteService = new RemoteAIService({
      baseUrl: 'http://127.0.0.1:3000',
    });
    const reply = await remoteService.sendMessage(
      'Tôi muốn để dành 3 triệu mỗi tháng, khoản nào có thể giảm?',
      dummyContext,
      'msg-quota-exceeded',
    );

    expect(reply.replyText).toContain('Bạn đã dùng hết lượt hỏi AI hôm nay.');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to local analysis when network error occurs', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network offline'));

    const mockFallback = new MockAIService({ delayMs: 0 });
    const remoteService = new RemoteAIService({
      baseUrl: 'http://127.0.0.1:3000',
      fallbackService: mockFallback,
    });

    const reply = await remoteService.sendMessage(
      'Budget Planner: Ngân sách 50/30/20',
      dummyContext,
      'msg-network-fail',
    );

    expect(reply.replyText).toContain('quy tắc 50/30/20');
    expect(reply.replyText).toContain('Không thể kết nối máy chủ AI');
    expect(reply.chartItems?.length).toBe(3);
  });
});
