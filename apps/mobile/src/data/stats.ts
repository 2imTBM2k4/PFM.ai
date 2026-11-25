import {
  addDays,
  addMonths,
  daysInMonth,
  monthKey,
  startOfWeek,
  validateDate,
} from '@pfm/domain';
import type { Queries } from './migrate';
import type { TransactionRow } from './transactions';
import type { DonutCategoryInput } from '@/features/stats/stats-summary';

type TransactionKind = TransactionRow['kind'];

export type TrendGranularity = 'week' | 'month' | 'year';

export type CalendarKindFilter =
  | 'all'
  | 'income'
  | 'expense'
  | 'transfer'
  | 'debt';

export interface CalendarMonthFilter {
  kind?: CalendarKindFilter;
  walletId?: string;
  categoryId?: string;
}

export interface IncomeExpenseSituation {
  month: string;
  previousMonth: string;
  comparisonEndDay: number;
  isCurrentMonth: boolean;
  expenseTotal: number;
  incomeTotal: number;
  currentPeriodExpense: number;
  currentPeriodIncome: number;
  previousPeriodExpense: number;
  previousPeriodIncome: number;
  expenseDelta: number;
  incomeDelta: number;
  expenseCategories: DonutCategoryInput[];
  incomeCategories: DonutCategoryInput[];
}

export type TrendCategoryLevel = 'child' | 'parent';

export interface TrendLabelOptions {
  monthPrefix?: string;
  thisWeekLabel?: string;
  thisMonthLabel?: string;
  thisYearLabel?: string;
  monthBadgeTemplate?: string;
  yearLabelTemplate?: string;
}

export interface CashFlowPeriodPoint {
  key: string;
  label: string;
  rangeLabel: string;
  calloutDateLabel: string;
  badgePrimary: string;
  badgeSecondary: string;
  startDate: string;
  endDate: string;
  samePeriodEndDate: string;
  isCurrent: boolean;
  income: number;
  expense: number;
  net: number;
  samePeriodIncome: number;
  samePeriodExpense: number;
  samePeriodNet: number;
}

export interface CashFlowTrendResult {
  granularity: TrendGranularity;
  windowStart: string;
  windowEnd: string;
  totalIncome: number;
  totalExpense: number;
  totalNet: number;
  points: CashFlowPeriodPoint[];
  baselinePreviousPoint: CashFlowPeriodPoint;
}

export interface CashFlowCategoryComparisonItem {
  id: string | null;
  systemKey: string | null;
  name: string | null;
  icon: string | null;
  color: string | null;
  amount: number;
  previousAmount: number;
  delta: number;
}

export interface CalendarDayTotal {
  date: string;
  income: number;
  expense: number;
}

export interface CalendarMonthData {
  month: string;
  totalIncome: number;
  totalExpense: number;
  totalNet: number;
  dailyTotals: Record<string, CalendarDayTotal>;
  activityDates: Record<string, boolean>;
}

export interface CalendarDayDetails {
  date: string;
  rows: TransactionRow[];
  dayIncome: number;
  dayExpense: number;
}

const DEBT_KINDS = new Set<TransactionKind>([
  'debt_borrow',
  'debt_lend',
  'debt_repay_paid',
  'debt_repay_received',
]);

export function isCashFlowKind(kind: TransactionKind): boolean {
  return kind === 'income' || kind === 'expense';
}

