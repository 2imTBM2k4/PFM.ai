import { BudgetInputSchema, type BudgetInput } from '@pfm/contracts';
import {
  budgetThresholds,
  daysInMonth,
  monthKey,
  type BudgetBannerItem,
  type BudgetBannerLevel,
} from '@pfm/domain';
import { requireActiveCategory } from './categories';
import type { Database, Queries } from './migrate';

export const BUDGET_BANNER_DISMISSED_SETTING_KEY = 'budget_banner_dismissed_v1';

export interface BudgetRow {
  id: string;
  category_id: string | null;
  amount: number;
  warn_percent: number;
  start_month: string;
  end_month: string | null;
  period_type?: 'monthly' | 'custom';
  start_date?: string | null;
  end_date?: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  category_name: string | null;
  category_archived: number | null;
  spent: number;
  in_period: number;
}

export async function readBudgetMonth(
  db: Queries,
  month: string,
  budgetId?: string,
) {
  monthKey(`${month}-01`);
  const [year, number] = month.split('-').map(Number);
  const startDay = `${month}-01`;
  const endDay = `${month}-${String(daysInMonth(year, number)).padStart(2, '0')}`;
  const rows = await db.getAllAsync<BudgetRow>(
    `SELECT b.*, c.name category_name, c.is_archived category_archived,
     CASE
       WHEN b.period_type = 'custom' AND b.start_date IS NOT NULL AND b.end_date IS NOT NULL THEN
         CASE WHEN b.start_date <= ? AND (b.end_date IS NULL OR b.end_date >= ?) THEN 1 ELSE 0 END
       ELSE
         CASE WHEN b.start_month <= ? AND (b.end_month IS NULL OR b.end_month >= ?) THEN 1 ELSE 0 END
     END in_period,
     CASE
       WHEN b.period_type = 'custom' AND b.start_date IS NOT NULL AND b.end_date IS NOT NULL THEN
         COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.kind = 'expense'
           AND t.occurred_on >= b.start_date AND t.occurred_on <= b.end_date
           AND (b.category_id IS NULL OR t.category_id = b.category_id OR t.category_id IN (SELECT id FROM categories WHERE parent_id = b.category_id))), 0)
       ELSE
         COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.kind = 'expense'
           AND t.occurred_on >= ? AND t.occurred_on <= ?
           AND (b.category_id IS NULL OR t.category_id = b.category_id OR t.category_id IN (SELECT id FROM categories WHERE parent_id = b.category_id))), 0)
     END spent
     FROM budgets b LEFT JOIN categories c ON c.id = b.category_id ${budgetId === undefined ? '' : 'WHERE b.id = ?'}
     ORDER BY b.is_active DESC, b.created_at, b.id`,
    endDay,
    startDay,
    month,
    month,
    startDay,
    endDay,
    ...(budgetId === undefined ? [] : [budgetId]),
  );
  if (rows.some((row) => !Number.isSafeInteger(row.spent)))
    throw new Error('BUDGET_TOTAL_UNSAFE');
  return rows;
}

export async function createBudget(
  db: Database,
  id: string,
  input: BudgetInput,
  timestamp: string,
) {
  const value = BudgetInputSchema.parse(input);
  const periodType = value.periodType ?? 'monthly';
  const startMonth =
    value.startMonth ??
    (value.startDate ? value.startDate.slice(0, 7) : monthKey(timestamp));
  const endMonth =
    value.endMonth ?? (value.endDate ? value.endDate.slice(0, 7) : null);
  const startDate = value.startDate ?? null;
  const endDate = value.endDate ?? null;

  await db.transaction(async (transaction) => {
    if (value.categoryId)
      await requireActiveCategory(transaction, value.categoryId, 'expense');
    await transaction.runAsync(
      'INSERT INTO budgets (id, category_id, amount, warn_percent, start_month, end_month, period_type, start_date, end_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      value.categoryId,
      value.amount,
      value.warnPercent,
      startMonth,
      endMonth,
      periodType,
      startDate,
      endDate,
      timestamp,
      timestamp,
    );
  });
}

export async function updateBudget(
  db: Database,
  id: string,
  input: BudgetInput,
  timestamp: string,
) {
  const value = BudgetInputSchema.parse(input);
  const periodType = value.periodType ?? 'monthly';
  const startMonth =
    value.startMonth ??
    (value.startDate ? value.startDate.slice(0, 7) : monthKey(timestamp));
  const endMonth =
    value.endMonth ?? (value.endDate ? value.endDate.slice(0, 7) : null);
  const startDate = value.startDate ?? null;
  const endDate = value.endDate ?? null;

  await db.transaction(async (transaction) => {
    const old = await transaction.getFirstAsync<{ category_id: string | null }>(
      'SELECT category_id FROM budgets WHERE id = ?',
      id,
    );
    if (!old) throw new Error('BUDGET_NOT_FOUND');
    if (value.categoryId && value.categoryId !== old.category_id)
      await requireActiveCategory(transaction, value.categoryId, 'expense');
    await transaction.runAsync(
      'UPDATE budgets SET category_id = ?, amount = ?, warn_percent = ?, start_month = ?, end_month = ?, period_type = ?, start_date = ?, end_date = ?, updated_at = ? WHERE id = ?',
      value.categoryId,
      value.amount,
      value.warnPercent,
      startMonth,
      endMonth,
      periodType,
      startDate,
      endDate,
      timestamp,
      id,
    );
  });
}

