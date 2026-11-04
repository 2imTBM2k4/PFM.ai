import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { readAnalysisSummary } from './analysis';
import { createDebt } from './debts';
import { saveGoal } from './goals';
import { migrate, type Database } from './migrate';
import { seed } from './seed';
import { createTransaction } from './transactions';
import { createWallet } from './wallets';

describe('readAnalysisSummary SQLite integration', () => {
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
  });

  it('handles a fresh empty database gracefully and returns a valid summary', async () => {
    const summary = await readAnalysisSummary(db, '2026-10-28');

    expect(summary.schemaVersion).toBe(1);
    expect(summary.currency).toBe('VND');
    expect(summary.window.monthsWithData).toBe(0);
    expect(summary.income.monthlyAvg).toBe(0);
    expect(summary.expense.monthlyAvg).toBe(0);
    expect(summary.riskFlags).toContain('NO_INCOME_RECORDED');
    expect(summary.dataQuality).toContain('FEW_MONTHS');
    expect(summary.dataQuality).toContain('LESS_THAN_3_MONTHS');
  });

  it('does not report no recorded income when the current month has salary', async () => {
    await seed(db, '2026-11-01T00:00:00Z');
    const walletId = randomUUID();
    await createWallet(
      db,
      walletId,
      { name: 'Tiền mặt', kind: 'cash', initialBalance: 0 },
      '2026-11-01T00:00:00Z',
    );
    await createTransaction(
      db,
      randomUUID(),
      {
        kind: 'income',
        amount: 3_000_000,
        walletId,
        occurredOn: '2026-11-02',
        occurredAt: '2026-11-02T10:00:00+07:00',
      },
      '2026-11-02T10:00:00+07:00',
    );
    const summary = await readAnalysisSummary(db, '2026-11-04');
    expect(summary.window.monthsWithData).toBe(0);
    expect(summary.income.monthlyAvg).toBe(0);
    expect(summary.currentMonth.incomeSoFar).toBe(3_000_000);
    expect(summary.riskFlags).not.toContain('NO_INCOME_RECORDED');
    expect(summary.dataQuality).toContain('LESS_THAN_3_MONTHS');
  });

  it('separates essential from discretionary spending for emergency-fund sizing', async () => {
    await seed(db, '2026-05-01T00:00:00Z');
    const walletId = randomUUID();
    await createWallet(
      db,
      walletId,
      // Spending 20m across the two months leaves 12m of liquid balance.
      { name: 'Tiền mặt', kind: 'cash', initialBalance: 32_000_000 },
      '2026-05-01T00:00:00Z',
    );
    const rent = (await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM categories WHERE system_key = 'expense.housing.rent'",
    ))!;
    const shopping = (await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM categories WHERE system_key = 'expense.shopping'",
    ))!;

    // Two complete months before October 2026: rent is essential, shopping is not.
    for (const month of ['2026-08', '2026-09']) {
      await createTransaction(
        db,
        randomUUID(),
        {
          kind: 'expense',
          amount: 4_000_000,
          walletId,
          categoryId: rent.id,
          occurredOn: `${month}-05`,
          occurredAt: `${month}-05T10:00:00+07:00`,
        },
        `${month}-05T10:00:00+07:00`,
      );
      await createTransaction(
        db,
        randomUUID(),
        {
          kind: 'expense',
          amount: 6_000_000,
          walletId,
          categoryId: shopping.id,
          occurredOn: `${month}-06`,
          occurredAt: `${month}-06T10:00:00+07:00`,
        },
        `${month}-06T10:00:00+07:00`,
      );
    }

    const summary = await readAnalysisSummary(db, '2026-10-10');

    expect(summary.expense.monthlyAvg).toBe(10_000_000);
    expect(summary.expense.essentialMonthlyAvg).toBe(4_000_000);
    // 12m liquid covers 1 month of total spend but 3 months of essential spend.
    expect(summary.savings.emergencyFundMonths).toBe(1);
    expect(summary.savings.emergencyFundMonthsEssential).toBe(3);
  });

  it('aggregates seeded financial history and commitments accurately', async () => {
    await seed(db, 'old');

    const walletId = randomUUID();
    await createWallet(
      db,
      walletId,
      {
        name: 'Tiá»n máº·t chi tiÃªu',
        kind: 'cash',
        initialBalance: 5000000,
        isGoalFunding: true,
      },
      '2026-08-01T00:00:00Z',
    );

    const foodCat = (await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM categories WHERE system_key = 'expense.food'",
    ))!;

    await createTransaction(
      db,
      randomUUID(),
      {
        walletId,
        kind: 'income',
        amount: 15000000,
        occurredOn: '2026-08-05',
        occurredAt: '2026-08-05T00:00:00.000Z',
        note: 'LÆ°Æ¡ng thÃ¡ng 8',
      },
      '2026-08-05T00:00:00Z',
    );

    await createTransaction(
      db,
      randomUUID(),
      {
        walletId,
        categoryId: foodCat.id,
        kind: 'expense',
        amount: 4000000,
        occurredOn: '2026-08-10',
        occurredAt: '2026-08-10T00:00:00.000Z',
        note: 'Ä‚n uá»‘ng thÃ¡ng 8',
      },
      '2026-08-10T00:00:00Z',
    );

    await createTransaction(
      db,
      randomUUID(),
      {
        walletId,
        kind: 'income',
        amount: 15000000,
        occurredOn: '2026-09-05',
        occurredAt: '2026-09-05T00:00:00.000Z',
        note: 'LÆ°Æ¡ng thÃ¡ng 9',
      },
      '2026-09-05T00:00:00Z',
    );

    await createTransaction(
      db,
      randomUUID(),
      {
        walletId,
        categoryId: foodCat.id,
        kind: 'expense',
        amount: 6000000,
        occurredOn: '2026-09-15',
        occurredAt: '2026-09-15T00:00:00.000Z',
        note: 'Ä‚n uá»‘ng thÃ¡ng 9',
      },
      '2026-09-15T00:00:00Z',
    );

    // Current month transaction (Oct 2026)
    await createTransaction(
      db,
      randomUUID(),
      {
        walletId,
        categoryId: foodCat.id,
        kind: 'expense',
        amount: 2500000,
        occurredOn: '2026-10-15',
        occurredAt: '2026-10-15T00:00:00.000Z',
        note: 'Ä‚n uá»‘ng thÃ¡ng 10',
      },
      '2026-10-15T00:00:00Z',
    );

    // Add an active goal
    await saveGoal(
      db,
      randomUUID(),
      {
        name: 'Mua laptop',
        targetAmount: 20000000,
        manualSavedAmount: 5000000,
        deadlineOn: '2027-02-28',
      },
      '2026-10-01T00:00:00Z',
      false,
    );

    // Add a borrowed debt
    const debtTxId = randomUUID();
    await createDebt(
      db,
      randomUUID(),
      debtTxId,
      {
        counterpartyLabel: 'Anh Nam',
        direction: 'borrowed',
        amount: 10000000,
        walletId,
        occurredOn: '2026-09-01',
      },
      '2026-09-01T00:00:00Z',
    );

    const summary = await readAnalysisSummary(db, '2026-10-28');

    expect(summary.schemaVersion).toBe(1);
    expect(summary.window.monthsWithData).toBe(2); // Aug and Sep in window
    expect(summary.income.monthlyAvg).toBe(15000000);
    expect(summary.expense.monthlyAvg).toBe(5000000); // (4M + 6M) / 2
    expect(summary.surplus.monthlyAvg).toBe(10000000);
    expect(summary.currentMonth.expenseSoFar).toBe(2500000);

    // Goal & Debts
    expect(summary.goals).toHaveLength(1);
    expect(summary.debts.outstandingBorrowed).toBe(10000000);

    // Top categories include expense.food
    const foodBreakdown = summary.topExpenseCategories.find(
      (c) => c.key === 'expense.food',
    );
    expect(foodBreakdown).toBeDefined();
    expect(foodBreakdown?.monthlyAvg).toBe(5000000);
  });
});
