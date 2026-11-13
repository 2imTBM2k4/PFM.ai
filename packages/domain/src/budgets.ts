export type BudgetBannerLevel = 'warn' | 'over';

export interface BudgetBannerRowInput {
  id: string;
  category_name?: string | null;
  categoryName?: string | null;
  amount: number;
  warn_percent?: number;
  warnPercent?: number;
  spent: number;
  is_active?: number | boolean;
  isActive?: number | boolean;
  in_period?: number | boolean;
  inPeriod?: number | boolean;
  period_key?: string;
}

export interface BudgetBannerItem {
  budgetId: string;
  categoryName: string | null;
  level: BudgetBannerLevel;
  spent: number;
  amount: number;
  percent: number;
  overBy: number;
  periodKey?: string;
}

function assertValidBudgetNumbers(
  spent: number,
  amount: number,
  warnPercent: number,
): void {
  if (
    !Number.isSafeInteger(spent) ||
    spent < 0 ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !Number.isInteger(warnPercent) ||
    warnPercent < 1 ||
    warnPercent > 100
  ) {
    throw new RangeError('Invalid budget threshold inputs.');
  }
}

export function budgetThresholds(
  spent: number,
  amount: number,
  warnPercent: number,
): number[] {
  assertValidBudgetNumbers(spent, amount, warnPercent);
  const result: number[] = [];
  if (BigInt(spent) * 100n >= BigInt(amount) * BigInt(warnPercent))
    result.push(warnPercent);
  if (spent >= amount && warnPercent !== 100) result.push(100);
  return result;
}

/**
 * Computes active, in-period budget alert banner items for the Overview screen.
 * Emits only 'warn' (at or above warn_percent) and 'over' (at or above 100% limit),
 * sorted with 'over' first and higher percentage first within the same level.
 */
export function budgetBannerItems(
  rows: readonly BudgetBannerRowInput[],
): BudgetBannerItem[] {
  const items: BudgetBannerItem[] = [];

  for (const row of rows) {
    const isActive = row.isActive ?? row.is_active ?? true;
    const inPeriod = row.inPeriod ?? row.in_period ?? true;
    if (!isActive || !inPeriod) continue;

    const warnPercent = row.warnPercent ?? row.warn_percent;
    if (warnPercent === undefined) {
      throw new RangeError('Invalid budget threshold inputs.');
    }
    assertValidBudgetNumbers(row.spent, row.amount, warnPercent);

    const spentBig = BigInt(row.spent);
    const amountBig = BigInt(row.amount);

    let level: BudgetBannerLevel | null = null;
    if (row.spent >= row.amount) {
      level = 'over';
    } else if (
      warnPercent < 100 &&
      spentBig * 100n >= amountBig * BigInt(warnPercent)
    ) {
      level = 'warn';
    }

    if (!level) continue;

    const percent = Number((spentBig * 100n) / amountBig);
    const overBy = row.spent > row.amount ? row.spent - row.amount : 0;
    const categoryName =
      (row.categoryName !== undefined ? row.categoryName : row.category_name) ??
      null;

    items.push({
      ...(row.period_key ? { periodKey: row.period_key } : {}),
      budgetId: row.id,
      categoryName,
      level,
      spent: row.spent,
      amount: row.amount,
      percent,
      overBy,
    });
  }

  items.sort((a, b) => {
    if (a.level !== b.level) {
      return a.level === 'over' ? -1 : 1;
    }
    if (b.percent !== a.percent) {
      return b.percent - a.percent;
    }
    const crossA = BigInt(a.spent) * BigInt(b.amount);
    const crossB = BigInt(b.spent) * BigInt(a.amount);
    if (crossB !== crossA) {
      return crossB > crossA ? 1 : -1;
    }
    if (b.overBy !== a.overBy) {
      return b.overBy - a.overBy;
    }
    return a.budgetId.localeCompare(b.budgetId);
  });

  return items;
}
