import { type AnalysisSummary, AnalysisSummarySchema } from '@pfm/contracts';
import {
  addMonths,
  buildAnalysisSummary,
  type CategoryBreakdown,
  daysInMonth,
  monthKey,
  type MonthlyRecord,
  roundHalfUp,
} from '@pfm/domain';

import { readDebtBalances } from './debt-balances';
import { essentialExpensePredicate } from './essential-expense';
import { listGoals } from './goals';
import type { Queries } from './migrate';
import { listWallets } from './repository';

interface MonthAggregates {
  monthKey: string;
  income: number;
  expense: number;
  fixedExpense: number;
  variableExpense: number;
  debtRepayPaid: number;
  uncategorizedExpense: number;
}

interface CategoryRow {
  system_key: string | null;
  totalExpense: number;
  lastMonthExpense: number;
  prevMonthExpense: number;
}

interface CurrentMonthRow {
  incomeSoFar: number;
  expenseSoFar: number;
}

interface RecurringRow {
  amount: number;
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval_count: number;
}

// Convert recurring rule interval into an equivalent monthly commitment.
function toMonthlyRecurringAmount(
  amount: number,
  frequency: RecurringRow['frequency'],
  intervalCount: number,
): number {
  const intervals = Math.max(1, intervalCount);
  switch (frequency) {
    case 'monthly':
      return roundHalfUp(amount, intervals);
    case 'yearly':
      return roundHalfUp(amount, 12 * intervals);
    case 'weekly':
      return roundHalfUp(amount * 52, 12 * intervals);
    case 'daily':
      return roundHalfUp(amount * 365, 12 * intervals);
    default:
      return amount;
  }
}

