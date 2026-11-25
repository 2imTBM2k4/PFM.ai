import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdvicePlanRequestSchema } from '@pfm/contracts';
import { flags } from '../../app.config';
import { readConversationState } from '@/data/conversation-state';
import { readChatSourceMessages } from '@/data/repository';
import { adviceStateFixture } from './advice-context.fixtures';
import { createBudget } from '@/data/budgets';
import * as analysis from '@/data/analysis';
import type { Database, Queries } from '@/data/migrate';
import { vi as messages } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';
import { useApp } from '@/state/app';
import { adviceCalculationCache } from './advice-metrics';
import { defaultGoogleAuthEnvironment } from '@/features/backup/google-auth';
import { routeChatInput } from '@/features/chat/intent';
import {
  buildCategoryChartItems,
  buildAdviceHistory,
  buildAdviceClarification,
  applyAdviceDisclaimer,
  fetchAIQuota,
  formatAIQuotaBanner,
  formatQuotaResetTimeVietnam,
  getProxyBaseUrl,
  loadPersistedAIReplyMap,
  mapTopicToIntent,
  MockAIService,
  parseAIQuotaResponse,
  RemoteAIService,
  readAIServiceContext,
  savePersistedAIReply,
  savePersistedAIReplyIfMessageExists,
  shouldShowAIQuotaBadge,
  type AIServiceContext,
} from './ai-service';

it.each([
  ['income', 'thu nhập', 'income'],
  ['expense', 'chi phí', 'expenses'],
  ['savingsForGoal', 'dành riêng', 'reserved'],
  ['savingsMonths', 'bao nhiêu tháng', 'how many months'],
  ['expense.includes', 'đã gồm', 'include'],
  ['expense.total', 'tổng chi', 'expense total'],
  ['expense.appOverlap', 'ứng dụng', 'app'],
  ['expense.category', 'nhóm', 'category'],
  ['goal', 'mục tiêu nào', 'which goal'],
  ['period', 'mỗi tháng', 'monthly'],
  ['cashFlowBasis', 'mỗi tháng', 'monthly'],
  ['observationRange', 'khoảng dữ liệu', 'observation dates'],
  ['exchangeRate', 'tỷ giá', 'exchange rate'],
  ['amount', 'kiểm tra', 'check'],
  ['conversationFacts', 'kiểm tra', 'check'],
  ['unknownField', 'kiểm tra', 'check'],
] as const)(
  'asks for the missing field %s in both languages',
  (field, vietnamese, english) => {
    expect(buildAdviceClarification([field], 'vi').toLowerCase()).toContain(
      vietnamese,
    );
    expect(buildAdviceClarification([field], 'en').toLowerCase()).toContain(
      english,
    );
    expect(buildAdviceClarification([field], 'vi')).not.toContain(field);
  },
);

it('deduplicates clarification questions without asking for already known inputs', () => {
  const question = buildAdviceClarification(
    ['savingsForGoal', 'savingsMonths', 'savingsForGoal'],
    'vi',
  );
  expect(question).toContain('dành riêng');
  expect(question).toContain('bao nhiêu tháng');
  expect(question.match(/dành riêng/g)).toHaveLength(1);
  expect(question.match(/bao nhiêu tháng/g)).toHaveLength(1);
  expect(question).not.toContain('thu nhập');
  for (const fields of [[], ['unknown']]) {
    const fallback = buildAdviceClarification(fields, 'vi');
    expect(fallback).toContain('kiểm tra');
    expect(fallback).not.toContain('unknown');
  }
});

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
    { id: 'first', role: 'user', text: previous[1].text },
    { id: 'ai-first', role: 'assistant', text: replies.first.replyText },
    { id: 'second', role: 'user', text: previous[0].text },
    { id: 'ai-second', role: 'assistant', text: replies.second.replyText },
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
      { id: 'previous', role: 'user', text },
      {
        id: 'ai-previous',
        role: 'assistant',
        text: 'Đây là phần tổng quan của bạn.',
      },
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
    { id: 'income', role: 'user', text: previous[0].text },
    { id: 'ai-income', role: 'assistant', text: 'Bạn muốn xem tháng nào?' },
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
    id: 'facts',
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

