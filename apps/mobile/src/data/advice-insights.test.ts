import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  readCashFlow,
  readExpenseByCategory,
  readScheduledDue,
  readClassificationStatus,
} from './advice-insights';
import { migrate, type Database } from './migrate';
import { seed } from './seed';

const WALLET = '00000000-0000-4000-8000-000000000001';
const OTHER_WALLET = '00000000-0000-4000-8000-000000000002';

describe('advice insights SQLite integration', () => {
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
    if (!row) throw new Error(`missing category ${systemKey}`);
    return row.id;
  }

  it('reads due today and overdue schedules without claiming unpaid or mutating any rows', async () => {
    const createRule = async (
      id: string,
      start: string,
      active = 1,
      end: string | null = null,
      category: string | null = null,
      wallet = WALLET,
    ) =>
      db.runAsync(
        `INSERT INTO recurring_rules (id,kind,amount,wallet_id,category_id,frequency,interval_count,start_on,end_on,is_active,created_at,updated_at) VALUES (?,'expense',100,?,?,'monthly',1,?,?,?,'2026-01-01','2026-01-01')`,
        id,
        wallet,
        category,
        start,
        end,
        active,
      );
    await createRule('today', '2026-11-14');
    await createRule('overdue', '2026-11-13');
    await createRule('future', '2026-11-20');
    await createRule('paused', '2026-11-14', 0);
    await createRule('expired', '2026-10-14', 1, '2026-11-01');
    sqlite.exec('PRAGMA foreign_keys = OFF');
    await createRule('missing-category', '2026-11-14', 1, null, 'deleted');
    await createRule('missing-wallet', '2026-11-14', 1, null, null, 'deleted');
    sqlite.exec('PRAGMA foreign_keys = ON');
    const before = sqlite.prepare('SELECT total_changes() AS n').get();
    for (let i = 0; i < 10; i++) {
      expect(await readScheduledDue(db, '2026-11-14', '2026-11-20')).toEqual({
        kind: 'scheduled_due',
        asOf: '2026-11-14',
        through: '2026-11-20',
        totalCount: 3,
        items: [
          {
            kind: 'expense',
            amount: 100,
            dueOn: '2026-11-13',
            status: 'scheduled',
            paymentStatus: 'unknown',
          },
          {
            kind: 'expense',
            amount: 100,
            dueOn: '2026-11-14',
            status: 'scheduled',
            paymentStatus: 'unknown',
          },
          {
            kind: 'expense',
            amount: 100,
            dueOn: '2026-11-20',
            status: 'scheduled',
            paymentStatus: 'unknown',
          },
        ],
      });
    }
    expect(sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(
      await db.getFirstAsync('SELECT COUNT(*) AS n FROM transactions'),
    ).toEqual({ n: 0 });
    expect(
      await db.getFirstAsync('SELECT COUNT(*) AS n FROM recurring_rules'),
    ).toEqual({ n: 7 });
  });

  it('keeps missing classification and local day/week/month boundaries at UTC+7', async () => {
    await addTransaction({
      kind: 'expense',
      amount: 100,
      occurredOn: '2026-10-31',
    });
    await db.runAsync(
      "UPDATE transactions SET occurred_at='2026-10-31T23:59:00+07:00'",
    );
    await addTransaction({
      kind: 'expense',
      amount: 200,
      occurredOn: '2026-11-01',
    });
    await addTransaction({
      kind: 'expense',
      amount: 400,
      occurredOn: '2026-11-02',
    });
    expect(
      (await readCashFlow(db, '2026-10-31', '2026-10-31')).totalExpense,
    ).toBe(100);
    expect(
      (await readCashFlow(db, '2026-10-26', '2026-11-01')).totalExpense,
    ).toBe(300);
    expect(
      (await readCashFlow(db, '2026-11-01', '2026-11-30')).totalExpense,
    ).toBe(600);
    expect(
      await readClassificationStatus(db, '2026-11-01', '2026-11-30'),
    ).toEqual({
      expenseCount: 2,
      expenseAmount: 600,
      incomeCount: 0,
      incomeAmount: 0,
    });
  });

  it('does not present skipped or already generated occurrences as pending schedules', async () => {
    await db.runAsync(
      `INSERT INTO recurring_rules (id,kind,amount,wallet_id,frequency,interval_count,start_on,created_at,updated_at) VALUES ('skip-rule','expense',100,?,'daily',1,'2026-11-13','2026-01-01','2026-01-01')`,
      WALLET,
    );
    await db.runAsync(
      "INSERT INTO recurring_skips (recurring_rule_id,occurred_on) VALUES ('skip-rule','2026-11-13')",
    );
    await addTransaction({
      kind: 'expense',
      amount: 100,
      occurredOn: '2026-11-14',
    });
    await db.runAsync("UPDATE transactions SET recurring_rule_id='skip-rule'");
    expect(
      await readScheduledDue(db, '2026-11-14', '2026-11-15'),
    ).toMatchObject({ totalCount: 1, items: [{ dueOn: '2026-11-15' }] });
  });

  async function addCategory(
    name: string,
    parentId: string | null,
    kind: 'expense' | 'income' = 'expense',
  ): Promise<string> {
    const id = randomUUID();
    await db.runAsync(
      `INSERT INTO categories (id, system_key, parent_id, name, kind, is_fixed_cost, sort_order, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      id,
      parentId,
      name,
      kind,
    );
    return id;
  }

  async function addTransaction(transaction: {
    kind: 'expense' | 'income' | 'transfer' | 'debt_repay_paid' | 'debt_borrow';
    amount: number;
    occurredOn: string;
    categoryId?: string | null;
    walletId?: string;
    toWalletId?: string;
    debtId?: string;
  }): Promise<void> {
    const id = randomUUID();
    await db.runAsync(
      `INSERT INTO transactions
         (id, kind, amount, original_currency, original_amount_minor, wallet_id, to_wallet_id, category_id, debt_id,
          occurred_on, occurred_at, source, created_at, updated_at)
       VALUES (?, ?, ?, 'VND', ?, ?, ?, ?, ?, ?, ?, 'manual', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      id,
      transaction.kind,
      transaction.amount,
      transaction.amount,
      transaction.walletId ?? WALLET,
      transaction.toWalletId ?? null,
      transaction.categoryId ?? null,
      transaction.debtId ?? null,
      transaction.occurredOn,
      `${transaction.occurredOn}T10:00:00+07:00`,
    );
  }

  it('returns an empty breakdown without inventing habits from zero data', async () => {
    expect(await readExpenseByCategory(db, '2026-10-29', '2026-11-04')).toEqual(
      {
        totalExpense: 0,
        topCategories: [],
        otherAmount: 0,
        uncategorizedAmount: 0,
        uncategorizedCount: 0,
        transactionCount: 0,
        hasData: false,
      },
    );
    expect(await readCashFlow(db, '2026-10-29', '2026-11-04')).toEqual({
      totalIncome: 0,
      totalExpense: 0,
      net: 0,
      incomeCount: 0,
      expenseCount: 0,
      hasData: false,
    });
  });

  it('rolls child categories into their parent and matches the total expense', async () => {
    const food = await categoryId('expense.food');
    const eatingOut = await categoryId('expense.food.eating_out');
    const coffee = await categoryId('expense.food.coffee');
    const transport = await categoryId('expense.transport');
    const fuel = await categoryId('expense.transport.fuel');
    const shopping = await categoryId('expense.shopping');

    await addTransaction({
      kind: 'expense',
      amount: 300_000,
      occurredOn: '2026-10-29',
      categoryId: eatingOut,
    });
    await addTransaction({
      kind: 'expense',
      amount: 50_000,
      occurredOn: '2026-10-30',
      categoryId: coffee,
    });
    await addTransaction({
      kind: 'expense',
      amount: 45_000,
      occurredOn: '2026-11-01',
      categoryId: food,
    });
    await addTransaction({
      kind: 'expense',
      amount: 120_000,
      occurredOn: '2026-11-02',
      categoryId: fuel,
    });
    await addTransaction({
      kind: 'expense',
      amount: 60_000,
      occurredOn: '2026-11-03',
      categoryId: transport,
    });
    await addTransaction({
      kind: 'expense',
      amount: 80_000,
      occurredOn: '2026-11-04',
      categoryId: shopping,
    });

    const result = await readExpenseByCategory(db, '2026-10-29', '2026-11-04');
    expect(result.totalExpense).toBe(655_000);
    expect(result.transactionCount).toBe(6);
    expect(result.topCategories).toEqual([
      { name: 'Ăn uống', systemKey: 'expense.food', amount: 395_000 },
      { name: 'Di chuyển', systemKey: 'expense.transport', amount: 180_000 },
      { name: 'Mua sắm', systemKey: 'expense.shopping', amount: 80_000 },
    ]);
    const grouped =
      result.topCategories.reduce((sum, item) => sum + item.amount, 0) +
      result.otherAmount;
    expect(grouped).toBe(result.totalExpense);
  });

  it('counts boundary days and never counts future transactions', async () => {
    const food = await categoryId('expense.food');
    await addTransaction({
      kind: 'expense',
      amount: 10_000,
      occurredOn: '2026-10-28',
      categoryId: food,
    });
    await addTransaction({
      kind: 'expense',
      amount: 20_000,
      occurredOn: '2026-10-29',
      categoryId: food,
    });
    await addTransaction({
      kind: 'expense',
      amount: 30_000,
      occurredOn: '2026-11-04',
      categoryId: food,
    });
    await addTransaction({
      kind: 'expense',
      amount: 40_000,
      occurredOn: '2026-11-05',
      categoryId: food,
    });

    const result = await readExpenseByCategory(db, '2026-10-29', '2026-11-04');
    expect(result.totalExpense).toBe(50_000);
    expect(result.transactionCount).toBe(2);
  });

  it('groups custom, uncategorized and overflow categories without double counting', async () => {
    const custom = await addCategory('Học phí của con', null);
    for (let index = 0; index < 6; index++) {
      await addTransaction({
        kind: 'expense',
        amount: (index + 1) * 100_000,
        occurredOn: '2026-11-02',
        categoryId: custom,
      });
    }
    await addTransaction({
      kind: 'expense',
      amount: 70_000,
      occurredOn: '2026-11-02',
      categoryId: null,
    });

    const result = await readExpenseByCategory(db, '2026-10-29', '2026-11-04');
    expect(result.topCategories).toEqual([
      { name: 'Học phí của con', systemKey: null, amount: 2_100_000 },
    ]);
    expect(result.uncategorizedAmount).toBe(70_000);
    expect(result.uncategorizedCount).toBe(1);
    expect(result.otherAmount).toBe(70_000);
    expect(
      result.topCategories.reduce((sum, item) => sum + item.amount, 0) +
        result.otherAmount,
    ).toBe(result.totalExpense);
    expect(result.totalExpense).toBe(2_170_000);
  });

  it('keeps only the five largest groups and sums the rest', async () => {
    for (let index = 0; index < 7; index++) {
      const category = await addCategory(`Nhóm ${index}`, null);
      await addTransaction({
        kind: 'expense',
        amount: (7 - index) * 100_000,
        occurredOn: '2026-11-02',
        categoryId: category,
      });
    }
    const result = await readExpenseByCategory(db, '2026-10-29', '2026-11-04');
    expect(result.topCategories.map((item) => item.amount)).toEqual([
      700_000, 600_000, 500_000, 400_000, 300_000,
    ]);
    expect(result.otherAmount).toBe(300_000);
    expect(result.totalExpense).toBe(2_800_000);
  });

  it('never counts transfers or debt repayments as spending', async () => {
    const food = await categoryId('expense.food');
    await addTransaction({
      kind: 'expense',
      amount: 100_000,
      occurredOn: '2026-11-02',
      categoryId: food,
    });
    await addTransaction({
      kind: 'transfer',
      amount: 500_000,
      occurredOn: '2026-11-02',
      walletId: WALLET,
      toWalletId: OTHER_WALLET,
    });
    const debtId = randomUUID();
    await db.runAsync(
      `INSERT INTO debts (id, counterparty_label, direction, status, created_at, updated_at)
       VALUES (?, 'Hùng', 'borrowed', 'open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      debtId,
    );
    await addTransaction({
      kind: 'debt_repay_paid',
      amount: 900_000,
      occurredOn: '2026-11-02',
      debtId,
    });
    await addTransaction({
      kind: 'debt_borrow',
      amount: 2_000_000,
      occurredOn: '2026-11-03',
      debtId,
    });

    const expenses = await readExpenseByCategory(
      db,
      '2026-10-29',
      '2026-11-04',
    );
    expect(expenses.totalExpense).toBe(100_000);
    expect(expenses.transactionCount).toBe(1);

    const flow = await readCashFlow(db, '2026-10-29', '2026-11-04');
    expect(flow.totalExpense).toBe(100_000);
    expect(flow.totalIncome).toBe(0);
    expect(flow.expenseCount).toBe(1);
  });

  it('sums income and expense separately for the same window', async () => {
    const salary = await categoryId('income.salary');
    const food = await categoryId('expense.food');
    const rent = await categoryId('expense.housing.rent');

    await addTransaction({
      kind: 'income',
      amount: 12_000_000,
      occurredOn: '2026-11-01',
      categoryId: salary,
    });
    await addTransaction({
      kind: 'income',
      amount: 3_000_000,
      occurredOn: '2026-11-03',
      categoryId: salary,
    });
    await addTransaction({
      kind: 'expense',
      amount: 4_500_000,
      occurredOn: '2026-11-01',
      categoryId: rent,
    });
    await addTransaction({
      kind: 'expense',
      amount: 500_000,
      occurredOn: '2026-11-04',
      categoryId: food,
    });
    await addTransaction({
      kind: 'income',
      amount: 9_000_000,
      occurredOn: '2026-09-30',
      categoryId: salary,
    });

    expect(await readCashFlow(db, '2026-11-01', '2026-11-04')).toEqual({
      totalIncome: 15_000_000,
      totalExpense: 5_000_000,
      net: 10_000_000,
      incomeCount: 2,
      expenseCount: 2,
      hasData: true,
    });
  });

  it('handles a window with only uncategorized spending', async () => {
    await addTransaction({
      kind: 'expense',
      amount: 250_000,
      occurredOn: '2026-11-02',
      categoryId: null,
    });
    const result = await readExpenseByCategory(db, '2026-10-29', '2026-11-04');
    expect(result.topCategories).toEqual([]);
    expect(result.uncategorizedAmount).toBe(250_000);
    expect(result.otherAmount).toBe(250_000);
    expect(result.totalExpense).toBe(250_000);
    expect(result.hasData).toBe(true);
  });

  it('keeps large totals as safe integers', async () => {
    const shopping = await categoryId('expense.shopping');
    for (let index = 0; index < 3; index++) {
      await addTransaction({
        kind: 'expense',
        amount: 9_000_000_000,
        occurredOn: '2026-11-02',
        categoryId: shopping,
      });
    }
    const result = await readExpenseByCategory(db, '2026-10-29', '2026-11-04');
    expect(result.totalExpense).toBe(27_000_000_000);
    expect(Number.isSafeInteger(result.totalExpense)).toBe(true);
    expect(result.topCategories[0].amount).toBe(27_000_000_000);
  });

  it('does not mix periods across a month boundary', async () => {
    const food = await categoryId('expense.food');
    await addTransaction({
      kind: 'expense',
      amount: 111_000,
      occurredOn: '2026-10-31',
      categoryId: food,
    });
    await addTransaction({
      kind: 'expense',
      amount: 222_000,
      occurredOn: '2026-11-01',
      categoryId: food,
    });

    expect(
      (await readExpenseByCategory(db, '2026-10-01', '2026-10-31'))
        .totalExpense,
    ).toBe(111_000);
    expect(
      (await readExpenseByCategory(db, '2026-11-01', '2026-11-04'))
        .totalExpense,
    ).toBe(222_000);
  });
});
