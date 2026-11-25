import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isMoneyFact, type AdvicePlanSelection } from '@pfm/contracts';
import { migrate, type Database, type Queries } from '@/data/migrate';
import { seed, DEFAULT_WALLET_ID } from '@/data/seed';
import { createCategory } from '@/data/categories';
import { createBudget } from '@/data/budgets';
import { createTransaction } from '@/data/transactions';
import { saveChatMessage } from '@/data/repository';
import { flags } from '../../app.config';
import { vi as messages } from '@/messages/vi';
import {
  defaultAIService,
  RemoteAIService,
  type AdviceHistoryItem,
} from './ai-service';
import { runAdvice } from './advice-agent';
import { adviceStateFixture } from './advice-context.fixtures';
import { loadToolCallingCases } from '../../../../services/proxy/src/eval/tool-calling-runner';

vi.mock('expo-crypto', () => ({
  randomUUID: () => '11111111-2222-4333-8444-555555555555',
}));
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('./ai-auth', () => ({
  readAIAuth: async () => ({ mode: 'guest', deviceId: 'mini-router-test' }),
  aiAuthHeaders: () => ({}),
}));
vi.mock('@/state/preferences', () => ({
  usePreferences: {
    getState: () => ({ language: 'vi', currency: 'VND', exchangeRate: null }),
  },
  formatCurrencyAmount: (value: number) => String(value),
}));
vi.mock('@/data/connection', () => ({
  withDatabase: (task: (db: Database) => Promise<unknown>) => task(db),
}));

const cases = loadToolCallingCases(
  readFileSync(
    new URL('../../../../docs/tool-calling-test-cases.md', import.meta.url),
    'utf8',
  ),
);
const timestamp = '2026-11-16T12:00:00Z';
const categoryId = '11111111-1111-4111-8111-111111111111';
const budgetId = '22222222-2222-4222-8222-222222222222';
let sqlite: DatabaseSync;
let db: Database;
const timings: {
  id: string;
  offMs: number;
  onMs: number;
  overheadMs: number;
  planCalls: number;
  completeCalls: number;
}[] = [];
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(timestamp);
  flags.useAgentLoop = false;
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const queries: Queries = {
    execAsync: async (sql) => {
      sqlite.exec(sql);
    },
    runAsync: async (sql, ...params) => sqlite.prepare(sql).run(...params),
    getAllAsync: async <T,>(
      sql: string,
      ...params: (string | number | null)[]
    ) => sqlite.prepare(sql).all(...params) as T[],
    getFirstAsync: async <T,>(
      sql: string,
      ...params: (string | number | null)[]
    ) => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
  };
  db = {
    ...queries,
    transaction: async (task) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        await task(queries);
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  await migrate(db);
  await seed(db, timestamp);
  await createCategory(
    db,
    categoryId,
    {
      name: 'Ăn uống',
      kind: 'expense',
      parentId: null,
      icon: null,
      color: null,
    },
    timestamp,
  );
  const add = async (
    id: string,
    amount: number,
    date: string,
    kind: 'income' | 'expense',
    category: string | null = null,
  ) =>
    createTransaction(
      db,
      id,
      {
        amount,
        kind,
        walletId: DEFAULT_WALLET_ID,
        categoryId: category,
        occurredOn: date,
        occurredAt: `${date}T10:00:00+07:00`,
      },
      timestamp,
    );
  for (let month = 5; month <= 10; month++) {
    const date = `2026-${String(month).padStart(2, '0')}-02`;
    await add(`income-${month}`, 15_000_000, date, 'income');
    await add(`expense-${month}`, 10_000_000, date, 'expense');
  }
  await add('food-1', 1_000_000, '2026-11-02', 'expense', categoryId);
  await add('food-2', 2_000_000, '2026-11-08', 'expense', categoryId);
  await add('food-3', 500_000, '2026-11-15', 'expense', categoryId);
  await add('other-current', 14_500_000, '2026-11-16', 'expense');
  await createBudget(
    db,
    budgetId,
    { categoryId, amount: 3_000_000, startMonth: '2026-11' },
    timestamp,
  );
});
afterEach(() => {
  flags.useAgentLoop = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  sqlite.close();
});
afterAll(() => {
  console.info(
    'MINI_ROUTER_LOCAL_TIMING',
    JSON.stringify({
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      timings,
    }),
  );
});