describe('state validation context transport', () => {
  const originalFetch = global.fetch;
  const originalFlag = flags.useStateBackedContext;
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const serviceContext: AIServiceContext = {
    balance: 0,
    monthlyIncome: 0,
    monthlyExpense: 0,
    monthlyNet: 0,
    topCategories: [],
    budgetsCount: 0,
    goalsCount: 0,
    calculationScope: { deviceId: 'test-device', conversationId: 'session-1' },
  };
  const send = () =>
    new RemoteAIService({ baseUrl: 'https://proxy.example' }).sendMessage(
      'Tính kế hoạch tiết kiệm giúp tôi',
      serviceContext,
      'current',
    );
  beforeEach(() => {
    flags.useStateBackedContext = false;
    usePreferences.setState({ language: 'vi', currency: 'VND' });
    const fixture = adviceStateFixture();
    vi.mocked(readConversationState)
      .mockReset()
      .mockResolvedValue(fixture.state);
    vi.mocked(readChatSourceMessages)
      .mockReset()
      .mockResolvedValue(fixture.sourceMessages);
    requests.length = 0;
    global.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ path: String(url), body });
      return new Response(
        JSON.stringify(
          String(url).endsWith('/plan')
            ? {
                success: true,
                requestId: '11111111-2222-4333-8444-555555555555',
                planToken: 'test-plan',
                selection: { metrics: [], scenario: { conversationFacts: [] } },
              }
            : { success: true, answer: 'Kết quả đã kiểm tra.' },
        ),
      );
    });
  });
  afterEach(() => {
    flags.useStateBackedContext = originalFlag;
    global.fetch = originalFetch;
    vi.mocked(readConversationState).mockReset().mockResolvedValue(null);
    vi.restoreAllMocks();
  });
  it('omits context and does not read state when the flag is disabled', async () => {
    await send();
    expect(requests).toHaveLength(2);
    for (const { body } of requests) expect(body).not.toHaveProperty('context');
    expect(readConversationState).not.toHaveBeenCalled();
    expect(readChatSourceMessages).not.toHaveBeenCalled();
  });
  it('omits context when the enabled session has no state', async () => {
    flags.useStateBackedContext = true;
    vi.mocked(readConversationState).mockResolvedValue(null);
    await send();
    expect(requests).toHaveLength(2);
    for (const { body } of requests) expect(body).not.toHaveProperty('context');
    expect(readConversationState).toHaveBeenCalledWith('session-1');
  });
  it('sends the same bounded context to plan and complete from session-owned SQLite sources', async () => {
    flags.useStateBackedContext = true;
    await send();
    expect(requests.map(({ path }) => path.split('/').at(-1))).toEqual([
      'plan',
      'complete',
    ]);
    const expected = {
      sessionId: 'session-1',
      revision: 1,
      activeScenario: adviceStateFixture().state.activeScenario,
      pendingFields: [],
      sourceMessages: adviceStateFixture().sourceMessages.map(
        ({ id, text }) => ({ id, text, role: 'user' }),
      ),
    };
    expect(requests[0].body.context).toEqual(expected);
    expect(requests[1].body.context).toEqual(expected);
    expect(expected.sourceMessages.length).toBeLessThanOrEqual(8);
    expect(requests[0].body.context).not.toHaveProperty('facts');
    expect(readConversationState).toHaveBeenCalledOnce();
    expect(readChatSourceMessages).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      ['m1', 'm2', 'm3', 'm4'],
    );
  });
  it('keeps the snapshot when local state changes while plan is in flight', async () => {
    flags.useStateBackedContext = true;
    const fixture = adviceStateFixture();
    vi.mocked(readConversationState).mockResolvedValue(fixture.state);
    const network = global.fetch;
    global.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith('/plan')) fixture.state.revision = 2;
      return network(url, init);
    });
    await send();
    expect(fixture.state.revision).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[0].body.context).toMatchObject({ revision: 1 });
    expect(requests[1].body.context).toEqual(requests[0].body.context);
    expect(readConversationState).toHaveBeenCalledOnce();
  });
  it.each(['missing-source', 'too-many-sources', 'oversized-source'] as const)(
    'falls back without truncation for %s',
    async (issue) => {
      flags.useStateBackedContext = true;
      const fixture = adviceStateFixture();
      if (issue === 'missing-source')
        vi.mocked(readChatSourceMessages).mockResolvedValue([]);
      if (issue === 'oversized-source') {
        fixture.sourceMessages[0].text = 'a'.repeat(501);
        vi.mocked(readChatSourceMessages).mockResolvedValue(
          fixture.sourceMessages,
        );
      }
      if (
        issue === 'too-many-sources' &&
        fixture.state.activeScenario.income.status === 'known'
      ) {
        fixture.state.activeScenario.income.sourceMessageIds = Array.from(
          { length: 9 },
          (_, index) => `m${index + 1}`,
        );
        vi.mocked(readConversationState).mockResolvedValue(fixture.state);
      }
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await send();
      expect(requests).toHaveLength(2);
      for (const { body } of requests)
        expect(body).not.toHaveProperty('context');
      expect(warning).toHaveBeenCalledWith(
        'ADVICE_VALIDATION_CONTEXT_FALLBACK',
      );
    },
  );
});

vi.mock('@/features/budgets/mobile', () => ({ checkBudgetAlerts: vi.fn() }));
vi.mock('@/data/conversation-state', () => ({ readConversationState: vi.fn().mockResolvedValue(null) }));
vi.mock('@/data/repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/data/repository')>(),
  readChatSourceMessages: vi.fn(),
}));
vi.mock('@/data/budgets', () => ({ createBudget: vi.fn() }));
vi.mock('@/data/categories', () => ({ listCategories: async () => [] }));
vi.mock('@/data/dashboard', () => ({
  readDashboard: async () => ({
    balance: 10_000_000,
    current: { income: 15_000_000, expense: 5_000_000, net: 10_000_000 },
    topCategories: [],
    budgets: [],
    goals: [],
  }),
}));
vi.mock('@/state/app', () => ({
  useApp: {
    setState: vi.fn(),
    getState: vi.fn(() => ({
      chatSessionId: 'session-1',
      status: 'ready',
      deleting: false,
    })),
    subscribe: vi.fn(() => () => undefined),
  },
}));

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

