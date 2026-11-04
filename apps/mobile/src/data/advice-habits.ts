import {
  AdvicePersonalBaselineGroupSchema,
  AdviceSpendingHabitsGroupSchema,
  type AdviceBaselineRow,
  type AdviceHabitChild,
  type AdviceHabitParent,
  type AdvicePersonalBaselineGroup,
  type AdviceSpendingHabitsGroup,
} from '@pfm/contracts';
import {
  addDays,
  addMonths,
  daysInMonth,
  monthKey,
  type AdviceDateRange,
} from '@pfm/domain';

import type { Queries } from './migrate';

/** Spend below this amount in a flexible category counts as a small habit. */
export const SMALL_SPEND_THRESHOLD_VND = 100_000;
export const HABIT_PARENT_LIMIT = 4;
export const HABIT_CHILD_LIMIT = 5;
export const BASELINE_ROW_LIMIT = 5;
export const BASELINE_MONTHS = 6;

interface ParentRow {
  name: string | null;
  isFixed: number | null;
  amount: number;
  count: number;
  largest: number;
}

interface ChildRow {
  parentName: string | null;
  childName: string | null;
  amount: number;
  count: number;
}

interface TotalsRow {
  total: number;
  count: number;
  flexible: number;
  smallCount: number;
  smallAmount: number;
}

const PARENT_GROUPS_SQL = `SELECT
   COALESCE(c.parent_id, c.id) AS groupId,
   COALESCE(p.name, c.name) AS name,
   COALESCE(p.is_fixed_cost, c.is_fixed_cost) AS isFixed,
   SUM(t.amount) AS amount,
   COUNT(*) AS count,
   MAX(t.amount) AS largest
 FROM transactions t
 LEFT JOIN categories c ON c.id = t.category_id
 LEFT JOIN categories p ON p.id = c.parent_id
 WHERE t.kind = 'expense' AND t.occurred_on >= ? AND t.occurred_on <= ?
 GROUP BY COALESCE(c.parent_id, c.id), COALESCE(p.name, c.name), COALESCE(p.is_fixed_cost, c.is_fixed_cost)
 ORDER BY amount DESC, name ASC`;

const CHILD_GROUPS_SQL = `SELECT
   COALESCE(p.name, c.name) AS parentName,
   c.name AS childName,
   SUM(t.amount) AS amount,
   COUNT(*) AS count
 FROM transactions t
 JOIN categories c ON c.id = t.category_id
 LEFT JOIN categories p ON p.id = c.parent_id
 WHERE t.kind = 'expense' AND c.parent_id IS NOT NULL
   AND t.occurred_on >= ? AND t.occurred_on <= ?
 GROUP BY c.parent_id, COALESCE(p.name, c.name), c.name
 ORDER BY amount DESC`;

function assertSafe(values: number[], code: string): void {
  if (values.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(code);
  }
}

/** Inclusive number of calendar days in a window. */
export function daysBetween(from: string, to: string): number {
  const length =
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  return Math.max(1, length);
}

/** Same-length window immediately before `range`, or null at the start of data. */
export function previousWindow(range: AdviceDateRange): AdviceDateRange {
  const days = daysBetween(range.from, range.to);
  const to = addDays(range.from, -1);
  return { kind: range.kind, from: addDays(to, -(days - 1)), to };
}

/**
 * Describe how the user actually spends in one window: how many times, how much
 * per time, the largest single purchase, which parents are flexible, and the
 * child categories behind the biggest parents.
 */
export async function readSpendingHabits(
  db: Queries,
  range: AdviceDateRange,
): Promise<Omit<AdviceSpendingHabitsGroup, 'kind'>> {
  const rows = await db.getAllAsync<ParentRow>(
    PARENT_GROUPS_SQL,
    range.from,
    range.to,
  );
  const totals = await db.getFirstAsync<TotalsRow>(
    `SELECT
       COALESCE(SUM(t.amount), 0) AS total,
       COUNT(*) AS count,
       COALESCE(SUM(CASE WHEN COALESCE(p.is_fixed_cost, c.is_fixed_cost) = 0 THEN t.amount ELSE 0 END), 0) AS flexible,
       COALESCE(SUM(CASE WHEN COALESCE(p.is_fixed_cost, c.is_fixed_cost) = 0 AND t.amount < ? THEN 1 ELSE 0 END), 0) AS smallCount,
       COALESCE(SUM(CASE WHEN COALESCE(p.is_fixed_cost, c.is_fixed_cost) = 0 AND t.amount < ? THEN t.amount ELSE 0 END), 0) AS smallAmount
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE t.kind = 'expense' AND t.occurred_on >= ? AND t.occurred_on <= ?`,
    SMALL_SPEND_THRESHOLD_VND,
    SMALL_SPEND_THRESHOLD_VND,
    range.from,
    range.to,
  );

  const totalExpense = totals?.total ?? 0;
  const transactionCount = totals?.count ?? 0;
  const flexibleAmount = totals?.flexible ?? 0;
  const smallFrequentCount = totals?.smallCount ?? 0;
  const smallFrequentAmount = totals?.smallAmount ?? 0;
  assertSafe(
    [
      totalExpense,
      transactionCount,
      flexibleAmount,
      smallFrequentCount,
      smallFrequentAmount,
      ...rows.flatMap((row) => [row.amount, row.count, row.largest]),
    ],
    'ADVICE_HABITS_UNSAFE',
  );

  // Rows without a category cannot be advised on, so they stay in the totals only.
  const named = rows.filter(
    (row): row is ParentRow & { name: string } =>
      typeof row.name === 'string' && row.name.length > 0,
  );
  const topParents = named.slice(0, HABIT_PARENT_LIMIT);

  const previous = previousWindow(range);
  const previousRows = await db.getAllAsync<ParentRow>(
    PARENT_GROUPS_SQL,
    previous.from,
    previous.to,
  );
  const previousByName = new Map(
    previousRows
      .filter((row): row is ParentRow & { name: string } => Boolean(row.name))
      .map((row) => [row.name, row.amount]),
  );

  const children =
    topParents.length > 0
      ? await db.getAllAsync<ChildRow>(CHILD_GROUPS_SQL, range.from, range.to)
      : [];

  const parents: AdviceHabitParent[] = topParents.map((row) => {
    const childNames = children
      .filter((child) => child.parentName === row.name && child.childName)
      .slice(0, HABIT_CHILD_LIMIT)
      .map<AdviceHabitChild>((child) => ({
        name: child.childName as string,
        amount: child.amount,
        count: child.count,
        avgTicket: child.count > 0 ? Math.round(child.amount / child.count) : 0,
      }));
    return {
      name: row.name,
      amount: row.amount,
      previousAmount: previousByName.get(row.name) ?? null,
      count: row.count,
      avgTicket: row.count > 0 ? Math.round(row.amount / row.count) : 0,
      largestTicket: row.largest,
      isFlexible: row.isFixed !== 1,
      children: childNames,
    };
  });

  return {
    rangeKind: range.kind,
    from: range.from,
    to: range.to,
    daysInRange: daysBetween(range.from, range.to),
    transactionCount,
    totalExpense,
    flexibleAmount,
    smallFrequentCount,
    smallFrequentAmount,
    parents,
  };
}

