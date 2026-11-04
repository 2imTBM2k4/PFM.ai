import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdviceDateRange } from '@pfm/domain';

import {
  BASELINE_MONTHS,
  HABIT_CHILD_LIMIT,
  HABIT_PARENT_LIMIT,
  SMALL_SPEND_THRESHOLD_VND,
  previousWindow,
  readPersonalBaseline,
  readSpendingHabits,
  spendingHabitsGroup,
} from './advice-habits';
import { migrate, type Database } from './migrate';
import { seed } from './seed';

const WALLET = '00000000-0000-4000-8000-000000000001';
const OTHER_WALLET = '00000000-0000-4000-8000-000000000002';

const window = (from: string, to: string): AdviceDateRange => ({
  kind: 'last_30_days',
  from,
  to,
});

describe('advice habits SQLite integration', () => {
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
    await db.runAsync(
      `INSERT INTO wallets (id, name, kind, created_at, updated_at)
       VALUES (?, 'Ngân hàng', 'bank', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      OTHER_WALLET,
    );
  });

  async function categoryId(systemKey: string): Promise<string> {
    const row = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM categories WHERE system_key = ?',
      systemKey,
    );
    if (!row) throw new Error(`missing ${systemKey}`);
    return row.id;
  }

  async function addExpense(
    amount: number,
    occurredOn: string,
    systemKey: string | null,
    kind: 'expense' | 'transfer' | 'debt_repay_paid' = 'expense',
  ): Promise<void> {
    const debtId = randomUUID();
    if (kind === 'debt_repay_paid') {
      await db.runAsync(
        `INSERT INTO debts (id, counterparty_label, direction, status, created_at, updated_at)
         VALUES (?, 'Hùng', 'borrowed', 'open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        debtId,
      );
    }
    await db.runAsync(
      `INSERT INTO transactions
         (id, kind, amount, original_currency, original_amount_minor, wallet_id, to_wallet_id, category_id, debt_id,
          occurred_on, occurred_at, source, created_at, updated_at)
       VALUES (?, ?, ?, 'VND', ?, ?, ?, ?, ?, ?, ?, 'manual', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      randomUUID(),
      kind,
      amount,
      amount,
      WALLET,
      kind === 'transfer' ? OTHER_WALLET : null,
      systemKey ? await categoryId(systemKey) : null,
      kind === 'debt_repay_paid' ? debtId : null,
      occurredOn,
      `${occurredOn}T10:00:00+07:00`,
    );
  }

  it('counts frequency, average and largest spend for a habit', async () => {
    for (const day of ['2026-10-30', '2026-11-01', '2026-11-02']) {
      await addExpense(100_000, day, 'expense.food.eating_out');
    }
    await addExpense(450_000, '2026-11-03', 'expense.food.eating_out');
    await addExpense(3_500_000, '2026-11-01', 'expense.housing.rent');

    const habits = await readSpendingHabits(db, window('2026-10-29', '2026-11-04'));

    expect(habits.transactionCount).toBe(5);
    expect(habits.totalExpense).toBe(4_250_000);
    const food = habits.parents.find((parent) => parent.name === 'Ăn uống');
    expect(food).toMatchObject({
      amount: 750_000,
      count: 4,
      avgTicket: 187_500,
      largestTicket: 450_000,
      isFlexible: true,
    });
  });

  it('exposes the child categories behind the biggest parents', async () => {
    await addExpense(1_400_000, '2026-11-01', 'expense.food.eating_out');
    await addExpense(300_000, '2026-11-02', 'expense.food.eating_out');
    await addExpense(700_000, '2026-11-02', 'expense.food.groceries');

    const habits = await readSpendingHabits(db, window('2026-10-29', '2026-11-04'));
    const food = habits.parents.find((parent) => parent.name === 'Ăn uống');
    expect(food?.children).toEqual([
      {
        name: 'Ăn ngoài',
        amount: 1_700_000,
        count: 2,
        avgTicket: 850_000,
      },
      {
        name: 'Đi chợ & siêu thị',
        amount: 700_000,
        count: 1,
        avgTicket: 700_000,
      },
    ]);
  });

  it('separates committed costs from flexible spending', async () => {
    await addExpense(3_500_000, '2026-11-01', 'expense.housing.rent');
    await addExpense(500_000, '2026-11-01', 'expense.housing.utilities');
    await addExpense(800_000, '2026-11-02', 'expense.entertainment');
    await addExpense(200_000, '2026-11-02', 'expense.transport.fuel');

    const habits = await readSpendingHabits(db, window('2026-10-29', '2026-11-04'));
    expect(habits.totalExpense).toBe(5_000_000);
    expect(habits.flexibleAmount).toBe(1_000_000);
    const housing = habits.parents.find((parent) => parent.name === 'Nhà ở');
    expect(housing?.isFlexible).toBe(false);
    expect(
      habits.parents.find((parent) => parent.name === 'Giải trí')?.isFlexible,
    ).toBe(true);
  });

  it('sums small frequent spends separately from one large purchase', async () => {
    for (let index = 0; index < 5; index++) {
      await addExpense(
        SMALL_SPEND_THRESHOLD_VND - 5_000,
        '2026-11-02',
        'expense.food.coffee',
      );
    }
    await addExpense(SMALL_SPEND_THRESHOLD_VND, '2026-11-02', 'expense.food.coffee');
    await addExpense(2_000_000, '2026-11-03', 'expense.shopping');

    const habits = await readSpendingHabits(db, window('2026-10-29', '2026-11-04'));
    expect(habits.smallFrequentCount).toBe(5);
    expect(habits.smallFrequentAmount).toBe(5 * (SMALL_SPEND_THRESHOLD_VND - 5_000));
    // The large shopping purchase is flexible but not "small and frequent".
    expect(habits.smallFrequentAmount).toBeLessThan(
      habits.parents.find((parent) => parent.name === 'Mua sắm')!.amount,
    );
  });

  it('compares with the previous window of the same length', async () => {
    // The previous window is 2026-10-22 → 2026-10-28.
    await addExpense(1_000_000, '2026-10-25', 'expense.food.eating_out');
    await addExpense(2_000_000, '2026-11-02', 'expense.food.eating_out');
    // Outside both windows: must not leak into either comparison.
    await addExpense(7_000_000, '2026-10-15', 'expense.food.eating_out');

    const habits = await readSpendingHabits(db, window('2026-10-29', '2026-11-04'));
    const food = habits.parents.find((parent) => parent.name === 'Ăn uống');
    expect(food?.amount).toBe(2_000_000);
    expect(food?.previousAmount).toBe(1_000_000);
  });

  it('never counts transfers or debt repayment as a spending habit', async () => {
    await addExpense(300_000, '2026-11-02', 'expense.food');
    await addExpense(900_000, '2026-11-02', null, 'transfer');
    await addExpense(500_000, '2026-11-02', null, 'debt_repay_paid');

    const habits = await readSpendingHabits(db, window('2026-10-29', '2026-11-04'));
    expect(habits.totalExpense).toBe(300_000);
    expect(habits.transactionCount).toBe(1);
  });

  it('keeps uncategorized spending in the totals but out of the habit rows', async () => {
    await addExpense(250_000, '2026-11-02', null);
    await addExpense(250_000, '2026-11-02', 'expense.food');

    const habits = await readSpendingHabits(db, window('2026-10-29', '2026-11-04'));
    expect(habits.totalExpense).toBe(500_000);
    expect(habits.parents).toHaveLength(1);
    expect(habits.parents[0].name).toBe('Ăn uống');
    // Uncategorized rows can never be flagged as cuttable.
    expect(habits.flexibleAmount).toBe(250_000);
  });

  it('returns an empty habit profile instead of guessing', async () => {
    const habits = await readSpendingHabits(db, window('2026-10-29', '2026-11-04'));
    expect(habits).toMatchObject({
      transactionCount: 0,
      totalExpense: 0,
      flexibleAmount: 0,
      smallFrequentCount: 0,
      smallFrequentAmount: 0,
      parents: [],
    });
    expect(spendingHabitsGroup(habits).kind).toBe('spending_habits');
  });

  it('caps parents and children to the documented limits', async () => {
    for (let index = 0; index < HABIT_PARENT_LIMIT + 2; index++) {
      const id = randomUUID();
      await db.runAsync(
        `INSERT INTO categories (id, system_key, parent_id, name, kind, is_fixed_cost, sort_order, created_at, updated_at)
         VALUES (?, NULL, NULL, ?, 'expense', 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        id,
        `Nhóm ${index}`,
      );
      await addExpense(1_000_000 - index * 10_000, '2026-11-02', null);
      await db.runAsync(
        'UPDATE transactions SET category_id = ? WHERE category_id IS NULL',
        id,
      );
    }

    const habits = await readSpendingHabits(db, window('2026-10-29', '2026-11-04'));
    expect(habits.parents).toHaveLength(HABIT_PARENT_LIMIT);
    for (const parent of habits.parents) {
      expect(parent.children.length).toBeLessThanOrEqual(HABIT_CHILD_LIMIT);
    }
  });

  it('compares this window with the user own recent months', async () => {
    // Completed months: Aug, Sep, Oct 2026 (today is 2026-11-04).
    for (const month of ['2026-08', '2026-09', '2026-10']) {
      await addExpense(3_000_000, `${month}-10`, 'expense.housing.rent');
      await addExpense(1_000_000, `${month}-12`, 'expense.food');
    }
    await addExpense(3_000_000, '2026-11-01', 'expense.housing.rent');
    await addExpense(3_000_000, '2026-11-02', 'expense.food');

    const baseline = await readPersonalBaseline(
      db,
      window('2026-10-29', '2026-11-04'),
      '2026-11-04',
    );

    expect(baseline.monthsWithData).toBe(3);
    const food = baseline.rows.find((row) => row.name === 'Ăn uống');
    expect(food).toEqual({
      name: 'Ăn uống',
      currentAmount: 3_000_000,
      currentPercent: 50,
      baselineMonthlyAvg: 1_000_000,
      baselinePercent: 25,
    });
    const housing = baseline.rows.find((row) => row.name === 'Nhà ở');
    expect(housing).toMatchObject({ currentPercent: 50, baselinePercent: 75 });
  });

  it('reports no baseline for a brand new user without inventing averages', async () => {
    await addExpense(500_000, '2026-11-02', 'expense.food');
    const baseline = await readPersonalBaseline(
      db,
      window('2026-10-29', '2026-11-04'),
      '2026-11-04',
    );
    expect(baseline.monthsWithData).toBe(0);
    expect(baseline.rows).toEqual([
      {
        name: 'Ăn uống',
        currentAmount: 500_000,
        currentPercent: 100,
        baselineMonthlyAvg: 0,
        baselinePercent: 0,
      },
    ]);
  });

  it('never returns more than five baseline rows or a zero-amount row', async () => {
    for (let index = 0; index < 7; index++) {
      const id = randomUUID();
      await db.runAsync(
        `INSERT INTO categories (id, system_key, parent_id, name, kind, is_fixed_cost, sort_order, created_at, updated_at)
         VALUES (?, NULL, NULL, ?, 'expense', 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        id,
        `Mục ${index}`,
      );
      await addExpense(100_000 + index * 1_000, '2026-11-02', null);
      await db.runAsync(
        'UPDATE transactions SET category_id = ? WHERE category_id IS NULL',
        id,
      );
    }

    const baseline = await readPersonalBaseline(
      db,
      window('2026-10-29', '2026-11-04'),
      '2026-11-04',
    );
    expect(baseline.rows).toHaveLength(5);
    expect(baseline.rows.every((row) => row.currentAmount > 0)).toBe(true);
    expect(BASELINE_MONTHS).toBe(6);
  });

  it('handles a single transaction and a window that starts at month begin', async () => {
    await addExpense(1_500_000, '2026-11-01', 'expense.shopping');
    const habits = await readSpendingHabits(db, window('2026-11-01', '2026-11-04'));
    expect(habits.parents[0]).toMatchObject({
      amount: 1_500_000,
      count: 1,
      avgTicket: 1_500_000,
      largestTicket: 1_500_000,
    });
  });
});

describe('previousWindow', () => {
  it('returns the same-length window immediately before the range', () => {
    expect(previousWindow({ kind: 'last_7_days', from: '2026-10-29', to: '2026-11-04' }))
      .toEqual({ kind: 'last_7_days', from: '2026-10-22', to: '2026-10-28' });
  });

  it('crosses a month boundary without skipping a day', () => {
    expect(previousWindow({ kind: 'this_month', from: '2026-11-01', to: '2026-11-04' }))
      .toEqual({ kind: 'this_month', from: '2026-10-28', to: '2026-10-31' });
  });
});