describe('Phase C transaction intent boundary', () => {
  it.each([
    'đừng lưu 30k',
    'làm sao thêm khoản 30k?',
    'đừng ghi chi ăn sáng 30k',
    'làm sao ghi chi ăn sáng 30k?',
  ])(
    'does not open an entry draft for a negation or usage question: %s',
    (input) => {
      const result = routeChatInput(input, {
        clock: {
          now: () => new Date('2026-11-13T12:00:00+07:00'),
          timeZone: 'Asia/Ho_Chi_Minh',
        },
        knownCounterparties: [],
      });
      expect(result.route).not.toBe('transaction');
      expect(['ambiguous', 'advice']).toContain(result.route);
    },
  );
  it('keeps local mock conversations outside the server quota and request logging', async () => {
    const original = global.fetch;
    const network = vi.fn<typeof fetch>();
    global.fetch = network;
    try {
      const service = new MockAIService({ delayMs: 0 });
      for (let index = 0; index < 5; index++) {
        const reply = await service.sendMessage(
          'Quỹ dự phòng là gì?',
          {
            balance: 0,
            monthlyIncome: 0,
            monthlyExpense: 0,
            monthlyNet: 0,
            topCategories: [],
            budgetsCount: 0,
            goalsCount: 0,
          },
          `local-${index}`,
        );
        expect(reply.replyText).toBeTruthy();
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      global.fetch = original;
    }
  });
});

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

  it.each(['2 xị', '2xyz', '2 l', '2 lít'])(
    'returns visible local clarification for an ambiguous bare amount: %s',
    async (input) => {
      const originalFetch = global.fetch;
      const originalLanguage = usePreferences.getState().language;
      const fetch = vi.fn();
      global.fetch = fetch;
      usePreferences.setState({ language: 'vi' });
      try {
        const services = [
          new RemoteAIService({ baseUrl: 'https://proxy.example' }),
          new MockAIService({ delayMs: 0 }),
        ];
        for (const service of services) {
          const result = await service.sendMessage(input, dummyContext, 'ambiguous-amount');
          expect(result.replyText).toContain('Chưa rõ ngữ cảnh tài chính');
          expect(result.replyText).toContain('Vui lòng nói rõ hơn');
        }
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        global.fetch = originalFetch;
        usePreferences.setState({ language: originalLanguage });
      }
    },
  );

  it.each([
    [6, true, 'monthly', 2, 1_000_000, false, false],
    [undefined, true, 'monthly', 1, null, false, false],
    [6, true, 'yearly', 1, null, false, false],
    [6, false, 'monthly', 2, 6_000_000, true, false],
    [6, false, 'monthly', 1, null, true, true],
  ] as const)(
    'calculates a monthly scenario without calendar dates: %s/%s/%s',
    async (
      savingsMonths,
      hasExpense,
      period,
      requests,
      remaining,
      readsSummary,
      conflictingRange,
    ) => {
      const originalFetch = global.fetch;
      const readSummary = vi.spyOn(analysis, 'readAnalysisSummary');
      const bodies: Record<string, unknown>[] = [];
      const facts = (
        [
          ['income', 15_000_000],
          ['expense', 10_000_000],
          ['saving_goal', 24_000_000],
        ] as const
      )
        .filter(([kind]) => hasExpense || kind !== 'expense')
        .map(([kind, amount]) => ({
          id: kind,
          source_message_id: 'current',
          kind,
          amount,
          currency: 'VND',
          period: kind === 'saving_goal' ? 'one_off' : period,
          source: 'user_statement',
          mode: 'actual',
        }));
      global.fetch = vi.fn(async (url, options) => {
        bodies.push(JSON.parse(options!.body as string));
        return new Response(
          JSON.stringify(
            String(url).endsWith('/plan')
              ? {
                  success: true,
                  requestId: '11111111-2222-4333-8444-555555555555',
                  planToken: 'signed-plan',
                  selection: {
                    metrics: [
                      'savings_required_monthly',
                      'surplus_after_savings_goal',
                    ],
                    scenario: {
                      conversationFacts: facts,
                      savingsForGoal: 0,
                      ...(savingsMonths === undefined ? {} : { savingsMonths }),
                    },
                  },
                }
              : {
                  success: true,
                  answer: 'Kế hoạch dựa trên các khoản đã nêu.',
                },
          ),
        );
      });
      try {
        const reply = await new RemoteAIService({
          baseUrl: 'https://proxy.example',
        }).sendMessage(
          'Thu nhập 15 triệu mỗi tháng, chi phí 10 triệu mỗi tháng. Tiền dành riêng = 0 đồng; tôi muốn tiết kiệm 24 triệu trong 6 tháng.',
          conflictingRange
            ? {
                ...dummyContext,
                adviceInputContext: {
                  mode: 'actual',
                  currency: 'VND',
                  cashFlowBasis: 'monthly',
                  observationRange: { from: '2026-11-01', to: '2026-11-16' },
                },
              }
            : dummyContext,
          'current',
        );
        expect(bodies).toHaveLength(requests);
        expect(readSummary.mock.calls.length > 0).toBe(readsSummary);
        if (requests === 2)
          expect(bodies[1]).toMatchObject({
            results: {
              savings_required_monthly: 4_000_000,
              surplus_after_savings_goal: remaining,
            },
          });
        else if (conflictingRange) {
          expect(reply.replyText.toLowerCase()).toContain('khoảng dữ liệu');
        } else if (savingsMonths === undefined) {
          expect(reply.replyText).toContain('bao nhiêu tháng');
          expect(reply.replyText).not.toContain('thu nhập');
          expect(reply.replyText).not.toContain('ngày');
        } else {
          expect(reply.replyText).toContain('tháng');
          expect(reply.replyText).toContain('có phải');
          expect(reply.replyText).not.toContain('năm');
        }
      } finally {
        global.fetch = originalFetch;
        readSummary.mockRestore();
      }
    },
  );

  it.each([
    ['VND', 0, undefined, 4_000_000, 1_000_000],
    ['VND', undefined, undefined, null, null],
    ['VND', 6_000_000, 0, 4_000_000, 1_000_000],
    ['USD', 1.25, undefined, 3.8, 1.2],
  ] as const)(
    'passes reserved savings to calculations: %s / %s / %s',
    async (currency, reserved, localReserved, required, remaining) => {
      const originalFetch = global.fetch;
      const preferences = usePreferences.getState();
      usePreferences.setState({ currency, exchangeRate: 25000 });
      const unit = currency === 'USD' ? 1 : 1_000_000;
      const facts = (
        [
          ['income', 15],
          ['expense', 10],
          ['saving_goal', 24],
        ] as const
      ).map(([kind, value]) => ({
        id: kind,
        source_message_id: 'current',
        kind,
        amount: value * unit * (currency === 'USD' ? 100 : 1),
        currency,
        period: kind === 'saving_goal' ? 'one_off' : 'monthly',
        source: 'user_statement',
        mode: 'actual',
      }));
      const bodies: Record<string, unknown>[] = [];
      global.fetch = vi.fn(async (url, options) => {
        bodies.push(JSON.parse(options!.body as string));
        return new Response(
          JSON.stringify(
            String(url).endsWith('/plan')
              ? {
                  success: true,
                  requestId: '11111111-2222-4333-8444-555555555555',
                  planToken: 'signed-plan',
                  selection: {
                    metrics: [
                      'savings_required_monthly',
                      'surplus_after_savings_goal',
                    ],
                    scenario: {
                      conversationFacts: facts,
                      savingsMonths: 6,
                      ...(reserved === undefined
                        ? {}
                        : { savingsForGoal: reserved }),
                    },
                  },
                }
              : {
                  success: true,
                  answer: 'Kế hoạch dựa trên các khoản đã nêu.',
                },
          ),
        );
      });
      try {
        const reply = await new RemoteAIService({
          baseUrl: 'https://proxy.example',
        }).sendMessage(
          'Kế hoạch tiết kiệm tháng này của tôi thế nào?',
          {
            ...dummyContext,
            balance: 999_000_000,
            adviceInputContext: {
              mode: 'actual',
              currency,
              period: { kind: 'month', from: '2026-11-01', to: '2026-11-30' },
              ...(localReserved === undefined
                ? {}
                : { savingsForGoal: localReserved }),
            },
          },
          'current',
        );
        expect(bodies).toHaveLength(required === null ? 1 : 2);
        if (required === null) {
          expect(reply.replyText).toContain('dành riêng');
          expect(reply.replyText).not.toContain('thu nhập');
        }
        if (required !== null)
          expect(bodies[1]).toMatchObject({
            results: {
              savings_required_monthly: required,
              surplus_after_savings_goal: remaining,
            },
          });
      } finally {
        global.fetch = originalFetch;
        usePreferences.setState({
          currency: preferences.currency,
          exchangeRate: preferences.exchangeRate,
        });
      }
    },
  );

  it('clears calculation results on session reset and data deletion', async () => {
    const context = await readAIServiceContext();
    expect(context.calculationScope).toEqual({
      deviceId: 'test-device-uuid-999',
      conversationId: 'session-1',
    });
    const clear = vi.spyOn(adviceCalculationCache, 'clear');
    try {
      const listener = vi.mocked(useApp.subscribe).mock.calls.at(-1)![0];
      const before = useApp.getState();
      listener({ ...before, chatSessionId: 'session-2' }, before);
      listener({ ...before, deleting: true }, before);
      expect(clear).toHaveBeenCalledTimes(2);
    } finally {
      clear.mockRestore();
    }
  });

  it.each(['actual', 'hypothetical'] as const)(
    'uses verified %s conversation facts in the complete request',
    async (mode) => {
      const originalFetch = global.fetch;
      const facts = [
        {
          id: 'salary',
          source_message_id: 'previous',
          kind: 'income',
          amount: 15_000_000,
          currency: 'VND',
          period: 'monthly',
          source: 'user_statement',
          mode: 'actual',
        },
        {
          id: 'corrected',
          source_message_id: 'current',
          kind: 'income',
          amount: 12_000_000,
          currency: 'VND',
          period: 'monthly',
          source: 'user_statement',
          mode: 'actual',
          supersedes_id: 'salary',
        },
        {
          id: 'hypothetical',
          source_message_id: 'current',
          kind: 'income',
          amount: 20_000_000,
          currency: 'VND',
          period: 'monthly',
          source: 'user_statement',
          mode: 'hypothetical',
        },
        ...(['actual', 'hypothetical'] as const).map((mode) => ({
          id: `cost-${mode}`,
          source_message_id: 'current',
          kind: 'expense',
          amount: 8_000_000,
          currency: 'VND',
          period: 'monthly',
          source: 'user_statement',
          mode,
        })),
      ];
      const bodies: Record<string, unknown>[] = [];
      global.fetch = vi.fn(async (url, options) => {
        bodies.push(JSON.parse(options!.body as string));
        return new Response(
          JSON.stringify(
            String(url).endsWith('/plan')
              ? {
                  success: true,
                  requestId: '11111111-2222-4333-8444-555555555555',
                  planToken: 'signed-plan',
                  selection: {
                    metrics: ['monthly_income_avg', 'surplus_median'],
                    scenario: { conversationFacts: facts },
                  },
                }
              : {
                  success: true,
                  answer: 'Kế hoạch dựa trên các khoản đã nêu.',
                },
          ),
          { status: 200 },
        );
      });
      try {
        await new RemoteAIService({
          baseUrl: 'https://proxy.example',
        }).sendMessage(
          'Kế hoạch tiết kiệm tháng này của tôi thế nào?',
          {
            ...dummyContext,
            adviceInputContext: {
              mode,
              currency: 'VND',
              period: { kind: 'month', from: '2026-11-01', to: '2026-11-30' },
            },
          },
          'current',
          [{ id: 'previous', role: 'user', text: 'Lương tôi 15 triệu' }],
        );
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toMatchObject({
          planToken: 'signed-plan',
          results: {
            monthly_income_avg: mode === 'actual' ? 12_000_000 : 20_000_000,
            surplus_median: mode === 'actual' ? 4_000_000 : 12_000_000,
          },
        });
        expect(bodies[1]).not.toHaveProperty('inputFacts');
      } finally {
        global.fetch = originalFetch;
      }
    },
  );

  const mockIncomePlan = (source: string, period: 'monthly' | 'yearly') =>
    vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            requestId: '11111111-2222-4333-8444-555555555555',
            planToken: 'signed-plan',
            selection: {
              metrics: ['monthly_income_avg'],
              scenario: {
                conversationFacts: [
                  {
                    id: 'income',
                    source_message_id: source,
                    kind: 'income',
                    amount: 15_000_000,
                    currency: 'VND',
                    period,
                    mode: 'actual',
                    source: 'user_statement',
                  },
                ],
              },
            },
          }),
        ),
    );

  it('does not complete a plan with an invented source for positive monthly income', async () => {
    const originalFetch = global.fetch;
    const fetch = mockIncomePlan('invented', 'monthly');
    global.fetch = fetch;
    try {
      const reply = await new RemoteAIService({
        baseUrl: 'https://proxy.example',
      }).sendMessage(
        'Kế hoạch tiết kiệm của tôi thế nào?',
        dummyContext,
        'current',
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        'https://proxy.example/v1/advice/plan',
        expect.anything(),
      );
      expect(fetch).not.toHaveBeenCalledWith(
        'https://proxy.example/v1/advice/complete',
        expect.anything(),
      );
      expect(reply.replyText.toLowerCase()).toContain(
        'nguồn dữ kiện không hợp lệ',
      );
      expect(reply.replyText).not.toContain('invented');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('asks for the monthly basis without completing positive yearly income from a valid source', async () => {
    const originalFetch = global.fetch;
    const fetch = mockIncomePlan('current', 'yearly');
    global.fetch = fetch;
    try {
      const reply = await new RemoteAIService({
        baseUrl: 'https://proxy.example',
      }).sendMessage(
        'Kế hoạch tiết kiệm của tôi thế nào?',
        dummyContext,
        'current',
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        'https://proxy.example/v1/advice/plan',
        expect.anything(),
      );
      expect(fetch).not.toHaveBeenCalledWith(
        'https://proxy.example/v1/advice/complete',
        expect.anything(),
      );
      expect(reply.replyText).toContain('tháng');
      expect(reply.replyText).not.toContain('năm');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('asks which situation to calculate when the current turn contains both modes', async () => {
    const originalFetch = global.fetch;
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            requestId: '11111111-2222-4333-8444-555555555555',
            planToken: 'signed-plan',
            selection: {
              metrics: ['monthly_income_avg'],
              scenario: {
                conversationFacts: ['actual', 'hypothetical'].flatMap(
                  (mode) => [
                    {
                      id: `income-${mode}`,
                      source_message_id: 'current',
                      kind: 'income',
                      amount: 15_000_000,
                      currency: 'VND',
                      period: 'monthly',
                      mode,
                      source: 'user_statement',
                    },
                    {
                      id: `expense-${mode}`,
                      source_message_id: 'current',
                      kind: 'expense',
                      amount: 8_000_000,
                      currency: 'VND',
                      period: 'monthly',
                      mode,
                      source: 'user_statement',
                    },
                  ],
                ),
              },
            },
          }),
          { status: 200 },
        ),
    );
    global.fetch = fetch;
    try {
      await new RemoteAIService({
        baseUrl: 'https://proxy.example',
      }).sendMessage(
        'Kế hoạch tiết kiệm tháng này của tôi thế nào?',
        dummyContext,
        'current',
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it.each([
    ['local', new MockAIService({ delayMs: 0 })],
    ['remote', new RemoteAIService({ baseUrl: 'http://127.0.0.1:3000' })],
  ])(
    '%s guides budget creation without writing financial data',
    async (_, service) => {
      vi.mocked(createBudget).mockClear();
      const reply = await service.sendMessage(
        'Tạo ngân sách ăn uống 2 triệu',
        dummyContext,
        'budget-read-only',
      );
      expect(createBudget).not.toHaveBeenCalled();
      expect(reply.replyText).toContain('Ngân sách');
      expect(reply.replyText).not.toMatch(/đã tạo|đã thiết lập/i);
      expect(reply.replyText).not.toContain('7.500.000');
    },
  );

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

  it('answers an explicit conversation-only plan without reading local financial data', async () => {
    const readSummary = vi.spyOn(analysis, 'readAnalysisSummary');
    const originalFetch = global.fetch;
    global.fetch = vi.fn(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith('/plan')
              ? {
                  success: true,
                  requestId: '11111111-2222-4333-8444-555555555555',
                  planToken: 'signed-plan',
                  selection: {
                    metrics: [],
                    scenario: { conversationFacts: [] },
                  },
                }
              : {
                  success: true,
                  answer: 'Ngân sách giúp bạn phân bổ thu nhập và chi tiêu.',
                },
          ),
          { status: 200 },
        ),
    );
    try {
      const reply = await new RemoteAIService({
        baseUrl: 'http://127.0.0.1:3000',
      }).sendMessage('Ngân sách là gì?', dummyContext, 'knowledge');
      expect(reply.replyText).toContain('phân bổ');
      expect(readSummary).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
      readSummary.mockRestore();
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
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
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
    expect(bodies[1].question).not.toContain('AI hỏi:');
    expect(bodies[1].question).not.toContain(history[1].text);
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

    expect(reply.replyText).toContain('Bạn đã dùng hết lượt hỏi AI hôm nay');
    expect(reply.replyText).toContain('Tóm tắt: Thu nhập 15.000.000 ₫');
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

  it('parses /v1/quota, hides badge when limit is MAX_SAFE_INTEGER, and formats resetAt in Asia/Ho_Chi_Minh', async () => {
    const nowRef = new Date('2026-11-09T15:00:00+07:00');
    const finite = parseAIQuotaResponse({
      success: true,
      data: {
        allowed: true,
        remaining: 7,
        limit: 10,
        resetAt: '2026-11-10T00:00:00+07:00',
      },
    });
    expect(finite).toEqual({
      allowed: true,
      remaining: 7,
      limit: 10,
      resetAt: '2026-11-10T00:00:00+07:00',
    });
    expect(shouldShowAIQuotaBadge(finite)).toBe(true);
    expect(formatAIQuotaBanner(finite, 'vi', nowRef)).toContain(
      'Còn 7/10 lượt tư vấn AI hôm nay',
    );
    expect(formatAIQuotaBanner(finite, 'en', nowRef)).toContain(
      '7/10 AI advice turns left today',
    );

    // Unlimited testing mode (Number.MAX_SAFE_INTEGER) must hide the quota badge
    const unlimited = parseAIQuotaResponse({
      success: true,
      data: {
        allowed: true,
        remaining: Number.MAX_SAFE_INTEGER,
        limit: Number.MAX_SAFE_INTEGER,
        resetAt: '2026-11-10T00:00:00+07:00',
      },
    });
    expect(shouldShowAIQuotaBadge(unlimited)).toBe(false);
    expect(formatAIQuotaBanner(unlimited, 'vi', nowRef)).toBeNull();
    expect(formatAIQuotaBanner(unlimited, 'en', nowRef)).toBeNull();

    // Exhausted quota (remaining = 0) formats reset time in Vietnam timezone
    const exhausted = parseAIQuotaResponse({
      allowed: false,
      remaining: 0,
      limit: 10,
      resetAt: '2026-11-10T00:00:00+07:00',
    });
    expect(formatAIQuotaBanner(exhausted, 'vi', nowRef)).toContain(
      '00:00 ngày mai',
    );
    expect(formatAIQuotaBanner(exhausted, 'en', nowRef)).toContain(
      '00:00 tomorrow',
    );

    // Converts UTC timestamp to Asia/Ho_Chi_Minh (+07:00)
    expect(
      formatQuotaResetTimeVietnam('2026-11-15T07:30:00.000Z', 'vi', nowRef),
    ).toBe('14:30 ngày 15/11');
    expect(
      formatQuotaResetTimeVietnam('2026-11-15T07:30:00.000Z', 'en', nowRef),
    ).toBe('14:30 on 15/11');
  });

  it('never leaks baseUrl in replyText and differentiates offline, server error, and quota exceeded in both vi and en', async () => {
    const secretBaseUrl = 'https://secret-proxy-host-9988.internal:8443';
    const mockFallback = new MockAIService({ delayMs: 0 });
    const remoteService = new RemoteAIService({
      baseUrl: secretBaseUrl,
      fallbackService: mockFallback,
    });
    const previousLang = usePreferences.getState().language;

    try {
      for (const lang of ['vi', 'en'] as const) {
        usePreferences.setState({ language: lang });

        // 1. Offline / network error
        global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const offlineReply = await remoteService.sendMessage(
          'Tôi muốn để dành 3 triệu mỗi tháng, khoản nào có thể giảm?',
          dummyContext,
          `offline-${lang}`,
        );
        expect(offlineReply.replyText).not.toContain(secretBaseUrl);
        expect(offlineReply.replyText).not.toContain('secret-proxy-host-9988');

        // 2. Server error (HTTP 500)
        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: async () => ({
            success: false,
            code: 'INTERNAL_SERVER_ERROR',
            message: `Failed at ${secretBaseUrl}`,
          }),
        });
        const serverErrorReply = await remoteService.sendMessage(
          'Tôi muốn để dành 3 triệu mỗi tháng, khoản nào có thể giảm?',
          dummyContext,
          `server-${lang}`,
        );
        expect(serverErrorReply.replyText).not.toContain(secretBaseUrl);
        expect(serverErrorReply.replyText).not.toContain(
          'secret-proxy-host-9988',
        );

        // 3. Quota exceeded (HTTP 429)
        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          json: async () => ({
            success: false,
            code: 'QUOTA_EXCEEDED_DEVICE',
            message:
              'Bạn đã dùng hết lượt hỏi AI hôm nay. Lượt mới có từ 2026-11-10T00:00:00+07:00.',
            fallbackTemplate: 'Gợi ý mẫu dự phòng.',
          }),
        });
        const quotaReply = await remoteService.sendMessage(
          'Tôi muốn để dành 3 triệu mỗi tháng, khoản nào có thể giảm?',
          dummyContext,
          `quota-${lang}`,
        );
        expect(quotaReply.replyText).not.toContain(secretBaseUrl);
        expect(quotaReply.replyText).toContain('00:00');
        expect(quotaReply.replyText).toContain('Gợi ý mẫu dự phòng.');

        // All 3 error states must have distinct messages
        expect(offlineReply.replyText).not.toBe(serverErrorReply.replyText);
        expect(serverErrorReply.replyText).not.toBe(quotaReply.replyText);
        expect(offlineReply.replyText).not.toBe(quotaReply.replyText);
      }
    } finally {
      usePreferences.setState({ language: previousLang });
    }
  });

  it('enforces HTTPS and never guesses LAN IP from hostUri outside __DEV__', async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;

    // Without EXPO_PUBLIC_PROXY_URL, production must not guess http://<hostUri>:3000
    expect(getProxyBaseUrl()).toBe('');

    // Non-HTTPS EXPO_PUBLIC_PROXY_URL is rejected outside __DEV__
    process.env.EXPO_PUBLIC_PROXY_URL = 'http://192.168.1.50:3000';
    expect(getProxyBaseUrl()).toBe('');

    // HTTPS EXPO_PUBLIC_PROXY_URL is accepted outside __DEV__
    process.env.EXPO_PUBLIC_PROXY_URL = 'https://api.pfm.ai';
    expect(getProxyBaseUrl()).toBe('https://api.pfm.ai');

    // fetchAIQuota and RemoteAIService block HTTP baseUrl outside __DEV__ without calling fetch
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const quota = await fetchAIQuota({
      baseUrl: 'http://192.168.1.50:3000',
      fetchImpl: fetchMock,
    });
    expect(quota).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const remoteService = new RemoteAIService({
      baseUrl: 'http://192.168.1.50:3000',
      fallbackService: new MockAIService({ delayMs: 0 }),
    });
    const reply = await remoteService.sendMessage(
      'Tôi muốn để dành 3 triệu mỗi tháng, khoản nào có thể giảm?',
      dummyContext,
      'msg-prod-http-blocked',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reply.replyText).not.toContain('192.168.1.50');
  });
});