export async function setBudgetActive(
  db: Database,
  id: string,
  active: boolean,
  timestamp: string,
) {
  await db.transaction(async (transaction) => {
    if (
      !(await transaction.getFirstAsync(
        'SELECT id FROM budgets WHERE id=?',
        id,
      ))
    )
      throw new Error('BUDGET_NOT_FOUND');
    await transaction.runAsync(
      'UPDATE budgets SET is_active=?,updated_at=? WHERE id=?',
      active ? 1 : 0,
      timestamp,
      id,
    );
  });
}

export async function claimBudgetAlert(
  db: Database,
  id: string,
  month: string,
  threshold: number,
  timestamp: string,
) {
  let claimed = false;
  await db.transaction(async (transaction) => {
    const budget = (await readBudgetMonth(transaction, month, id)).find(
      (row) => row.id === id,
    );
    if (
      !budget ||
      !budget.is_active ||
      !budget.in_period ||
      !budgetThresholds(
        budget.spent,
        budget.amount,
        budget.warn_percent,
      ).includes(threshold)
    )
      return;
    if (
      await transaction.getFirstAsync(
        'SELECT 1 FROM budget_alerts_sent WHERE budget_id=? AND month=? AND threshold_percent=?',
        id,
        month,
        threshold,
      )
    )
      return;
    await transaction.runAsync(
      'INSERT INTO budget_alerts_sent (budget_id,month,threshold_percent,sent_at) VALUES (?,?,?,?)',
      id,
      month,
      threshold,
      timestamp,
    );
    claimed = true;
  });
  return claimed;
}

export function releaseBudgetAlert(
  db: Queries,
  id: string,
  month: string,
  threshold: number,
) {
  return db.runAsync(
    'DELETE FROM budget_alerts_sent WHERE budget_id=? AND month=? AND threshold_percent=?',
    id,
    month,
    threshold,
  );
}

/**
 * Formats the composite persistence key for a dismissed budget banner state.
 */
export function budgetBannerDismissKey(
  budgetId: string,
  month: string,
  level: BudgetBannerLevel,
): string {
  return `${budgetId}|${month}|${level}`;
}

/**
 * Parses raw JSON from settings and keeps only valid keys belonging to `currentMonth`.
 */
export function parseDismissedBudgetBannerKeys(
  rawValue: string | null | undefined,
  currentMonth: string,
): string[] {
  if (!rawValue) return [];
  try {
    const parsed: unknown = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    const result = new Set<string>();
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue;
      const parts = entry.split('|');
      if (parts.length !== 3) continue;
      const [budgetId, month, level] = parts;
      if (
        !budgetId ||
        month !== currentMonth ||
        (level !== 'warn' && level !== 'over')
      ) {
        continue;
      }
      result.add(entry);
    }
    return [...result];
  } catch {
    return [];
  }
}

/**
 * Filters computed banner items against the dismissed keys for the given month.
 */
export function filterVisibleBudgetBannerItems(
  items: readonly BudgetBannerItem[],
  month: string,
  dismissedKeys: Iterable<string>,
): BudgetBannerItem[] {
  const dismissed =
    dismissedKeys instanceof Set ? dismissedKeys : new Set(dismissedKeys);
  return items.filter(
    (item) =>
      !dismissed.has(budgetBannerDismissKey(item.budgetId, month, item.level)),
  );
}

/**
 * Reads dismissed budget banner keys for the current month from the settings table.
 */
export async function readDismissedBudgetBannerKeys(
  db: Queries,
  currentMonth: string,
): Promise<string[]> {
  monthKey(`${currentMonth}-01`);
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key=?',
    BUDGET_BANNER_DISMISSED_SETTING_KEY,
  );
  return parseDismissedBudgetBannerKeys(row?.value, currentMonth);
}

/**
 * Persists dismissed budget banner keys for the current month via settings upsert,
 * automatically dropping stale keys from previous months.
 */
export async function dismissBudgetBannerItems(
  db: Queries,
  currentMonth: string,
  items: readonly { budgetId: string; level: BudgetBannerLevel }[],
): Promise<string[]> {
  monthKey(`${currentMonth}-01`);
  const existing = await readDismissedBudgetBannerKeys(db, currentMonth);
  const merged = new Set(existing);
  for (const item of items) {
    merged.add(budgetBannerDismissKey(item.budgetId, currentMonth, item.level));
  }
  const next = [...merged];
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    BUDGET_BANNER_DISMISSED_SETTING_KEY,
    JSON.stringify(next),
  );
  return next;
}
