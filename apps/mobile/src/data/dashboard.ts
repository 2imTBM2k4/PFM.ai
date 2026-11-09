import { addMonths, daysInMonth, monthKey, ratioBps } from '@pfm/domain';
import type { Queries } from './migrate';
import { readBudgetMonth, readDismissedBudgetBannerKeys } from './budgets';
import { listGoals } from './goals';
import { listTransactions } from './transactions';
import { listWallets } from './repository';

interface MonthTotals {
  month: string;
  income: number;
  expense: number;
  net: number;
}
export interface CategoryTotal {
  id: string | null;
  name: string | null;
  amount: number;
}

export interface DailyTotals {
  date: string;
  income: number;
  expense: number;
}

export async function readDailyTotals(db: Queries, month: string): Promise<DailyTotals[]> {
  monthKey(`${month}-01`);
  const [year, number] = month.split('-').map(Number);
  const end = `${month}-${String(daysInMonth(year, number)).padStart(2, '0')}`;
  const rows = await db.getAllAsync<DailyTotals>(
    `SELECT occurred_on AS date,
      SUM(CASE WHEN kind='income' THEN amount ELSE 0 END) AS income,
      SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END) AS expense
     FROM transactions WHERE kind IN ('income','expense') AND occurred_on>=? AND occurred_on<=?
     GROUP BY occurred_on ORDER BY occurred_on`,
    `${month}-01`,
    end,
  );
  if (rows.some((row) => !Number.isSafeInteger(row.income) || !Number.isSafeInteger(row.expense)))
    throw new Error('DAILY_TOTAL_UNSAFE');
  return rows;
}

// Read one consistent overview inside the application's serialized database queue.
export async function readDashboard(db: Queries, month: string) {
  const date = `${month}-01`;
  monthKey(date);
  const first = addMonths(date, -5);
  const [year, number] = month.split('-').map(Number);
  const last = `${month}-${String(daysInMonth(year, number)).padStart(2, '0')}`;
  const totals = await db.getAllAsync<MonthTotals>(
    `SELECT substr(occurred_on,1,7) month,
    SUM(CASE WHEN kind='income' THEN amount ELSE 0 END) income,
    SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END) expense
    FROM transactions WHERE kind IN ('income','expense') AND occurred_on>=? AND occurred_on<=?
    GROUP BY substr(occurred_on,1,7)`,
    first,
    last,
  );
  const months = Array.from({ length: 6 }, (_, i) => {
    const key = monthKey(addMonths(first, i));
    const row = totals.find((value) => value.month === key);
    const income = row?.income ?? 0,
      expense = row?.expense ?? 0;
    if (!Number.isSafeInteger(income) || !Number.isSafeInteger(expense))
      throw new Error('DASHBOARD_TOTAL_UNSAFE');
    return { month: key, income, expense, net: income - expense };
  });
  const current = months[5],
    previous = months[4];
  const categories = await db.getAllAsync<CategoryTotal>(
    `SELECT
    CASE WHEN c.parent_id IS NULL THEN c.id ELSE c.parent_id END id,
    COALESCE(p.name,c.name) name,SUM(t.amount) amount
    FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
    LEFT JOIN categories p ON p.id=c.parent_id
    WHERE t.kind='expense' AND t.occurred_on>=? AND t.occurred_on<=?
    GROUP BY CASE WHEN c.parent_id IS NULL THEN c.id ELSE c.parent_id END,COALESCE(p.name,c.name)
    ORDER BY amount DESC,id`,
    date,
    last,
  );
  if (categories.some((row) => !Number.isSafeInteger(row.amount)))
    throw new Error('DASHBOARD_TOTAL_UNSAFE');
  const topCategories = categories.slice(0, 6);
  const otherCategoryAmount = categories
    .slice(6)
    .reduce((sum, row) => sum + row.amount, 0);
  const wallets = await listWallets(db, true);
  if (wallets.some((wallet) => !Number.isSafeInteger(wallet.balance)))
    throw new Error('DASHBOARD_TOTAL_UNSAFE');
  const balance = wallets
    .filter((wallet) => !wallet.is_archived)
    .reduce((sum, wallet) => sum + wallet.balance, 0);
  if (!Number.isSafeInteger(balance)) throw new Error('DASHBOARD_TOTAL_UNSAFE');
  return {
    wallets,
    balance,
    current,
    months,
    categories,
    topCategories,
    otherCategoryAmount,
    incomeChangeBps: ratioBps(
      current.income - previous.income,
      previous.income,
    ),
    expenseChangeBps: ratioBps(
      current.expense - previous.expense,
      previous.expense,
    ),
    budgets: (await readBudgetMonth(db, month)).filter(
      (row) => row.is_active && row.in_period,
    ),
    dismissedBudgetBannerKeys: await readDismissedBudgetBannerKeys(db, month),
    goals: (await listGoals(db)).filter((row) => row.status !== 'archived'),
    recent: (
      await listTransactions(db, undefined, { from: date, to: last })
    ).slice(0, 5),
  };
}
export type Dashboard = Awaited<ReturnType<typeof readDashboard>>;