describe('Google identity on remote AI requests', () => {
  const token = (sub: string, expiresIn: number) =>
    [
      { alg: 'RS256', kid: 'test' },
      {
        sub,
        aud: 'client',
        iss: 'https://accounts.google.com',
        exp: Math.floor(Date.now() / 1000) + expiresIn,
      },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
      .join('.') + '.signature';
  const context: AIServiceContext = {
    balance: 0,
    monthlyIncome: 0,
    monthlyExpense: 0,
    monthlyNet: 0,
    topCategories: [],
    budgetsCount: 0,
    goalsCount: 0,
    calculationScope: { deviceId: 'device', conversationId: 'auth-session' },
  };
  const setup = () => {
    const driver = {
      configure: vi.fn(),
      hasPlayServices: vi.fn(async () => true),
      signIn: vi.fn(),
      signOut: vi.fn(),
      getCurrentUser: vi.fn<() => unknown>(() => ({
        user: { id: 'native-user' },
      })),
      getTokens: vi.fn(async () => ({
        accessToken: 'access',
        idToken: token('google-user', 3600),
      })),
      signInSilently: vi.fn(async () => ({ type: 'success' })),
    };
    vi.spyOn(defaultGoogleAuthEnvironment, 'isExpoGo').mockReturnValue(false);
    vi.spyOn(defaultGoogleAuthEnvironment, 'getWebClientId').mockReturnValue(
      'client',
    );
    vi.spyOn(defaultGoogleAuthEnvironment, 'loadDriver').mockReturnValue(
      driver,
    );
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ success: false, code: 'TEST_STOP' }), {
          status: 400,
        }),
    );
    vi.stubGlobal('fetch', fetch);
    return {
      driver,
      fetch,
      service: new RemoteAIService({ baseUrl: 'https://proxy.example' }),
    };
  };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('shows localized auth and rate-limit errors without retrying the server', async () => {
    const { fetch, service } = setup();
    for (const [status, body, expected] of [
      [
        401,
        { error: 'INVALID_TOKEN' },
        'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.',
      ],
      [
        429,
        { code: 'RATE_LIMIT_EXCEEDED' },
        'Bạn đợi thêm 60 giây để hỏi tiếp nhé.',
      ],
      [
        429,
        { code: 'GUEST_RATE_LIMIT_EXCEEDED' },
        'Chế độ dùng thử giới hạn 1 câu/5 phút. Đăng nhập để hỏi nhiều hơn.',
      ],
    ] as const) {
      fetch.mockClear();
      fetch.mockResolvedValue(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Retry-After': '60' },
        }),
      );
      const result = await service.sendMessage('Quỹ dự phòng là gì?', context);
      expect(result.replyText).toBe(expected);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('sends only Authorization after login and only device identity after logout', async () => {
    const { driver, fetch, service } = setup();
    await service.sendMessage('Kế hoạch tiết kiệm của tôi thế nào?', context);
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: `Bearer ${token('google-user', 3600)}`,
    });
    expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty('x-device-id');
    driver.getCurrentUser.mockReturnValue(null);
    await service.sendMessage('Kế hoạch tiết kiệm của tôi thế nào?', context);
    expect(fetch.mock.calls[1][1]?.headers).toMatchObject({
      'x-device-id': 'test-device-uuid-999',
    });
    expect(fetch.mock.calls[1][1]?.headers).not.toHaveProperty('Authorization');
  });
  it('shows the due-date clarification instead of a generic server error', async () => {
    const { fetch, service } = setup();
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          code: 'ADVICE_AMBIGUOUS',
          message: 'Bạn muốn xem các khoản dự kiến đến hạn đến ngày nào?',
        }),
        { status: 422 },
      ),
    );
    const result = await service.sendMessage(
      'Có khoản nào sắp đến hạn không?',
      context,
    );
    expect(result.replyText).toBe(
      'Bạn muốn xem các khoản dự kiến đến hạn đến ngày nào?',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses the same authenticated identity for quota reads and receipt uploads', async () => {
    const { fetch } = setup();
    await fetchAIQuota({ baseUrl: 'https://proxy.example' });
    expect(fetch.mock.calls[0][1]?.headers).toHaveProperty('Authorization');
    const { scanReceipt } = await import('./receipt-service');
    await expect(
      scanReceipt('jpeg', 'https://proxy.example', 'guest-device', fetch),
    ).rejects.toThrow();
    expect(fetch.mock.calls[1][1]?.headers).toHaveProperty('Authorization');
    expect(fetch.mock.calls[1][1]?.headers).not.toHaveProperty('x-device-id');
  });
  it('silently refreshes an expired ID token before sending it', async () => {
    const { driver, fetch, service } = setup();
    driver.getTokens.mockResolvedValueOnce({
      accessToken: 'access',
      idToken: token('google-user', -1),
    });
    await service.sendMessage('Kế hoạch tiết kiệm của tôi thế nào?', {
      ...context,
      calculationScope: {
        deviceId: 'device',
        conversationId: 'refresh-session',
      },
    });
    expect(driver.signInSilently).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: `Bearer ${token('google-user', 3600)}`,
    });
  });
  it('keeps the failed-refresh session in guest mode without retry loops or a crash', async () => {
    const { driver, fetch, service } = setup();
    driver.getTokens.mockResolvedValue({
      accessToken: 'access',
      idToken: token('google-user', -1),
    });
    driver.signInSilently.mockRejectedValue(new Error('refresh failed'));
    for (let i = 0; i < 2; i++)
      await service.sendMessage('Kế hoạch tiết kiệm của tôi thế nào?', {
        ...context,
        calculationScope: {
          deviceId: 'device',
          conversationId: 'failed-refresh-session',
        },
      });
    expect(driver.signInSilently).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      expect(call[1]?.headers).toHaveProperty('x-device-id');
      expect(call[1]?.headers).not.toHaveProperty('Authorization');
    }
  });
  it('uses the same Google subject for the calculation cache', async () => {
    setup();
    expect((await readAIServiceContext()).calculationScope).toEqual({
      userId: 'google-user',
      conversationId: 'session-1',
    });
  });
});
