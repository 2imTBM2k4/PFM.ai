import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMoneyFact } from '@pfm/contracts';
import {
  CALCULATION_VERSION,
  calculateAdviceInputs,
  normalizeAdviceInputs,
} from '@pfm/domain';
import { migrate, type Database, type Queries } from '@/data/migrate';
import { seed, DEFAULT_WALLET_ID } from '@/data/seed';
import { createTransaction } from '@/data/transactions';
import { createBudget } from '@/data/budgets';
import { createWallet } from '@/data/wallets';
import { adviceStateFixture } from './advice-context.fixtures';
import { executeTool } from './advice-tools';

let sqlite: DatabaseSync;
let db: Database;
let transactionCount: number;
const now = '2026-11-16T12:00:00.000Z';
const baseContext = { sessionId: 'session-1', stateRevision: 1 };
const tools = [
  'get_transactions',
  'calculate_budget_status',
  'plan_savings_goal',
  'get_financial_snapshot',
];
const transactionParams = {
  from: '2026-11-01',
  to: '2026-11-16',
  kind: null,
  category_id: null,
  limit: 3,
};
vi.mock('@/data/connection', () => ({
  withDatabase: (task: (db: Database) => Promise<unknown>) => task(db),
}));
const run = (
  name: string,
  params: unknown,
  state = adviceStateFixture().state,
) =>
  executeTool(name, params, tools, {
    ...baseContext,
    state,
    deadline: Date.now() + 5_000,
  });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  transactionCount = 0;
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const queries: Queries = {
    execAsync: async (sql) => {
      sqlite.exec(sql);
    },
    runAsync: async (sql, ...params) => sqlite.prepare(sql).run(...params),
    getAllAsync: async <T>(
      sql: string,
      ...params: (string | number | null)[]
    ) => sqlite.prepare(sql).all(...params) as T[],
    getFirstAsync: async <T>(
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
  await seed(db, now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  sqlite.close();
});

async function addTransaction(
  amount: number,
  date = '2026-11-02',
  kind: 'income' | 'expense' = 'expense',
  categoryId: string | null = null,
) {
  const id = `transaction-${++transactionCount}`;
  await createTransaction(
    db,
    id,
    {
      kind,
      amount,
      walletId: DEFAULT_WALLET_ID,
      categoryId,
      occurredOn: date,
      occurredAt: `${date}T10:00:00+07:00`,
      note: 'private note',
      rawInput: 'private raw input',
    },
    now,
  );
  return id;
}
async function populateHistory(startMonth = 5) {
  for (let month = startMonth; month <= 10; month++) {
    const date = `2026-${String(month).padStart(2, '0')}-02`;
    await addTransaction(15_000_000, date, 'income');
    await addTransaction(10_000_000, date);
  }
}

describe('get_transactions', () => {
  it('fills optional defaults and retains the 20-row maximum', async () => {
    for (let index = 0; index < 21; index++) await addTransaction(100_000);
    const result = await run('get_transactions', {
      from: '2026-11-01',
      to: '2026-11-16',
    });
    expect(result).toMatchObject({ status: 'ok', truncated: true });
    if (result.status !== 'ok') throw Error('Expected transactions');
    expect(result.data).toMatchObject({
      transactions: expect.any(Array),
      truncated: true,
    });
    expect(
      (result.data as { transactions: unknown[] }).transactions,
    ).toHaveLength(20);
  });
  it.each([3, 5])(
    'reads %i rows, limits output and preserves newest-first order without totals or private fields',
    async (count) => {
      for (let index = 1; index <= count; index++)
        await addTransaction(100_000 * index, `2026-11-0${index}`);
      const result = await run('get_transactions', transactionParams);
      expect(result).toMatchObject({
        status: 'ok',
        stateRevision: 1,
        calculationVersion: CALCULATION_VERSION,
        truncated: count > 3,
      });
      if (result.status !== 'ok') throw Error('Expected transactions');
      expect(result.data).toEqual({
        transactions: [count, count - 1, count - 2].map((index) => ({
          id: `transaction-${index}`,
          date: `2026-11-0${index}`,
          amount: 100_000 * index,
          currency: 'VND',
          kind: 'expense',
          category_id: null,
        })),
        truncated: count > 3,
      });
      expect(result.data).not.toHaveProperty('total');
    },
  );
  it.each([
    { from: '2026-11-17' },
    { from: '2026-02-30' },
    { limit: 0 },
    { limit: 21 },
  ])('rejects invalid parameters %#', async (overrides) => {
    expect(
      await run('get_transactions', { ...transactionParams, ...overrides }),
    ).toEqual({ status: 'error', code: 'INVALID_PARAMS', retryable: false });
  });
  it('returns an empty transaction array', async () => {
    expect(await run('get_transactions', transactionParams)).toMatchObject({
      status: 'ok',
      data: { transactions: [], truncated: false },
    });
  });
  it('applies date, kind and category filters', async () => {
    const category = '00000000-0000-4000-8001-000000000001';
    const id = await addTransaction(500_000, '2026-11-02', 'expense', category);
    await addTransaction(200_000, '2026-11-02');
    await addTransaction(300_000, '2026-10-02', 'expense', category);
    await addTransaction(1_000_000, '2026-11-02', 'income');
    expect(
      await run('get_transactions', {
        ...transactionParams,
        kind: 'expense',
        category_id: category,
      }),
    ).toMatchObject({ status: 'ok', data: { transactions: [{ id }] } });
  });
  it('uses booked VND rather than attaching original USD to the booked amount', async () => {
    await createTransaction(
      db,
      'usd',
      {
        kind: 'income',
        amount: 100,
        currency: 'USD',
        vndPerUsd: 25_000,
        walletId: DEFAULT_WALLET_ID,
        occurredOn: '2026-11-02',
        occurredAt: '2026-11-02T10:00:00+07:00',
      },
      now,
    );
    expect(await run('get_transactions', transactionParams)).toMatchObject({
      status: 'ok',
      data: { transactions: [{ id: 'usd', amount: 25_000, currency: 'VND' }] },
    });
  });
  it('includes transfers when kind is null', async () => {
    const walletId = randomUUID();
    await createWallet(
      db,
      walletId,
      { name: 'Other wallet', kind: 'cash', initialBalance: 0 },
      now,
    );
    await createTransaction(
      db,
      'transfer',
      {
        kind: 'transfer',
        amount: 50_000,
        walletId: DEFAULT_WALLET_ID,
        toWalletId: walletId,
        occurredOn: '2026-11-02',
        occurredAt: '2026-11-02T10:00:00+07:00',
      },
      now,
    );
    expect(await run('get_transactions', transactionParams)).toMatchObject({
      status: 'ok',
      data: { transactions: [{ kind: 'transfer' }] },
    });
  });
});

describe('calculate_budget_status', () => {
  it.each([
    [3_500_000, 0, 500_000],
    [2_000_000, 1_000_000, 0],
  ])(
    'uses actual spent %i rather than capping it at the budget',
    async (spent, remaining, overspent) => {
      await createBudget(
        db,
        'budget',
        { amount: 3_000_000, startMonth: '2026-11' },
        now,
      );
      await addTransaction(spent);
      expect(
        await run('calculate_budget_status', {
          month: '2026-11',
          budget_id: null,
        }),
      ).toEqual({
        status: 'ok',
        stateRevision: 1,
        calculationVersion: CALCULATION_VERSION,
        data: {
          budgets: [
            {
              id: 'budget',
              category_id: null,
              limit_amount: 3_000_000,
              spent_amount: spent,
              remaining_amount: remaining,
              overspent_amount: overspent,
            },
          ],
        },
      });
    },
  );
  it.each(['2026-1', '2026-13'])('rejects invalid month %s', async (month) => {
    expect(
      await run('calculate_budget_status', { month, budget_id: null }),
    ).toEqual({ status: 'error', code: 'INVALID_PARAMS', retryable: false });
  });
  it('returns no budgets for an unknown id', async () => {
    expect(
      await run('calculate_budget_status', {
        month: '2026-11',
        budget_id: 'missing',
      }),
    ).toMatchObject({ status: 'ok', data: { budgets: [] } });
  });
  it.each(['inactive', 'out-of-period', 'custom'] as const)(
    'excludes a requested %s budget',
    async (type) => {
      await createBudget(
        db,
        'budget',
        type === 'custom'
          ? { amount: 3_000_000, periodType: 'custom', startDate: '2026-11-01' }
          : {
              amount: 3_000_000,
              startMonth: type === 'out-of-period' ? '2026-12' : '2026-11',
            },
        now,
      );
      if (type === 'inactive')
        await db.runAsync(
          'UPDATE budgets SET is_active = 0 WHERE id = ?',
          'budget',
        );
      expect(
        await run('calculate_budget_status', {
          month: '2026-11',
          budget_id: 'budget',
        }),
      ).toMatchObject({ status: 'ok', data: { budgets: [] } });
    },
  );
});

describe('plan_savings_goal', () => {
  it('uses the corrected fact and its ancestry without mixing unrelated stored income', async () => {
    const state = adviceStateFixture().state;
    const originalIncome = state.facts[0];
    if (!isMoneyFact(originalIncome)) throw Error('Expected MoneyFact');
    state.facts.push({
      ...originalIncome,
      id: 'unrelated',
      source_message_id: 'other',
      amount: 99_000_000,
    });
    state.facts.push({
      ...originalIncome,
      id: 'corrected',
      source_message_id: 'correction',
      supersedes_id: originalIncome.id,
      amount: 12_000_000,
    });
    for (const slot of [
      state.activeScenario.income,
      state.activeScenario.cashFlowBasis,
    ]) {
      if (slot.status === 'known') {
        slot.factIds = ['corrected'];
        slot.sourceMessageIds = ['correction'];
      }
    }
    if (state.activeScenario.income.status === 'known')
      state.activeScenario.income.value = 12_000_000;
    const before = structuredClone(state);
    expect(await run('plan_savings_goal', {}, state)).toMatchObject({
      status: 'ok',
      data: {
        monthlyAvailable: 2_000_000,
        requiredMonthlySaving: 4_000_000,
        remainingAfterSaving: -2_000_000,
      },
    });
    expect(state).toEqual(before);
  });
  it('keeps USD money in cents rather than treating it as major currency units', async () => {
    const state = adviceStateFixture().state;
    state.activeScenario.currency = 'USD';
    for (const fact of state.facts) {
      if (isMoneyFact(fact)) {
        fact.currency = 'USD';
        fact.amount /= 100;
      }
    }
    for (const field of [
      'income',
      'expenseTotal',
      'goalTarget',
      'savingsForGoal',
    ] as const) {
      const slot = state.activeScenario[field];
      if (slot.status === 'known') slot.value /= 100;
    }
    expect(await run('plan_savings_goal', {}, state)).toMatchObject({
      status: 'ok',
      data: {
        monthlyAvailable: 50_000,
        requiredMonthlySaving: 40_000,
        remainingAfterSaving: 10_000,
        goalAmount: 240_000,
      },
    });
  });
  it('uses explicit zero, produces independent expected values and agrees with the domain calculator', async () => {
    const state = adviceStateFixture().state;
    const before = structuredClone(state);
    const result = await run('plan_savings_goal', {}, state);
    expect(result).toEqual({
      status: 'ok',
      stateRevision: 1,
      calculationVersion: CALCULATION_VERSION,
      data: {
        monthlyAvailable: 5_000_000,
        requiredMonthlySaving: 4_000_000,
        remainingAfterSaving: 1_000_000,
        months: 6,
        goalAmount: 24_000_000,
        savingsForGoal: 0,
      },
    });
    const normalized = normalizeAdviceInputs(state.facts, null, {
      currency: 'VND',
      mode: 'actual',
      cashFlowBasis: 'monthly',
      savingsForGoal: 0,
      savingsMonths: 6,
    });
    if (!normalized.ok) throw Error('Expected valid domain inputs');
    const calculated = calculateAdviceInputs(normalized.result);
    expect(result).toMatchObject({
      data: {
        monthlyAvailable: calculated.surplusBeforeGoal,
        requiredMonthlySaving: calculated.requiredMonthlySaving,
        remainingAfterSaving: calculated.remainingAfterGoal,
      },
    });
    expect(state).toEqual(before);
  });
  it.each([
    'savingsForGoal',
    'savingsMonths',
    'income',
    'expenseTotal',
    'goalTarget',
  ] as const)(
    'asks for unknown %s even when unreferenced facts remain stored',
    async (field) => {
      const state = adviceStateFixture().state;
      state.activeScenario[field] = { status: 'unknown' };
      expect(await run('plan_savings_goal', {}, state)).toEqual({
        status: 'needs_clarification',
        fields: [field],
      });
    },
  );
  it('rejects invented arguments', async () => {
    expect(await run('plan_savings_goal', { income: 20_000_000 })).toEqual({
      status: 'error',
      code: 'INVALID_PARAMS',
      retryable: false,
    });
  });
  it('rejects missing state', async () => {
    expect(
      await executeTool('plan_savings_goal', {}, tools, {
        ...baseContext,
        deadline: Date.now() + 1_500,
      }),
    ).toEqual({ status: 'error', code: 'STATE_ERROR', retryable: false });
  });
  it('rejects a mismatched session or stale state revision', async () => {
    for (const overrides of [{ sessionId: 'other' }, { stateRevision: 2 }]) {
      expect(
        await executeTool('plan_savings_goal', {}, tools, {
          ...baseContext,
          ...overrides,
          state: adviceStateFixture().state,
          deadline: Date.now() + 1_500,
        }),
      ).toEqual({ status: 'error', code: 'STATE_ERROR', retryable: false });
    }
  });
  it('rejects a slot value that disagrees with its referenced financial fact', async () => {
    const state = adviceStateFixture().state;
    if (state.activeScenario.income.status === 'known')
      state.activeScenario.income.value = 12_000_000;
    expect(await run('plan_savings_goal', {}, state)).toEqual({
      status: 'error',
      code: 'STATE_ERROR',
      retryable: false,
    });
  });
});

describe('get_financial_snapshot', () => {
  it('returns only requested fields from six complete months', async () => {
    await populateHistory();
    expect(
      await run('get_financial_snapshot', {
        months: 6,
        fields: ['monthly_income_avg', 'monthly_expense_avg'],
      }),
    ).toEqual({
      status: 'ok',
      stateRevision: 1,
      calculationVersion: CALCULATION_VERSION,
      data: {
        indicators: {
          monthly_income_avg: 15_000_000,
          monthly_expense_avg: 10_000_000,
        },
        period: { from: '2026-05-01', to: '2026-10-31' },
        currency: 'VND',
        dataQuality: 'complete',
      },
    });
  });
  it('uses current liquid balance, including the current month, without averaging', async () => {
    await populateHistory();
    await addTransaction(2_000_000, '2026-11-02', 'income');
    expect(
      await run('get_financial_snapshot', {
        months: 6,
        fields: ['liquid_balance'],
      }),
    ).toMatchObject({
      status: 'ok',
      data: { indicators: { liquid_balance: 32_000_000 } },
    });
  });
  it.each([
    { months: 0, fields: ['liquid_balance'] },
    { months: 13, fields: ['liquid_balance'] },
    { months: 6, fields: [] },
    { months: 6, fields: ['unknown'] },
  ])('rejects invalid snapshot parameters %#', async (params) => {
    expect(await run('get_financial_snapshot', params)).toEqual({
      status: 'error',
      code: 'INVALID_PARAMS',
      retryable: false,
    });
  });
  it('marks incomplete coverage as partial', async () => {
    await populateHistory(9);
    expect(
      await run('get_financial_snapshot', {
        months: 6,
        fields: ['months_with_data'],
      }),
    ).toMatchObject({
      status: 'ok',
      data: { indicators: { months_with_data: 2 }, dataQuality: 'partial' },
    });
  });
  it('keeps missing averages unknown while preserving current wallet balance', async () => {
    await createWallet(
      db,
      randomUUID(),
      { name: 'Savings', kind: 'cash', initialBalance: 4_000_000 },
      now,
    );
    expect(
      await run('get_financial_snapshot', {
        months: 6,
        fields: [
          'monthly_income_avg',
          'monthly_expense_avg',
          'liquid_balance',
          'months_with_data',
        ],
      }),
    ).toMatchObject({
      status: 'ok',
      data: {
        indicators: {
          monthly_income_avg: null,
          monthly_expense_avg: null,
          liquid_balance: 4_000_000,
          months_with_data: 0,
        },
        dataQuality: 'insufficient',
      },
    });
  });
});

describe('dispatcher', () => {
  it.each([
    ['get_transactions', transactionParams],
    ['calculate_budget_status', { month: '2026-11' }],
    ['plan_savings_goal', {}],
    ['get_financial_snapshot', { months: 6, fields: ['liquid_balance'] }],
  ])('preserves the caller revision for %s', async (tool, params) => {
    const state = adviceStateFixture().state;
    state.revision = 7;
    expect(
      await executeTool(tool, params, tools, {
        ...baseContext,
        stateRevision: 7,
        state,
        deadline: Date.now() + 1_500,
      }),
    ).toMatchObject({
      status: 'ok',
      stateRevision: 7,
      calculationVersion: CALCULATION_VERSION,
    });
  });
  it.each([
    ['get_transactions', { ...transactionParams, unexpected: 1 }],
    ['calculate_budget_status', { month: '2026-11', unexpected: 1 }],
    ['plan_savings_goal', null],
    [
      'get_financial_snapshot',
      { months: 6, fields: ['liquid_balance', 'liquid_balance'] },
    ],
  ])(
    'rejects schema violations for %s before any SQLite read',
    async (tool, params) => {
      const read = vi.spyOn(db, 'getAllAsync');
      expect(await run(tool, params)).toEqual({
        status: 'error',
        code: 'INVALID_PARAMS',
        retryable: false,
      });
      expect(read).not.toHaveBeenCalled();
    },
  );
  it('rejects an invalid deadline instead of allowing a NaN bypass', async () => {
    expect(
      await executeTool('get_transactions', transactionParams, tools, {
        ...baseContext,
        deadline: NaN,
      }),
    ).toEqual({ status: 'error', code: 'STATE_ERROR', retryable: false });
  });
  it('denies tools outside the allowlist before reading data', async () => {
    const read = vi.spyOn(db, 'getAllAsync');
    expect(
      await executeTool('get_transactions', transactionParams, [], {
        ...baseContext,
        deadline: Date.now() + 1_500,
      }),
    ).toEqual({ status: 'error', code: 'TOOL_NOT_ALLOWED', retryable: false });
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects unknown tools even if a caller lists them', async () => {
    expect(
      await executeTool('invented', {}, ['invented'], {
        ...baseContext,
        deadline: Date.now() + 1_500,
      }),
    ).toEqual({ status: 'error', code: 'TOOL_NOT_ALLOWED', retryable: false });
  });
  it('rejects an expired deadline before reading data', async () => {
    const read = vi.spyOn(db, 'getAllAsync');
    expect(
      await executeTool('get_transactions', transactionParams, tools, {
        ...baseContext,
        deadline: Date.now() - 1,
      }),
    ).toEqual({ status: 'error', code: 'TIMEOUT', retryable: false });
    expect(read).not.toHaveBeenCalled();
  });
  it('discards results exceeding the local 1.5 second budget after the call', async () => {
    const read = db.getAllAsync.bind(db);
    vi.spyOn(db, 'getAllAsync').mockImplementation(async (...args) => {
      const result = await read(...args);
      vi.setSystemTime(Date.now() + 1_501);
      return result;
    });
    expect(await run('get_transactions', transactionParams)).toEqual({
      status: 'error',
      code: 'TIMEOUT',
      retryable: false,
    });
  });
  it('turns a failed SQLite read into DATA_ERROR without exposing its message', async () => {
    vi.spyOn(db, 'getAllAsync').mockRejectedValue(
      new Error('private database error'),
    );
    expect(await run('get_transactions', transactionParams)).toEqual({
      status: 'error',
      code: 'DATA_ERROR',
      retryable: false,
    });
  });
});
