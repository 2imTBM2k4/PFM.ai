export interface MonthlyFlowPoint {
  month: string;
  income: number;
  expense: number;
}

export const shouldShowDailyTotals = (date: string, currentDate: string) =>
  date <= currentDate;

export interface PeriodSummaryResult {
  totalIncome: number;
  totalExpense: number;
  netSavings: number;
  savingsRatePercent: number;
}

export interface CategoryAllocationItem {
  id: string;
  name: string;
  amount: number;
  percentage: number;
  color: string;
}

const STATS_PALETTE = [
  '#7C5CFF',
  '#FF7AD9',
  '#16A34A',
  '#0EA5E9',
  '#F59E0B',
  '#EC4899',
  '#64748B',
] as const;

/**
 * Aggregates integer income, expense, net savings, and savings rate percentage
 * across a selected time range (1M / 3M / 6M) without floating-point money drift.
 */
export function aggregatePeriodSummary(
  points: readonly MonthlyFlowPoint[],
): PeriodSummaryResult {
  let totalIncome = 0;
  let totalExpense = 0;
  for (const point of points) {
    totalIncome += Math.trunc(point.income);
    totalExpense += Math.trunc(point.expense);
  }
  const netSavings = totalIncome - totalExpense;
  const savingsRatePercent =
    totalIncome > 0 && netSavings > 0
      ? Math.min(100, Math.round((netSavings * 100) / totalIncome))
      : 0;

  return {
    totalIncome,
    totalExpense,
    netSavings,
    savingsRatePercent,
  };
}

/**
 * Computes sorted category allocation items with integer percentages from local expense categories.
 */
export function computeCategoryAllocation(
  categories: readonly {
    id: string | null;
    name: string | null;
    color?: string | null;
    amount: number;
  }[],
  uncategorizedLabel = 'Chưa phân loại',
): { totalExpense: number; items: CategoryAllocationItem[] } {
  const valid = categories
    .filter((row) => Number.isInteger(row.amount) && row.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const totalExpense = valid.reduce((sum, row) => sum + row.amount, 0);
  if (totalExpense <= 0) {
    return { totalExpense: 0, items: [] };
  }

  const items: CategoryAllocationItem[] = valid.map((row, index) => ({
    id: row.id ?? `uncat-${index}`,
    name: row.name ?? uncategorizedLabel,
    amount: row.amount,
    percentage: Math.max(1, Math.round((row.amount * 100) / totalExpense)),
    color: row.color ?? STATS_PALETTE[index % STATS_PALETTE.length],
  }));

  return { totalExpense, items };
}