/**
 * Compare the selected window's category shares with the user's own recent
 * history, so advice can say "higher than your usual" without external data.
 */
export async function readPersonalBaseline(
  db: Queries,
  range: AdviceDateRange,
  todayIso: string,
): Promise<AdvicePersonalBaselineGroup> {
  const currentMonthKey = monthKey(`${todayIso.slice(0, 7)}-01`);
  const baselineStart = addMonths(`${currentMonthKey}-01`, -BASELINE_MONTHS);
  const previousMonthStart = addMonths(`${currentMonthKey}-01`, -1);
  const [previousYear, previousMonth] = previousMonthStart.split('-').map(Number);
  const baselineEnd = `${previousMonthStart.slice(0, 7)}-${String(
    daysInMonth(previousYear, previousMonth),
  ).padStart(2, '0')}`;

  const currentRows = await db.getAllAsync<ParentRow>(
    PARENT_GROUPS_SQL,
    range.from,
    range.to,
  );
  const currentTotal = currentRows.reduce((sum, row) => sum + row.amount, 0);

  const baselineRows = await db.getAllAsync<ParentRow>(
    PARENT_GROUPS_SQL,
    baselineStart,
    baselineEnd,
  );
  const baselineTotal = baselineRows.reduce((sum, row) => sum + row.amount, 0);
  const baselineByName = new Map(
    baselineRows
      .filter((row): row is ParentRow & { name: string } => Boolean(row.name))
      .map((row) => [row.name, row.amount]),
  );

  const monthsRow = await db.getFirstAsync<{ monthsWithData: number }>(
    `SELECT COUNT(DISTINCT substr(occurred_on, 1, 7)) AS monthsWithData
     FROM transactions
     WHERE kind = 'expense' AND occurred_on >= ? AND occurred_on <= ?`,
    baselineStart,
    baselineEnd,
  );
  const monthsWithData = Math.min(
    BASELINE_MONTHS,
    Math.max(0, monthsRow?.monthsWithData ?? 0),
  );
  assertSafe(
    [currentTotal, baselineTotal, ...currentRows.map((row) => row.amount)],
    'ADVICE_BASELINE_UNSAFE',
  );

  const share = (amount: number, total: number) =>
    total > 0 ? Math.min(100, Math.round((amount * 100) / total)) : 0;
  const divisor = Math.max(1, monthsWithData);

  const rows: AdviceBaselineRow[] = currentRows
    .filter(
      (row): row is ParentRow & { name: string } =>
        typeof row.name === 'string' && row.name.length > 0 && row.amount > 0,
    )
    .slice(0, BASELINE_ROW_LIMIT)
    .map((row) => {
      const baselineAmount = baselineByName.get(row.name) ?? 0;
      return {
        name: row.name,
        currentAmount: row.amount,
        currentPercent: share(row.amount, currentTotal),
        baselineMonthlyAvg: Math.round(baselineAmount / divisor),
        baselinePercent: share(baselineAmount, baselineTotal),
      };
    });

  return AdvicePersonalBaselineGroupSchema.parse({
    kind: 'personal_baseline',
    monthsWithData,
    rows,
  });
}

/** Parse the habits payload once so the schema stays the single source of truth. */
export function spendingHabitsGroup(
  habits: Omit<AdviceSpendingHabitsGroup, 'kind'>,
): AdviceSpendingHabitsGroup {
  return AdviceSpendingHabitsGroupSchema.parse({
    kind: 'spending_habits',
    ...habits,
  });
}