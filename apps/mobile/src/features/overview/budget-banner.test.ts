import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { budgetBannerItems } from '@pfm/domain';
import {
  BUDGET_BANNER_DISMISSED_SETTING_KEY,
  createBudget,
  dismissBudgetBannerItems,
  filterVisibleBudgetBannerItems,
  parseDismissedBudgetBannerKeys,
  readDismissedBudgetBannerKeys,
} from '@/data/budgets';
import { readDashboard } from '@/data/dashboard';
import { listCategories } from '@/data/categories';
import { migrate, type Database, type Queries } from '@/data/migrate';
import { DEFAULT_WALLET_ID, seed } from '@/data/seed';
import { createTransaction, deleteTransaction } from '@/data/transactions';
import { setActiveLanguage } from '@/messages/language';
import { formatBudgetBannerMessage } from './budget-banner';
vi.mock('@/components/platform-icon', () => ({
  default: 'MaterialCommunityIcons',
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (s: unknown) => s },
  View: 'View',
}));

vi.mock('react-native-paper', () => ({
  Text: 'Text',
}));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: 'MaterialCommunityIcons',
}));

vi.mock('@/constants/theme', () => ({
  DesignRadius: { lg: 16 },
  DesignSpacing: { xs: 6, md: 14 },
  useFinancePalette: () => ({
    dangerSoft: '#FEE2E2',
    danger: '#DC2626',
    dangerInk: '#991B1B',
    warningSoft: '#FEF3C7',
    warning: '#D97706',
    warningInk: '#92400E',
  }),
}));

vi.mock('@/data/connection', () => ({
  withDatabase: vi.fn(),
}));