it.each([
  ['out_of_scope', 'Cách nấu phở', messages.aiReplyOutOfScope],
  ['restricted', 'Nên chọn ngân hàng nào để vay?', messages.aiReplyRestricted],
  ['ambiguous', 'Có', messages.aiReplyAmbiguous],
  [
    'budget guidance',
    'Tạo ngân sách ăn uống 2 triệu',
    messages.aiBudgetCreateGuidance,
  ],
] as const)(
  'keeps %s replies local and unchanged with the flag off/on',
  async (_kind, prompt, expected) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const remote = new RemoteAIService({ baseUrl: 'https://proxy.invalid' });
    const send = vi
      .spyOn(defaultAIService, 'sendMessage')
      .mockImplementation(remote.sendMessage.bind(remote));
    for (const enabled of [false, true]) {
      flags.useAgentLoop = enabled;
      const result = await runAdvice({
        prompt,
        userMessageId: 'current',
        history: [],
        context: {
          balance: 0,
          monthlyIncome: 0,
          monthlyExpense: 0,
          monthlyNet: 0,
          topCategories: [],
          budgetsCount: 0,
          goalsCount: 0,
        },
      });
      expect(result.replyText).toBe(expected);
    }
    expect(send).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each([
  ['current-month cash flow', 'Tháng này tôi chi bao nhiêu?', [], '18000000'],
  [
    'follow-up cash flow',
    'Thế tháng trước?',
    [
      {
        id: 'previous',
        role: 'user' as const,
        text: 'Tháng này tôi chi bao nhiêu?',
      },
    ],
    '10000000',
  ],
] as const)(
  'routes %s to the AI Coach endpoint when the agent flag is on while keeping legacy SQLite reply when off',
  async (_kind, prompt, history, amount) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        `event: delta\ndata: {"seq":1,"text":"Chi tiêu: ${amount}","verification":"segment_passed"}\n\nevent: done\ndata: {"incomplete":false,"verification":"passed"}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const remote = new RemoteAIService({ baseUrl: 'https://proxy.invalid' });
    const send = vi
      .spyOn(defaultAIService, 'sendMessage')
      .mockImplementation(remote.sendMessage.bind(remote));

    flags.useAgentLoop = false;
    const legacyResult = await runAdvice({
      prompt,
      userMessageId: 'current',
      history: [...history],
      context: {
        balance: 0,
        monthlyIncome: 0,
        monthlyExpense: 0,
        monthlyNet: 0,
        topCategories: [],
        budgetsCount: 0,
        goalsCount: 0,
      },
    });
    expect(legacyResult.replyText).toContain(amount);
    expect(send).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();

    flags.useAgentLoop = true;
    const agentResult = await runAdvice({
      prompt,
      userMessageId: 'current',
      history: [...history],
      baseUrl: 'https://proxy.invalid',
      fetchFn: fetchMock,
      context: {
        balance: 0,
        monthlyIncome: 0,
        monthlyExpense: 18_000_000,
        monthlyNet: -18_000_000,
        topCategories: [{ name: 'Ăn uống', amount: 3_500_000 }],
        budgetsCount: 1,
        goalsCount: 0,
      },
    });
    expect(agentResult.replyText).toContain(amount);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://proxy.invalid/v1/advice/coach',
    );
  },
);

it.each(cases)(
  '$id keeps legacy semantics and model-call count with the flag on',
  async (testCase) => {
    const saving = ['S3', 'S5', 'D3', 'C1', 'C2'].includes(testCase.id);
    const history: AdviceHistoryItem[] =
      testCase.id === 'S5'
        ? [
            {
              id: 'previous',
              role: 'user',
              text: cases.find((item) => item.id === 'S3')!.question,
            },
            {
              id: 'previous-reply',
              role: 'assistant',
              text: 'Kế hoạch tiết kiệm đã được ghi nhận.',
            },
          ]
        : [];
    const facts = adviceStateFixture()
      .state.facts.filter(isMoneyFact)
      .slice(0, 3)
      .map((fact) => ({
        ...fact,
        source_message_id:
          testCase.id === 'S5' && fact.kind !== 'income'
            ? 'previous'
            : 'current',
        ...(testCase.id === 'S5' && fact.kind === 'income'
          ? { amount: 12_000_000 }
          : {}),
      }));
    const selection: AdvicePlanSelection = saving
      ? {
          metrics: [
            'monthly_income_avg',
            'surplus_median',
            'savings_required_monthly',
            'surplus_after_savings_goal',
          ],
          scenario: {
            savingsTarget: 24_000_000,
            ...(testCase.id !== 'C1' ? { savingsForGoal: 0 } : {}),
            ...(testCase.id !== 'C2' ? { savingsMonths: 6 } : {}),
            conversationFacts: facts,
          },
        }
      : {
          metrics: ['S1', 'D1'].includes(testCase.id)
            ? ['monthly_income_avg', 'monthly_expense_avg']
            : [],
          scenario: {},
          groups: [
            ...(['S2', 'D1', 'D2'].includes(testCase.id)
              ? [{ kind: 'budget_status' as const }]
              : []),
            // The legacy protocol offers aggregates, not a transaction-list group; preserve that limitation.
            ...(['S4', 'D2'].includes(testCase.id)
              ? [
                  {
                    kind: 'expense_by_category' as const,
                    rangeKind: 'this_month' as const,
                  },
                ]
              : []),
          ],
        };
    const context = {
      balance: 12_000_000,
      monthlyIncome: 15_000_000,
      monthlyExpense: 10_000_000,
      monthlyNet: 5_000_000,
      topCategories: [],
      budgetsCount: 1,
      goalsCount: 1,
    };
    const remote = new RemoteAIService({ baseUrl: 'https://proxy.invalid' });
    async function run(enabled: boolean) {
      const requests: { path: string; body: Record<string, unknown> }[] = [];
      const mock = vi.fn<typeof fetch>(async (url, init) => {
        const path = String(url);
        const body = JSON.parse(String(init?.body));
        requests.push({ path, body });
        if (path.endsWith('/v1/advice/step'))
          return Response.json({ status: 'needs_clarification', fields: ['toolIntent'] });
        if (path.endsWith('/v1/advice/coach'))
          return new Response(
            'event: delta\ndata: {"seq":1,"text":"Đã ghi nhận điều chỉnh.","verification":"segment_passed"}\n\nevent: done\ndata: {"incomplete":false,"verification":"passed"}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        if (path.endsWith('/plan'))
          return Response.json({
            success: true,
            requestId: '11111111-2222-4333-8444-555555555555',
            planToken: 'synthetic-plan',
            selection,
          });
        // Echo only the verified deterministic calculation into the synthetic final answer.
        return Response.json({
          success: true,
          answer: `Kết quả đã tính: ${JSON.stringify(body.results)}; dữ liệu: ${JSON.stringify(body.dataGroups ?? [])}.`,
        });
      });
      vi.stubGlobal('fetch', mock);
      let handedOff: number | undefined;
      const send = vi
        .spyOn(defaultAIService, 'sendMessage')
        .mockImplementation((...args) => {
          handedOff = performance.now();
          return remote.sendMessage(...args);
        });
      flags.useAgentLoop = enabled;
      if (enabled) await saveChatMessage(db, 'current', testCase.question, timestamp, 'session-1');
      let generated = 0;
      const input = {
        prompt: testCase.question,
        context,
        userMessageId: 'current',
        history,
        ...(enabled ? { sessionId: 'session-1', baseUrl: 'https://proxy.invalid', fetchFn: mock, generateId: () => `00000000-0000-4000-8000-${String(++generated).padStart(12, '0')}` } : {}),
      };
      const before = { ...input };
      const started = performance.now();
      const result = await runAdvice(input);
      const localMs = (handedOff ?? performance.now()) - started;
      expect(input).toEqual(before);
      expect(send.mock.calls.length).toBeLessThanOrEqual(1);
      send.mockRestore();
      return { result, requests, localMs };
    }
    const off = await run(false);
    const on = await run(true);
    expect(on.result.userMessageId).toBe('current');
    expect(
      on.requests.every(
        ({ path }) =>
          path.endsWith('/v1/advice/step') || path.endsWith('/v1/advice/coach'),
      ),
    ).toBe(true);
    expect(
      off.requests.every(
        ({ path }) => path.endsWith('/plan') || path.endsWith('/complete'),
      ),
    ).toBe(true);
    const plans = off.requests.filter(({ path }) => path.endsWith('/plan'));
    const completions = off.requests.filter(({ path }) =>
      path.endsWith('/complete'),
    );
    if (testCase.id === 'S1') {
      // Record the legacy range-parser gap; equivalence must not be reported as a correct six-month answer.
      expect(plans).toHaveLength(0);
      expect(off.result.replyText).toMatch(/ngày|tháng/);
      expect(off.result.replyText).not.toContain('15.000.000');
    } else if (testCase.id === 'C1' || testCase.id === 'C2') {
      expect(plans).toHaveLength(1);
      expect(completions).toHaveLength(0);
      expect(off.result.replyText).toContain(
        testCase.id === 'C1' ? 'dành riêng' : 'bao nhiêu tháng',
      );
    } else if (saving) {
      expect(plans).toHaveLength(1);
      expect(completions).toHaveLength(1);
      expect(completions[0].body.results).toMatchObject({
        monthly_income_avg: testCase.id === 'S5' ? 12_000_000 : 15_000_000,
        savings_required_monthly: 4_000_000,
        surplus_after_savings_goal:
          testCase.id === 'S5' ? -2_000_000 : 1_000_000,
      });
      expect(off.result.replyText).toContain('4000000');
    }
    if (['S2', 'D1', 'D2'].includes(testCase.id)) {
      expect(completions).toHaveLength(1);
      // Existing readAdviceGroups caps spent at the limit; phase 3.5 must not silently claim this is fixed.
      expect(completions[0].body.dataGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'budget_status',
            items: [
              expect.objectContaining({
                limitAmount: 3_000_000,
                spentAmount: 3_000_000,
                remainingAmount: 0,
              }),
            ],
          }),
        ]),
      );
    }
    const overheadMs = on.localMs - off.localMs;
    timings.push({
      id: testCase.id,
      offMs: off.localMs,
      onMs: on.localMs,
      overheadMs,
      planCalls: plans.length,
      completeCalls: completions.length,
    });
    // Allow parallel Vitest worker contention while keeping local routing well under 100ms.
    expect(overheadMs).toBeLessThan(100);
  },
);
