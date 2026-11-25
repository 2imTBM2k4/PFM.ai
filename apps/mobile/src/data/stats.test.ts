import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { createCategory, listCategories } from './categories';
import { createDebt } from './debts';
import { migrate, type Database } from './migrate';
import { DEFAULT_WALLET_ID, seed } from './seed';
import {
  readCalendarDayTransactions,
  readCalendarMonthData,
  readCashFlowCategoryComparison,
  readCashFlowTrend,
  readIncomeExpenseSituation,
} from './stats';
import { createTransaction } from './transactions';
import { createWallet } from './wallets';

describe('stats repository SQLite integration', () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    db = {
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
      transaction: async (task) => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          await task(db);
          sqlite.exec('COMMIT');
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    };
    await migrate(db);
    await seed(db, '2026-01-01T00:00:00Z');
  });

  async function addTx(input: {
    kind: 'expense' | 'income' | 'transfer';
    amount: number;
    occurredOn: string;
    walletId?: string;
    toWalletId?: string | null;
    categoryId?: string | null;
    note?: string | null;
  }) {
    await createTransaction(
      db,
      randomUUID(),
      {
        kind: input.kind,
        amount: input.amount,
        walletId: input.walletId ?? DEFAULT_WALLET_ID,
        toWalletId: input.toWalletId ?? null,
        categoryId: input.categoryId ?? null,
        debtId: null,
        occurredOn: input.occurredOn,
        occurredAt: `${input.occurredOn}T10:00:00+07:00`,
        note: input.note ?? null,
        source: 'manual',
        recurringRuleId: null,
        rawInput: null,
      },
      `${input.occurredOn}T10:00:00Z`,
    );
  }

  it('computes MTD same-period comparison with February clamping and parent category rollups for both expense and income', async () => {
    const categories = await listCategories(db, true);
    const coffee = categories.find((c) => c.system_key === 'expense.food.coffee');
    const eatingOut = categories.find(
      (c) => c.system_key === 'expense.food.eating_out',
    );
    const salary = categories.find((c) => c.system_key === 'income.salary');
    const invest = categories.find(
      (c) => c.system_key === 'income.investment',
    );

    const secondWalletId = randomUUID();
    await createWallet(
      db,
      secondWalletId,
      { name: 'Bank', kind: 'bank', initialBalance: 10_000_000 },
      '2026-01-01T00:00:00Z',
    );

    // February (non-leap 2026, 28 days)
    await addTx({
      kind: 'expense',
      amount: 400_000,
      occurredOn: '2026-02-10',
      categoryId: coffee?.id,
    });
    await addTx({
      kind: 'expense',
      amount: 600_000,
      occurredOn: '2026-02-28',
      categoryId: eatingOut?.id,
    });
    await addTx({
      kind: 'income',
      amount: 15_000_000,
      occurredOn: '2026-02-05',
      categoryId: salary?.id,
    });

    // March 2026 (current month viewed at 2026-03-31 -> prev Feb clamps day 31 -> day 28)
    await addTx({
      kind: 'expense',
      amount: 300_000,
      occurredOn: '2026-03-05',
      categoryId: coffee?.id,
    });
    await addTx({
      kind: 'expense',
      amount: 450_000,
      occurredOn: '2026-03-31',
      categoryId: eatingOut?.id,
    });
    await addTx({
      kind: 'income',
      amount: 18_000_000,
      occurredOn: '2026-03-05',
      categoryId: salary?.id,
    });
    await addTx({
      kind: 'income',
      amount: 50_000,
      occurredOn: '2026-03-20',
      categoryId: invest?.id,
    });
    // Transfer should never count toward expense/income totals
    await addTx({
      kind: 'transfer',
      amount: 2_000_000,
      occurredOn: '2026-03-10',
      toWalletId: secondWalletId,
    });

    // View current month as of Mar 15: comparison cutoff uses Mar 1..15 vs Feb 1..15
    const midMonth = await readIncomeExpenseSituation(
      db,
      '2026-03',
      '2026-03-15',
    );
    expect(midMonth.isCurrentMonth).toBe(true);
    expect(midMonth.expenseTotal).toBe(750_000);
    expect(midMonth.incomeTotal).toBe(18_050_000);
    expect(midMonth.currentPeriodExpense).toBe(300_000);
    expect(midMonth.previousPeriodExpense).toBe(400_000);
    expect(midMonth.expenseDelta).toBe(-100_000);
    expect(midMonth.currentPeriodIncome).toBe(18_000_000);
    expect(midMonth.previousPeriodIncome).toBe(15_000_000);
    expect(midMonth.incomeDelta).toBe(3_000_000);

    // Rolled up parent categories
    expect(midMonth.expenseCategories).toEqual([
      expect.objectContaining({
        name: 'Ăn uống',
        systemKey: 'expense.food',
        amount: 750_000,
      }),
    ]);
    expect(midMonth.incomeCategories.map((c) => [c.name, c.amount])).toEqual([
      ['Lương', 18_000_000],
      ['Lãi & đầu tư', 50_000],
    ]);

    // View as of Mar 31: Feb clamps safely to Feb 28 (includes Feb 28's 600k)
    const endMonth = await readIncomeExpenseSituation(
      db,
      '2026-03',
      '2026-03-31',
    );
    expect(endMonth.previousPeriodExpense).toBe(1_000_000);
    expect(endMonth.expenseDelta).toBe(-250_000);

    // Viewing past month (Feb) from May uses full month comparison
    const pastMonth = await readIncomeExpenseSituation(
      db,
      '2026-02',
      '2026-05-10',
    );
    expect(pastMonth.isCurrentMonth).toBe(false);
    expect(pastMonth.expenseTotal).toBe(1_000_000);
    expect(pastMonth.previousPeriodExpense).toBe(0);
  });

  it('aggregates rolling 6-week, 6-month, and 2-year trends with exact same-period cutoffs', async () => {
    // Anchor: Friday 2026-11-13 (weekday offset = 4, day 13 of month, Nov 13 of year)
    await addTx({ kind: 'income', amount: 4_600_000, occurredOn: '2026-10-05' }); // W0 Mon..Fri
    await addTx({ kind: 'income', amount: 2_200_000, occurredOn: '2026-10-10' }); // W0 Saturday (after Fri cutoff)
    await addTx({ kind: 'expense', amount: 4_500_000, occurredOn: '2026-10-05' });
    await addTx({ kind: 'income', amount: 7_052_668, occurredOn: '2026-10-11' }); // Oct day 11 (<= day 13)
    await addTx({ kind: 'income', amount: 1_600_000, occurredOn: '2026-10-14' }); // Oct day 14 (> day 13)
    await addTx({ kind: 'expense', amount: 4_925_000, occurredOn: '2026-10-06' }); // Oct day 6 (<= day 13)
    await addTx({ kind: 'expense', amount: 1_600_000, occurredOn: '2026-10-15' }); // Oct day 15 (> day 13)
    await addTx({ kind: 'income', amount: 6_083_562, occurredOn: '2025-11-13' }); // Same day last year
    await addTx({ kind: 'income', amount: 200_000, occurredOn: '2025-12-01' }); // After Nov 13 last year
    await addTx({ kind: 'expense', amount: 2_000_000, occurredOn: '2024-06-01' }); // Baseline year 2024
    await addTx({ kind: 'expense', amount: 500_000, occurredOn: '2024-12-20' }); // After Nov 13 in 2024

    // Week: 6 rolling weeks ending at Tuần này (2026-11-09..2026-11-15)
    const weekTrend = await readCashFlowTrend(db, 'week', '2026-11-13');
    expect(weekTrend.points).toHaveLength(6);
    expect(weekTrend.points.map((p) => p.label)).toEqual([
      '05 - 11',
      '12 - 18',
      '19 - 25',
      '26/10 - 01/11',
      '02 - 08',
      'Tuần này',
    ]);
    expect(weekTrend.points[0].income).toBe(4_600_000 + 2_200_000 + 7_052_668);
    expect(weekTrend.points[0].samePeriodIncome).toBe(4_600_000); // Mon..Fri only (before Sat Oct 10)
    expect(weekTrend.points[5].badgePrimary).toBe('09 - 15');
    expect(weekTrend.points[5].badgeSecondary).toBe('Tháng 11');
    expect(weekTrend.points[5].calloutDateLabel).toBe('13/11/2026');

    // Month: 6 rolling months (T6..T10, Tháng này) - no 12-month year list
    const monthTrend = await readCashFlowTrend(db, 'month', '2026-11-13');
    expect(monthTrend.points).toHaveLength(6);
    expect(monthTrend.points.map((p) => p.label)).toEqual([
      'T6',
      'T7',
      'T8',
      'T9',
      'T10',
      'Tháng này',
    ]);
    const octPoint = monthTrend.points[4];
    expect(octPoint.samePeriodIncome).toBe(4_600_000 + 2_200_000 + 7_052_668);
    expect(octPoint.income).toBe(4_600_000 + 2_200_000 + 7_052_668 + 1_600_000);
    expect(octPoint.samePeriodExpense).toBe(4_500_000 + 4_925_000);
    expect(octPoint.expense).toBe(4_500_000 + 4_925_000 + 1_600_000);
    expect(monthTrend.points[5].badgePrimary).toBe('11');
    expect(monthTrend.points[5].badgeSecondary).toBe('2026');

    // Rolling month crosses year boundary cleanly (e.g. Feb 2026 -> Sep 2025..Feb 2026)
    const crossYearMonths = await readCashFlowTrend(db, 'month', '2026-02-28', {
      monthPrefix: 'M',
      thisMonthLabel: 'This month',
    });
    expect(crossYearMonths.points.map((p) => p.label)).toEqual([
      'M9',
      'M10',
      'M11',
      'M12',
      'M1',
      'This month',
    ]);

    // Year: 2 consecutive years + baseline 2024
    const yearTrend = await readCashFlowTrend(db, 'year', '2026-11-13');
    expect(yearTrend.points).toHaveLength(2);
    expect(yearTrend.points.map((p) => p.label)).toEqual([
      'Năm 2025',
      'Năm nay',
    ]);
    expect(yearTrend.points[0].samePeriodIncome).toBe(6_083_562);
    expect(yearTrend.points[0].income).toBe(6_083_562 + 200_000);
    expect(yearTrend.baselinePreviousPoint.key).toBe('2024');
    expect(yearTrend.baselinePreviousPoint.samePeriodExpense).toBe(2_000_000);
    expect(yearTrend.baselinePreviousPoint.expense).toBe(2_500_000);

    // Leap year clamping: 2024-02-29 compares against 2023-02-28 safely
    const leapYearTrend = await readCashFlowTrend(db, 'year', '2024-02-29');
    expect(leapYearTrend.points[0].samePeriodEndDate).toBe('2023-02-28');
    expect(leapYearTrend.points[1].samePeriodEndDate).toBe('2024-02-29');
  });

  it('compares categories at both child and parent rollup levels against prior same period', async () => {
    const categories = await listCategories(db, true);
    const foodParent = categories.find((c) => c.system_key === 'expense.food')!;
    const coffeeChildId = randomUUID();
    const lunchChildId = randomUUID();
    await createCategory(
      db,
      coffeeChildId,
      {
        name: 'Coffee',
        kind: 'expense',
        parentId: foodParent.id,
        icon: 'tag',
        color: '#8855A5',
      },
      '2026-01-01T00:00:00Z',
    );
    await createCategory(
      db,
      lunchChildId,
      {
        name: 'Lunch',
        kind: 'expense',
        parentId: foodParent.id,
        icon: 'food',
        color: '#A35319',
      },
      '2026-01-01T00:00:00Z',
    );

    // Previous same-period (2025-01-01..2025-11-13)
    await addTx({ kind: 'expense', amount: 100_000, occurredOn: '2025-05-01', categoryId: coffeeChildId });
    await addTx({ kind: 'expense', amount: 50_000, occurredOn: '2025-12-01', categoryId: coffeeChildId }); // outside prev range!

    // Current same-period (2026-01-01..2026-11-13)
    await addTx({ kind: 'expense', amount: 250_000, occurredOn: '2026-11-01', categoryId: coffeeChildId });
    await addTx({ kind: 'expense', amount: 400_000, occurredOn: '2026-11-02', categoryId: lunchChildId });

    const cur = { startDate: '2026-01-01', endDate: '2026-11-13' };
    const prev = { startDate: '2025-01-01', endDate: '2025-11-13' };

    const childRows = await readCashFlowCategoryComparison(db, 'expense', cur, prev, 'child');
    expect(childRows).toHaveLength(2);
    expect(childRows[0]).toMatchObject({
      id: lunchChildId,
      name: 'Lunch',
      amount: 400_000,
      previousAmount: 0,
      delta: 400_000,
    });
    expect(childRows[1]).toMatchObject({
      id: coffeeChildId,
      name: 'Coffee',
      amount: 250_000,
      previousAmount: 100_000,
      delta: 150_000,
    });

    const parentRows = await readCashFlowCategoryComparison(db, 'expense', cur, prev, 'parent');
    expect(parentRows).toHaveLength(1);
    expect(parentRows[0]).toMatchObject({
      id: foodParent.id,
      amount: 650_000,
      previousAmount: 100_000,
      delta: 550_000,
    });
  });

  it('lists day transactions without truncation, excludes transfers/debts from cash-flow totals, and supports calendar filters', async () => {
    const categories = await listCategories(db, true);
    const business = categories.find(
      (c) => c.system_key === 'income.business',
    );
    const invest = categories.find(
      (c) => c.system_key === 'income.investment',
    );
    const secondWalletId = randomUUID();
    await createWallet(
      db,
      secondWalletId,
      { name: 'MBBank', kind: 'bank', initialBalance: 5_000_000 },
      '2026-10-01T00:00:00Z',
    );

    await addTx({
      kind: 'income',
      amount: 85_999,
      occurredOn: '2026-10-04',
      categoryId: business?.id,
      note: 'Nhận tiền',
    });
    await addTx({
      kind: 'income',
      amount: 1,
      occurredOn: '2026-10-04',
      categoryId: invest?.id,
      note: 'Tiền lời',
    });
    await addTx({
      kind: 'transfer',
      amount: 100_000,
      occurredOn: '2026-10-04',
      toWalletId: secondWalletId,
      note: 'Chuyển đến MBBank',
    });
    await createDebt(
      db,
      randomUUID(),
      randomUUID(),
      {
        direction: 'borrowed',
        counterpartyLabel: 'Minh',
        amount: 200_000,
        walletId: DEFAULT_WALLET_ID,
        occurredOn: '2026-10-04',
        note: 'Vay tạm',
      },
      '2026-10-04T09:00:00Z',
    );
    await addTx({
      kind: 'expense',
      amount: 300_000,
      occurredOn: '2026-10-01',
      walletId: secondWalletId,
    });

    const monthAll = await readCalendarMonthData(db, '2026-10');
    expect(monthAll.totalIncome).toBe(86_000);
    expect(monthAll.totalExpense).toBe(300_000);
    expect(monthAll.totalNet).toBe(-214_000);
    expect(monthAll.dailyTotals['2026-10-04']).toEqual({
      date: '2026-10-04',
      income: 86_000,
      expense: 0,
    });

    const dayAll = await readCalendarDayTransactions(db, '2026-10-04');
    expect(dayAll.rows).toHaveLength(4);
    expect(dayAll.dayIncome).toBe(86_000);
    expect(dayAll.dayExpense).toBe(0);

    // Transfer & debt filters
    const transferOnlyMonth = await readCalendarMonthData(db, '2026-10', {
      kind: 'transfer',
    });
    expect(transferOnlyMonth.activityDates['2026-10-04']).toBe(true);
    expect(transferOnlyMonth.totalIncome).toBe(0);

    const debtDay = await readCalendarDayTransactions(db, '2026-10-04', {
      kind: 'debt',
    });
    expect(debtDay.rows).toHaveLength(1);
    expect(debtDay.rows[0].kind).toBe('debt_borrow');
    expect(debtDay.dayIncome).toBe(0);

    // Wallet filter sees transfer targeting secondWalletId
    const bankDay = await readCalendarDayTransactions(db, '2026-10-04', {
      walletId: secondWalletId,
    });
    expect(bankDay.rows).toHaveLength(1);
    expect(bankDay.rows[0].kind).toBe('transfer');

    // Verify >50 transactions on a single day are not truncated
    for (let i = 0; i < 55; i++) {
      await addTx({
        kind: 'expense',
        amount: 1_000,
        occurredOn: '2026-10-15',
        note: `Item ${i}`,
      });
    }
    const busyDay = await readCalendarDayTransactions(db, '2026-10-15');
    expect(busyDay.rows).toHaveLength(55);
    expect(busyDay.dayExpense).toBe(55_000);
  });
});