function wrapSqlite(sqlite: DatabaseSync): Database {
  const queries: Queries = {
    execAsync: async (source) => {
      sqlite.exec(source);
    },
    runAsync: async (source, ...params) => {
      const result = sqlite
        .prepare(source)
        .run(...(params as (string | number | null)[]));
      return { changes: Number(result.changes) };
    },
    getFirstAsync: async <T>(source: string, ...params: unknown[]) =>
      ((sqlite
        .prepare(source)
        .get(...(params as (string | number | null)[])) as T | undefined) ??
        null) as T | null,
    getAllAsync: async <T>(source: string, ...params: unknown[]) =>
      sqlite
        .prepare(source)
        .all(...(params as (string | number | null)[])) as T[],
  };
  return {
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
}

describe('budget banner dismissal & persistence', () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(async () => {
    setActiveLanguage('vi');
    sqlite = new DatabaseSync(':memory:');
    db = wrapSqlite(sqlite);
    await migrate(db);
    await seed(db, '2026-11-01T00:00:00.000Z');
  });

  afterEach(() => {
    setActiveLanguage('vi');
    sqlite.close();
  });

  it('prunes old months and ignores corrupted JSON in parseDismissedBudgetBannerKeys', () => {
    expect(parseDismissedBudgetBannerKeys(null, '2026-11')).toEqual([]);
    expect(parseDismissedBudgetBannerKeys('{corrupted', '2026-11')).toEqual([]);
    expect(
      parseDismissedBudgetBannerKeys('{"not":"array"}', '2026-11'),
    ).toEqual([]);

    const raw = JSON.stringify([
      'b1|2026-10|warn',
      'b1|2026-11|warn',
      'b2|2026-11|over',
      'b2|2026-11|invalid_level',
      'malformed',
      123,
    ]);
    expect(parseDismissedBudgetBannerKeys(raw, '2026-11')).toEqual([
      'b1|2026-11|warn',
      'b2|2026-11|over',
    ]);
  });

  it('does not carry a dismissed daily banner into the next day', async () => {
    const row = {
      id: 'daily',
      amount: 100000,
      spent: 150000,
      warn_percent: 80,
      period_key: '2026-11-10',
    };
    const first = budgetBannerItems([row]);
    const dismissed = await dismissBudgetBannerItems(db, '2026-11', first);
    expect(dismissed).toContain('daily|2026-11-10|over');
    expect(filterVisibleBudgetBannerItems(first, '2026-11', dismissed)).toEqual(
      [],
    );
    const next = budgetBannerItems([{ ...row, period_key: '2026-11-11' }]);
    expect(
      filterVisibleBudgetBannerItems(next, '2026-11', dismissed),
    ).toHaveLength(1);
  });

  it('tracks warn and over dismissal independently across transactions and months on real SQLite', async () => {
    const month = '2026-11';
    const expenseCategoryId = (await listCategories(db)).find(
      (c) => c.kind === 'expense',
    )!.id;
    await createBudget(
      db,
      'budget-overall',
      {
        categoryId: null,
        amount: 100_000,
        warnPercent: 80,
        startMonth: month,
        endMonth: null,
      },
      '2026-11-01T00:00:00.000Z',
    );

    // 1. Spend 80,000 VND -> reaches warn (80%)
    await createTransaction(
      db,
      'tx-1',
      {
        kind: 'expense',
        amount: 80_000,
        walletId: DEFAULT_WALLET_ID,
        categoryId: expenseCategoryId,
        occurredOn: '2026-11-05',
        occurredAt: '2026-11-05T12:00:00.000Z',
        note: 'Ăn trưa',
      },
      '2026-11-05T12:00:00.000Z',
    );

    let dashboard = await readDashboard(db, month);
    let visible = filterVisibleBudgetBannerItems(
      budgetBannerItems(dashboard.budgets),
      month,
      dashboard.dismissedBudgetBannerKeys,
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      budgetId: 'budget-overall',
      level: 'warn',
      spent: 80_000,
      amount: 100_000,
      percent: 80,
      overBy: 0,
    });

    // 2. User dismisses the warn banner -> stays hidden on reload
    await dismissBudgetBannerItems(db, month, visible);
    dashboard = await readDashboard(db, month);
    expect(dashboard.dismissedBudgetBannerKeys).toEqual([
      'budget-overall|2026-11|warn',
    ]);
    expect(
      filterVisibleBudgetBannerItems(
        budgetBannerItems(dashboard.budgets),
        month,
        dashboard.dismissedBudgetBannerKeys,
      ),
    ).toEqual([]);

    // 3. Spend another 25,000 VND (total 105,000 VND) -> escalates to 'over', so banner reappears!
    await createTransaction(
      db,
      'tx-2',
      {
        kind: 'expense',
        amount: 25_000,
        walletId: DEFAULT_WALLET_ID,
        categoryId: expenseCategoryId,
        occurredOn: '2026-11-06',
        occurredAt: '2026-11-06T09:00:00.000Z',
        note: 'Cà phê',
      },
      '2026-11-06T09:00:00.000Z',
    );

    dashboard = await readDashboard(db, month);
    visible = filterVisibleBudgetBannerItems(
      budgetBannerItems(dashboard.budgets),
      month,
      dashboard.dismissedBudgetBannerKeys,
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      budgetId: 'budget-overall',
      level: 'over',
      spent: 105_000,
      amount: 100_000,
      percent: 105,
      overBy: 5_000,
    });

    // 4. Delete both transactions -> spending drops below threshold, banner disappears
    await deleteTransaction(db, 'tx-2', '2026-11-06T09:00:00.000Z');
    await deleteTransaction(db, 'tx-1', '2026-11-05T12:00:00.000Z');
    dashboard = await readDashboard(db, month);
    expect(budgetBannerItems(dashboard.budgets)).toEqual([]);

    // 5. Next month (2026-12) automatically drops 2026-11 dismissed keys
    expect(await readDismissedBudgetBannerKeys(db, '2026-12')).toEqual([]);

    // 6. Corrupted settings row does not crash readDashboard
    await db.runAsync(
      'UPDATE settings SET value=? WHERE key=?',
      'not-valid-json',
      BUDGET_BANNER_DISMISSED_SETTING_KEY,
    );
    expect(await readDismissedBudgetBannerKeys(db, month)).toEqual([]);
  });

  it('formats single and multiple budget banner messages in vi and en', () => {
    setActiveLanguage('vi');
    expect(
      formatBudgetBannerMessage([
        {
          budgetId: 'b1',
          categoryName: null,
          level: 'warn',
          spent: 800_000,
          amount: 1_000_000,
          percent: 80,
          overBy: 0,
        },
      ]),
    ).toBe('Ngân sách tổng: đã dùng 80% hạn mức');

    expect(
      formatBudgetBannerMessage([
        {
          budgetId: 'b1',
          categoryName: 'Ăn uống',
          level: 'over',
          spent: 1_000_000,
          amount: 1_000_000,
          percent: 100,
          overBy: 0,
        },
      ]),
    ).toBe('Ăn uống: đã chạm 100% hạn mức');

    expect(
      formatBudgetBannerMessage([
        {
          budgetId: 'b1',
          categoryName: 'Ăn uống',
          level: 'over',
          spent: 1_200_000,
          amount: 1_000_000,
          percent: 120,
          overBy: 200_000,
        },
        {
          budgetId: 'b2',
          categoryName: null,
          level: 'warn',
          spent: 850_000,
          amount: 1_000_000,
          percent: 85,
          overBy: 0,
        },
      ]),
    ).toBe('2 ngân sách cần chú ý');

    setActiveLanguage('en');
    expect(
      formatBudgetBannerMessage([
        {
          budgetId: 'b1',
          categoryName: null,
          level: 'warn',
          spent: 800_000,
          amount: 1_000_000,
          percent: 80,
          overBy: 0,
        },
      ]),
    ).toBe('Overall budget: 80% of limit used');
    expect(
      formatBudgetBannerMessage([
        {
          budgetId: 'b1',
          categoryName: null,
          level: 'over',
          spent: 1_000_000,
          amount: 1_000_000,
          percent: 100,
          overBy: 0,
        },
        {
          budgetId: 'b2',
          categoryName: null,
          level: 'warn',
          spent: 850_000,
          amount: 1_000_000,
          percent: 85,
          overBy: 0,
        },
      ]),
    ).toBe('2 budgets need attention');
  });
});