// Read an AnalysisSummary snapshot directly from SQLite for the AI request pipeline.
export async function readAnalysisSummary(
  db: Queries,
  forDate: string,
  monthsRequested = 6,
): Promise<AnalysisSummary> {
  const currentMonthKey = forDate.slice(0, 7);
  const dayOfMonth = parseInt(forDate.slice(8, 10), 10);

  // Determine window of complete calendar months prior to currentMonth
  const lastCompleteMonthKey = monthKey(addMonths(`${currentMonthKey}-01`, -1));
  const firstCompleteMonthKey = monthKey(
    addMonths(`${currentMonthKey}-01`, -monthsRequested),
  );
  const windowStartDate = `${firstCompleteMonthKey}-01`;

  const [lastYear, lastMonth] = lastCompleteMonthKey.split('-').map(Number);
  const windowEndDate = `${lastCompleteMonthKey}-${String(
    daysInMonth(lastYear, lastMonth),
  ).padStart(2, '0')}`;

  const prevToLastMonthKey = monthKey(addMonths(`${currentMonthKey}-01`, -2));

  // 1. Earliest income/expense transaction month
  const firstTxRow = await db.getFirstAsync<{ firstMonth: string | null }>(
    `SELECT MIN(substr(occurred_on, 1, 7)) as firstMonth
     FROM transactions
     WHERE kind IN ('income', 'expense')`,
  );
  const firstTransactionMonth = firstTxRow?.firstMonth ?? null;

  // 2. Complete months aggregated data
  const monthlyRows = await db.getAllAsync<MonthAggregates>(
    `SELECT
      substr(t.occurred_on, 1, 7) as monthKey,
      COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount ELSE 0 END), 0) as expense,
      COALESCE(SUM(CASE WHEN t.kind = 'expense' AND (COALESCE(c.is_fixed_cost, 0) = 1 OR t.recurring_rule_id IS NOT NULL) THEN t.amount ELSE 0 END), 0) as fixedExpense,
      COALESCE(SUM(CASE WHEN t.kind = 'expense' AND COALESCE(c.is_fixed_cost, 0) = 0 AND t.recurring_rule_id IS NULL THEN t.amount ELSE 0 END), 0) as variableExpense,
      COALESCE(SUM(CASE WHEN t.kind = 'debt_repay_paid' THEN t.amount ELSE 0 END), 0) as debtRepayPaid,
      COALESCE(SUM(CASE WHEN t.kind = 'expense' AND t.category_id IS NULL THEN t.amount ELSE 0 END), 0) as uncategorizedExpense
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.occurred_on >= ? AND t.occurred_on <= ?
    GROUP BY substr(t.occurred_on, 1, 7)`,
    windowStartDate,
    windowEndDate,
  );

  const completeMonths: MonthlyRecord[] = Array.from(
    { length: monthsRequested },
    (_, i) => {
      const key = monthKey(addMonths(windowStartDate, i));
      const row = monthlyRows.find((r) => r.monthKey === key);
      return {
        monthKey: key,
        income: row?.income ?? 0,
        expense: row?.expense ?? 0,
        fixedExpense: row?.fixedExpense ?? 0,
        variableExpense: row?.variableExpense ?? 0,
        debtRepayPaid: row?.debtRepayPaid ?? 0,
        uncategorizedExpense: row?.uncategorizedExpense ?? 0,
      };
    },
  );

  // 3. Essential expense over the same window, for emergency-fund sizing.
  const essential = essentialExpensePredicate();
  const essentialRow = await db.getFirstAsync<{ total: number | null }>(
    `SELECT COALESCE(SUM(t.amount), 0) AS total
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE t.kind = 'expense' AND t.occurred_on >= ? AND t.occurred_on <= ?
       AND (${essential.sql})`,
    windowStartDate,
    windowEndDate,
    ...essential.params,
  );
  const essentialExpenseTotal = essentialRow?.total ?? 0;
  if (!Number.isSafeInteger(essentialExpenseTotal)) {
    throw new Error('ESSENTIAL_EXPENSE_UNSAFE');
  }

  // 4. Category breakdown
  const categoryRows = await db.getAllAsync<CategoryRow>(
    `SELECT
      COALESCE(p.system_key, c.system_key) as system_key,
      COALESCE(SUM(t.amount), 0) as totalExpense,
      COALESCE(SUM(CASE WHEN substr(t.occurred_on, 1, 7) = ? THEN t.amount ELSE 0 END), 0) as lastMonthExpense,
      COALESCE(SUM(CASE WHEN substr(t.occurred_on, 1, 7) = ? THEN t.amount ELSE 0 END), 0) as prevMonthExpense
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories p ON p.id = c.parent_id
    WHERE t.kind = 'expense' AND t.occurred_on >= ? AND t.occurred_on <= ?
    GROUP BY COALESCE(p.system_key, c.system_key)`,
    lastCompleteMonthKey,
    prevToLastMonthKey,
    windowStartDate,
    windowEndDate,
  );

  const categories: CategoryBreakdown[] = categoryRows.map((cat) => ({
    key: cat.system_key ?? 'custom',
    isCustom: cat.system_key === null,
    totalExpense: cat.totalExpense,
    lastMonthExpense: cat.lastMonthExpense,
    prevMonthExpense: cat.prevMonthExpense,
  }));

  // 5. Current month to date
  const currentMonthStart = `${currentMonthKey}-01`;
  const currentMonthRow = await db.getFirstAsync<CurrentMonthRow>(
    `SELECT
      COALESCE(SUM(CASE WHEN kind = 'income' THEN amount ELSE 0 END), 0) as incomeSoFar,
      COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END), 0) as expenseSoFar
    FROM transactions
    WHERE occurred_on >= ? AND occurred_on <= ?`,
    currentMonthStart,
    forDate,
  );

  // 6. Commitments: active recurring expenses
  const recurringRows = await db.getAllAsync<RecurringRow>(
    `SELECT amount, frequency, interval_count
     FROM recurring_rules
     WHERE is_active = 1 AND kind = 'expense'`,
  );
  const recurringMonthlyTotal = recurringRows.reduce((sum, r) => {
    return (
      sum + toMonthlyRecurringAmount(r.amount, r.frequency, r.interval_count)
    );
  }, 0);

  // 7. Savings & Wallets
  const allWallets = await listWallets(db, true);
  const activeWallets = allWallets.filter((w) => !w.is_archived);
  const liquidWallets = activeWallets.filter((w) => w.kind !== 'credit_card');
  const liquidBalance = liquidWallets.reduce(
    (sum, w) => sum + Math.max(0, w.balance),
    0,
  );

  const goalFundingWallets = activeWallets.filter((w) => w.is_goal_funding);
  const availableForGoals =
    goalFundingWallets.length > 0
      ? goalFundingWallets.reduce((sum, w) => sum + Math.max(0, w.balance), 0)
      : liquidBalance;

  // 8. Debts
  const debtRows = await readDebtBalances(db);
  const outstandingBorrowed = debtRows
    .filter((d) => d.direction === 'borrowed' && d.status === 'open')
    .reduce((sum, d) => sum + d.outstanding, 0);
  const outstandingLent = debtRows
    .filter((d) => d.direction === 'lent' && d.status === 'open')
    .reduce((sum, d) => sum + d.outstanding, 0);

  // 9. Goals
  const allGoals = await listGoals(db);
  const activeGoals = allGoals
    .filter((g) => g.status !== 'archived')
    .map((g) => ({
      targetAmount: g.target_amount,
      currentAmount: g.progress,
      deadline: g.deadline_on,
    }));

  const rawSummary = buildAnalysisSummary({
    generatedForDate: forDate,
    monthsRequested,
    firstTransactionMonth,
    completeMonths,
    categories,
    currentMonth: {
      incomeSoFar: currentMonthRow?.incomeSoFar ?? 0,
      expenseSoFar: currentMonthRow?.expenseSoFar ?? 0,
      dayOfMonth,
    },
    recurringMonthlyTotal,
    liquidBalance,
    availableForGoals,
    essentialExpenseTotal,
    goals: activeGoals,
    debts: {
      outstandingBorrowed,
      outstandingLent,
    },
  });

  return AnalysisSummarySchema.parse(rawSummary);
}