export function isDebtTransactionKind(kind: TransactionKind): boolean {
  return DEBT_KINDS.has(kind);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function assertSafeTotals(
  values: readonly number[],
  errorCode: string,
): void {
  if (values.some((v) => !Number.isSafeInteger(v))) {
    throw new Error(errorCode);
  }
}

async function readTotalsBetween(
  db: Queries,
  from: string,
  to: string,
): Promise<{ income: number; expense: number }> {
  const row = await db.getFirstAsync<{
    income: number | null;
    expense: number | null;
  }>(
    `SELECT
      COALESCE(SUM(CASE WHEN kind='income' THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END), 0) AS expense
     FROM transactions
     WHERE kind IN ('income','expense') AND occurred_on >= ? AND occurred_on <= ?`,
    from,
    to,
  );
  const income = row?.income ?? 0;
  const expense = row?.expense ?? 0;
  assertSafeTotals([income, expense], 'STATS_TOTAL_UNSAFE');
  return { income, expense };
}

function categoryGroupExpressions(level: TrendCategoryLevel) {
  if (level === 'parent') {
    return {
      idExpr: 'CASE WHEN c.parent_id IS NULL THEN c.id ELSE c.parent_id END',
      sysKeyExpr:
        'CASE WHEN c.parent_id IS NULL THEN c.system_key ELSE p.system_key END',
      nameExpr: 'CASE WHEN c.parent_id IS NULL THEN c.name ELSE p.name END',
      iconExpr: 'CASE WHEN c.parent_id IS NULL THEN c.icon ELSE p.icon END',
      colorExpr: 'CASE WHEN c.parent_id IS NULL THEN c.color ELSE p.color END',
    };
  }
  return {
    idExpr: 'c.id',
    sysKeyExpr: 'c.system_key',
    nameExpr: 'c.name',
    iconExpr: 'c.icon',
    colorExpr: 'c.color',
  };
}

async function readCategoryBreakdownBetween(
  db: Queries,
  kind: 'expense' | 'income',
  from: string,
  to: string,
): Promise<DonutCategoryInput[]> {
  const { idExpr, sysKeyExpr, nameExpr, iconExpr, colorExpr } =
    categoryGroupExpressions('parent');
  const rows = await db.getAllAsync<{
    id: string | null;
    systemKey: string | null;
    name: string | null;
    icon: string | null;
    color: string | null;
    amount: number;
  }>(
    `SELECT
      ${idExpr} AS id,
      ${sysKeyExpr} AS systemKey,
      ${nameExpr} AS name,
      ${iconExpr} AS icon,
      ${colorExpr} AS color,
      SUM(t.amount) AS amount
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE t.kind = ? AND t.occurred_on >= ? AND t.occurred_on <= ?
     GROUP BY ${idExpr}, ${sysKeyExpr}, ${nameExpr}, ${iconExpr}, ${colorExpr}
     ORDER BY amount DESC, id`,
    kind,
    from,
    to,
  );
  assertSafeTotals(
    rows.map((r) => r.amount),
    'STATS_CATEGORY_TOTAL_UNSAFE',
  );
  return rows;
}

/**
 * Reads full-month cash flow totals, category breakdowns for both expense and income,
 * and MTD-aware same-period deltas relative to the preceding calendar month.
 */
export async function readIncomeExpenseSituation(
  db: Queries,
  month: string,
  currentDate: string,
): Promise<IncomeExpenseSituation> {
  const monthStart = `${month}-01`;
  monthKey(monthStart);
  validateDate(currentDate);

  const [year, monthNum] = month.split('-').map(Number);
  const monthDays = daysInMonth(year, monthNum);
  const monthEnd = `${month}-${pad2(monthDays)}`;

  const previousMonth = monthKey(addMonths(monthStart, -1));
  const [prevYear, prevMonthNum] = previousMonth.split('-').map(Number);
  const prevMonthDays = daysInMonth(prevYear, prevMonthNum);
  const prevMonthStart = `${previousMonth}-01`;

  const isCurrentMonth = month === currentDate.slice(0, 7);
  const comparisonEndDay = isCurrentMonth
    ? Number(currentDate.slice(8, 10))
    : monthDays;
  const currentCompareEnd = isCurrentMonth ? currentDate : monthEnd;
  const prevClampedDay = isCurrentMonth
    ? Math.min(comparisonEndDay, prevMonthDays)
    : prevMonthDays;
  const previousCompareEnd = `${previousMonth}-${pad2(prevClampedDay)}`;

  const [
    fullTotals,
    currentPeriodTotals,
    previousPeriodTotals,
    expenseCategories,
    incomeCategories,
  ] = await Promise.all([
    readTotalsBetween(db, monthStart, monthEnd),
    isCurrentMonth
      ? readTotalsBetween(db, monthStart, currentCompareEnd)
      : Promise.resolve(null),
    readTotalsBetween(db, prevMonthStart, previousCompareEnd),
    readCategoryBreakdownBetween(db, 'expense', monthStart, monthEnd),
    readCategoryBreakdownBetween(db, 'income', monthStart, monthEnd),
  ]);

  const currentPeriod = currentPeriodTotals ?? fullTotals;

  return {
    month,
    previousMonth,
    comparisonEndDay,
    isCurrentMonth,
    expenseTotal: fullTotals.expense,
    incomeTotal: fullTotals.income,
    currentPeriodExpense: currentPeriod.expense,
    currentPeriodIncome: currentPeriod.income,
    previousPeriodExpense: previousPeriodTotals.expense,
    previousPeriodIncome: previousPeriodTotals.income,
    expenseDelta: currentPeriod.expense - previousPeriodTotals.expense,
    incomeDelta: currentPeriod.income - previousPeriodTotals.income,
    expenseCategories,
    incomeCategories,
  };
}

function formatDateFull(date: string): string {
  const day = pad2(Number(date.slice(8, 10)));
  const month = pad2(Number(date.slice(5, 7)));
  return `${day}/${month}/${date.slice(0, 4)}`;
}

function buildWeekPointTemplate(
  startDate: string,
  offsetDays: number,
  isCurrent: boolean,
  anchorDate: string,
  opts: Required<TrendLabelOptions>,
): CashFlowPeriodPoint {
  const endDate = addDays(startDate, 6);
  const samePeriodEndDate = addDays(startDate, offsetDays);
  const sD = Number(startDate.slice(8, 10));
  const sM = Number(startDate.slice(5, 7));
  const eD = Number(endDate.slice(8, 10));
  const eM = Number(endDate.slice(5, 7));
  const eY = endDate.slice(0, 4);
  const sameMonth = startDate.slice(0, 7) === endDate.slice(0, 7);
  const shortRange = sameMonth
    ? `${pad2(sD)} - ${pad2(eD)}`
    : `${pad2(sD)}/${pad2(sM)} - ${pad2(eD)}/${pad2(eM)}`;
  const fullRange = `${pad2(sD)}/${pad2(sM)} – ${pad2(eD)}/${pad2(eM)}/${eY}`;
  return {
    key: startDate,
    label: isCurrent ? opts.thisWeekLabel : shortRange,
    rangeLabel: fullRange,
    calloutDateLabel: isCurrent ? formatDateFull(anchorDate) : fullRange,
    badgePrimary: `${pad2(sD)} - ${pad2(eD)}`,
    badgeSecondary: opts.monthBadgeTemplate.replace('{month}', String(eM)),
    startDate,
    endDate,
    samePeriodEndDate,
    isCurrent,
    income: 0,
    expense: 0,
    net: 0,
    samePeriodIncome: 0,
    samePeriodExpense: 0,
    samePeriodNet: 0,
  };
}

function buildMonthPointTemplate(
  monthStart: string,
  todayDay: number,
  isCurrent: boolean,
  anchorDate: string,
  opts: Required<TrendLabelOptions>,
): CashFlowPeriodPoint {
  const key = monthKey(monthStart);
  const [yNum, mNum] = key.split('-').map(Number);
  const lastDay = daysInMonth(yNum, mNum);
  const endDate = `${key}-${pad2(lastDay)}`;
  const clampedDay = Math.min(todayDay, lastDay);
  const samePeriodEndDate = `${key}-${pad2(clampedDay)}`;
  const rangeLabel = `${pad2(mNum)}/${yNum}`;
  return {
    key,
    label: isCurrent ? opts.thisMonthLabel : `${opts.monthPrefix}${mNum}`,
    rangeLabel,
    calloutDateLabel: isCurrent ? formatDateFull(anchorDate) : rangeLabel,
    badgePrimary: String(mNum),
    badgeSecondary: String(yNum),
    startDate: `${key}-01`,
    endDate,
    samePeriodEndDate,
    isCurrent,
    income: 0,
    expense: 0,
    net: 0,
    samePeriodIncome: 0,
    samePeriodExpense: 0,
    samePeriodNet: 0,
  };
}

function buildYearPointTemplate(
  year: number,
  anchorMonth: number,
  anchorDay: number,
  isCurrent: boolean,
  anchorDate: string,
  opts: Required<TrendLabelOptions>,
): CashFlowPeriodPoint {
  const clampedDay = Math.min(anchorDay, daysInMonth(year, anchorMonth));
  const samePeriodEndDate = `${year}-${pad2(anchorMonth)}-${pad2(clampedDay)}`;
  const yearLabel = opts.yearLabelTemplate.replace('{year}', String(year));
  return {
    key: String(year),
    label: isCurrent ? opts.thisYearLabel : yearLabel,
    rangeLabel: String(year),
    calloutDateLabel: isCurrent ? formatDateFull(anchorDate) : yearLabel,
    badgePrimary: String(year),
    badgeSecondary: '',
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
    samePeriodEndDate,
    isCurrent,
    income: 0,
    expense: 0,
    net: 0,
    samePeriodIncome: 0,
    samePeriodExpense: 0,
    samePeriodNet: 0,
  };
}

/**
 * Reads rolling cash flow series (6 weeks, 6 months, or 2 consecutive years) with same-period cumulative comparisons.
 */
export async function readCashFlowTrend(
  db: Queries,
  granularity: TrendGranularity,
  anchorDate: string,
  labels: TrendLabelOptions = {},
): Promise<CashFlowTrendResult> {
  validateDate(anchorDate);
  const opts: Required<TrendLabelOptions> = {
    monthPrefix: labels.monthPrefix ?? 'T',
    thisWeekLabel: labels.thisWeekLabel ?? 'Tuần này',
    thisMonthLabel: labels.thisMonthLabel ?? 'Tháng này',
    thisYearLabel: labels.thisYearLabel ?? 'Năm nay',
    monthBadgeTemplate: labels.monthBadgeTemplate ?? 'Tháng {month}',
    yearLabelTemplate: labels.yearLabelTemplate ?? 'Năm {year}',
  };

  const allPoints: CashFlowPeriodPoint[] = [];

  if (granularity === 'week') {
    const currentWeekStart = startOfWeek(anchorDate);
    let offsetDays = 0;
    for (let o = 0; o < 7; o++) {
      if (addDays(currentWeekStart, o) === anchorDate) {
        offsetDays = o;
        break;
      }
    }
    for (let w = 6; w >= 0; w--) {
      allPoints.push(
        buildWeekPointTemplate(
          addDays(currentWeekStart, -w * 7),
          offsetDays,
          w === 0,
          anchorDate,
          opts,
        ),
      );
    }
  } else if (granularity === 'month') {
    const currentMonthStart = `${anchorDate.slice(0, 7)}-01`;
    const todayDay = Number(anchorDate.slice(8, 10));
    for (let m = 6; m >= 0; m--) {
      allPoints.push(
        buildMonthPointTemplate(
          addMonths(currentMonthStart, -m),
          todayDay,
          m === 0,
          anchorDate,
          opts,
        ),
      );
    }
  } else {
    const endYear = Number(anchorDate.slice(0, 4));
    const anchorMonth = Number(anchorDate.slice(5, 7));
    const anchorDay = Number(anchorDate.slice(8, 10));
    for (let y = endYear - 2; y <= endYear; y++) {
      allPoints.push(
        buildYearPointTemplate(
          y,
          anchorMonth,
          anchorDay,
          y === endYear,
          anchorDate,
          opts,
        ),
      );
    }
  }

  const queryStart = allPoints[0].startDate;
  const queryEnd = allPoints[allPoints.length - 1].endDate;

  const rows = await db.getAllAsync<{
    date: string;
    income: number;
    expense: number;
  }>(
    `SELECT occurred_on AS date,
      COALESCE(SUM(CASE WHEN kind='income' THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END), 0) AS expense
     FROM transactions
     WHERE kind IN ('income','expense') AND occurred_on >= ? AND occurred_on <= ?
     GROUP BY occurred_on`,
    queryStart,
    queryEnd,
  );
  assertSafeTotals(
    rows.flatMap((r) => [r.income, r.expense]),
    'STATS_TREND_UNSAFE',
  );

  for (const row of rows) {
    for (const point of allPoints) {
      if (row.date >= point.startDate && row.date <= point.endDate) {
        point.income += row.income;
        point.expense += row.expense;
        if (row.date <= point.samePeriodEndDate) {
          point.samePeriodIncome += row.income;
          point.samePeriodExpense += row.expense;
        }
      }
    }
  }

  for (const point of allPoints) {
    assertSafeTotals(
      [
        point.income,
        point.expense,
        point.samePeriodIncome,
        point.samePeriodExpense,
      ],
      'STATS_TREND_UNSAFE',
    );
    point.net = point.income - point.expense;
    point.samePeriodNet = point.samePeriodIncome - point.samePeriodExpense;
  }

  const [baselinePreviousPoint, ...points] = allPoints;
  const totalIncome = points.reduce((sum, p) => sum + p.income, 0);
  const totalExpense = points.reduce((sum, p) => sum + p.expense, 0);
  assertSafeTotals([totalIncome, totalExpense], 'STATS_TREND_UNSAFE');

  return {
    granularity,
    windowStart: points[0].startDate,
    windowEnd: points[points.length - 1].endDate,
    totalIncome,
    totalExpense,
    totalNet: totalIncome - totalExpense,
    points,
    baselinePreviousPoint,
  };
}

/**
 * Reads active category amounts for a selected period alongside deltas vs the preceding same-period window.
 */
export async function readCashFlowCategoryComparison(
  db: Queries,
  kind: 'income' | 'expense',
  currentRange: { startDate: string; endDate: string },
  previousRange: { startDate: string; endDate: string },
  level: TrendCategoryLevel,
): Promise<CashFlowCategoryComparisonItem[]> {
  validateDate(currentRange.startDate);
  validateDate(currentRange.endDate);
  validateDate(previousRange.startDate);
  validateDate(previousRange.endDate);

  const { idExpr, sysKeyExpr, nameExpr, iconExpr, colorExpr } =
    categoryGroupExpressions(level);

  const rows = await db.getAllAsync<{
    id: string | null;
    systemKey: string | null;
    name: string | null;
    icon: string | null;
    color: string | null;
    amount: number;
    previousAmount: number;
  }>(
    `SELECT
      ${idExpr} AS id,
      ${sysKeyExpr} AS systemKey,
      ${nameExpr} AS name,
      ${iconExpr} AS icon,
      ${colorExpr} AS color,
      COALESCE(SUM(CASE WHEN t.occurred_on >= ? AND t.occurred_on <= ? THEN t.amount ELSE 0 END), 0) AS amount,
      COALESCE(SUM(CASE WHEN t.occurred_on >= ? AND t.occurred_on <= ? THEN t.amount ELSE 0 END), 0) AS previousAmount
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE t.kind = ?
       AND (
         (t.occurred_on >= ? AND t.occurred_on <= ?)
         OR (t.occurred_on >= ? AND t.occurred_on <= ?)
       )
     GROUP BY ${idExpr}, ${sysKeyExpr}, ${nameExpr}, ${iconExpr}, ${colorExpr}
     HAVING amount > 0
     ORDER BY amount DESC, id`,
    currentRange.startDate,
    currentRange.endDate,
    previousRange.startDate,
    previousRange.endDate,
    kind,
    currentRange.startDate,
    currentRange.endDate,
    previousRange.startDate,
    previousRange.endDate,
  );

  assertSafeTotals(
    rows.flatMap((r) => [r.amount, r.previousAmount]),
    'STATS_TREND_CATEGORY_UNSAFE',
  );

  return rows.map((row) => ({
    ...row,
    delta: row.amount - row.previousAmount,
  }));
}

function buildCalendarFilterClause(
  filter: CalendarMonthFilter | undefined,
  from: string,
  to: string,
): { sql: string; params: (string | number | null)[] } {
  const where: string[] = ['occurred_on >= ?', 'occurred_on <= ?'];
  const params: (string | number | null)[] = [from, to];

  if (filter?.walletId) {
    where.push('(wallet_id = ? OR to_wallet_id = ?)');
    params.push(filter.walletId, filter.walletId);
  }
  if (filter?.categoryId) {
    where.push(
      '(category_id = ? OR category_id IN (SELECT id FROM categories WHERE parent_id = ?))',
    );
    params.push(filter.categoryId, filter.categoryId);
  }
  if (filter?.kind && filter.kind !== 'all') {
    if (filter.kind === 'debt') {
      where.push(
        "kind IN ('debt_borrow','debt_lend','debt_repay_paid','debt_repay_received')",
      );
    } else {
      where.push('kind = ?');
      params.push(filter.kind);
    }
  }

  return { sql: where.join(' AND '), params };
}

/**
 * Reads filtered monthly totals and daily cash flow sums plus days having matching transactions.
 */
export async function readCalendarMonthData(
  db: Queries,
  month: string,
  filter?: CalendarMonthFilter,
): Promise<CalendarMonthData> {
  monthKey(`${month}-01`);
  const [year, monthNum] = month.split('-').map(Number);
  const start = `${month}-01`;
  const end = `${month}-${pad2(daysInMonth(year, monthNum))}`;
  const clause = buildCalendarFilterClause(filter, start, end);

  const rows = await db.getAllAsync<{
    date: string;
    income: number;
    expense: number;
    txCount: number;
  }>(
    `SELECT occurred_on AS date,
      SUM(CASE WHEN kind='income' THEN amount ELSE 0 END) AS income,
      SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END) AS expense,
      COUNT(*) AS txCount
     FROM transactions
     WHERE ${clause.sql}
     GROUP BY occurred_on
     ORDER BY occurred_on`,
    ...clause.params,
  );
  assertSafeTotals(
    rows.flatMap((r) => [r.income, r.expense]),
    'CALENDAR_TOTAL_UNSAFE',
  );

  const dailyTotals: Record<string, CalendarDayTotal> = {};
  const activityDates: Record<string, boolean> = {};
  let totalIncome = 0;
  let totalExpense = 0;

  for (const row of rows) {
    dailyTotals[row.date] = {
      date: row.date,
      income: row.income,
      expense: row.expense,
    };
    if (row.txCount > 0) {
      activityDates[row.date] = true;
    }
    totalIncome += row.income;
    totalExpense += row.expense;
  }
  assertSafeTotals([totalIncome, totalExpense], 'CALENDAR_TOTAL_UNSAFE');

  return {
    month,
    totalIncome,
    totalExpense,
    totalNet: totalIncome - totalExpense,
    dailyTotals,
    activityDates,
  };
}

/**
 * Reads all transactions on a single calendar date (unbounded), with cash flow day totals
 * excluding transfers and debt entries.
 */
export async function readCalendarDayTransactions(
  db: Queries,
  date: string,
  filter?: CalendarMonthFilter,
): Promise<CalendarDayDetails> {
  validateDate(date);
  const clause = buildCalendarFilterClause(filter, date, date);

  const rows = await db.getAllAsync<TransactionRow>(
    `SELECT * FROM transactions
     WHERE ${clause.sql}
     ORDER BY occurred_at DESC, id DESC`,
    ...clause.params,
  );

  let dayIncome = 0;
  let dayExpense = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.amount)) {
      throw new Error('CALENDAR_DAY_AMOUNT_UNSAFE');
    }
    if (row.kind === 'income') dayIncome += row.amount;
    else if (row.kind === 'expense') dayExpense += row.amount;
  }
  assertSafeTotals([dayIncome, dayExpense], 'CALENDAR_DAY_AMOUNT_UNSAFE');

  return {
    date,
    rows,
    dayIncome,
    dayExpense,
  };
}
