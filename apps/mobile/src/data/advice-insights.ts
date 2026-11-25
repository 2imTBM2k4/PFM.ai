import type { Queries } from './migrate';
import { AdviceDataGroupSchema } from '@pfm/contracts';
import { addDays, nextOccurrence, validateDate } from '@pfm/domain';
import { listRecurringRules, scheduleOf } from './recurring';

/** Read one pending occurrence per valid rule, without advancing its generation cursor. */
export async function readScheduledDue(
  db: Queries,
  asOf: string,
  through: string,
) {
  validateDate(asOf);
  validateDate(through);
  if (through < asOf) throw new Error('ADVICE_DUE_RANGE');
  const rules = await listRecurringRules(db);
  const items: {
    kind: 'expense' | 'income' | 'transfer';
    amount: number;
    dueOn: string;
    status: 'scheduled';
    paymentStatus: 'unknown';
  }[] = [];
  for (const rule of rules) {
    if (!rule.is_active || rule.blocked || (rule.end_on && rule.end_on < asOf))
      continue;
    const references = await db.getFirstAsync<{ valid: number }>(
      `SELECT EXISTS(SELECT 1 FROM wallets WHERE id=? AND is_archived=0)
       AND (? IS NULL OR EXISTS(SELECT 1 FROM wallets WHERE id=? AND is_archived=0))
       AND (? IS NULL OR EXISTS(SELECT 1 FROM categories WHERE id=? AND is_archived=0)) AS valid`,
      rule.wallet_id,
      rule.to_wallet_id,
      rule.to_wallet_id,
      rule.category_id,
      rule.category_id,
    );
    if (!references?.valid) continue;
    const handledRows = await db.getAllAsync<{ occurred_on: string }>(
      `SELECT occurred_on FROM transactions WHERE recurring_rule_id=? AND occurred_on<=?
       UNION SELECT occurred_on FROM recurring_skips WHERE recurring_rule_id=? AND occurred_on<=?`,
      rule.id,
      through,
      rule.id,
      through,
    );
    const handled = new Set(handledRows.map((row) => row.occurred_on));
    let dueOn = nextOccurrence(
      scheduleOf(rule),
      rule.last_generated_on ?? addDays(rule.start_on, -1),
    );
    while (dueOn && dueOn <= through && handled.has(dueOn))
      dueOn = nextOccurrence(scheduleOf(rule), dueOn);
    if (!dueOn || dueOn > through) continue;
    items.push({
      kind: rule.kind,
      amount: rule.amount,
      dueOn,
      status: 'scheduled',
      paymentStatus: 'unknown',
    });
  }
  items.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  return AdviceDataGroupSchema.parse({
    kind: 'scheduled_due',
    asOf,
    through,
    totalCount: items.length,
    items: items.slice(0, 5),
  });
}

/** Retain uncategorized income and expense separately instead of treating them as absent data. */
export async function readClassificationStatus(
  db: Queries,
  from: string,
  to: string,
) {
  validateDate(from);
  validateDate(to);
  if (from > to) throw new Error('ADVICE_CLASSIFICATION_RANGE');
  const rows = await db.getAllAsync<{
    kind: string;
    count: number;
    amount: number;
  }>(
    `SELECT t.kind, COUNT(*) AS count, SUM(t.amount) AS amount FROM transactions t
     LEFT JOIN categories c ON c.id=t.category_id
     WHERE t.kind IN ('income','expense') AND c.id IS NULL AND t.occurred_on>=? AND t.occurred_on<=?
     GROUP BY t.kind`,
    from,
    to,
  );
  const expense = rows.find((row) => row.kind === 'expense');
  const income = rows.find((row) => row.kind === 'income');
  return {
    expenseCount: expense?.count ?? 0,
    expenseAmount: expense?.amount ?? 0,
    incomeCount: income?.count ?? 0,
    incomeAmount: income?.amount ?? 0,
  };
}

export interface AdviceCategoryItem {
  /** Category name as stored locally (custom names are shown as-is). */
  name: string;
  /** System category key when the local name can be translated safely. */
  systemKey: string | null;
  amount: number;
}

export interface ExpenseByCategory {
  totalExpense: number;
  topCategories: AdviceCategoryItem[];
  /** Every remaining group after the top five, already summed. */
  otherAmount: number;
  /** Expense rows with no category, included in `totalExpense`. */
  uncategorizedAmount: number;
  uncategorizedCount: number;
  transactionCount: number;
  hasData: boolean;
}

export interface CashFlow {
  totalIncome: number;
  totalExpense: number;
  net: number;
  incomeCount: number;
  expenseCount: number;
  hasData: boolean;
}

/** The factual payload shape the on-device answer builder consumes. */
export type AdviceFactData =
  | {
      kind: 'expense_by_category';
      totalExpense: number;
      topCategories: AdviceCategoryItem[];
      otherAmount: number;
      uncategorizedAmount: number;
      transactionCount: number;
    }
  | {
      kind: 'cash_flow';
      totalIncome: number;
      totalExpense: number;
      net: number;
      incomeCount: number;
      expenseCount: number;
    };

interface CategoryRow {
  name: string | null;
  systemKey: string | null;
  amount: number;
}

function assertSafeMoney(rows: { amount: number }[], errorCode: string): void {
  if (rows.some((row) => !Number.isSafeInteger(row.amount))) {
    throw new Error(errorCode);
  }
}

function toCategoryItem(row: CategoryRow): AdviceCategoryItem {
  return {
    name: row.name ?? '',
    systemKey: row.systemKey,
    amount: row.amount,
  };
}

/**
 * Sum real expenses in one local date window, grouping child categories into
 * their parent and never counting transfers or debt repayments as spending.
 */
export async function readExpenseByCategory(
  db: Queries,
  from: string,
  to: string,
): Promise<ExpenseByCategory> {
  const rows = await db.getAllAsync<CategoryRow>(
    `SELECT
       COALESCE(p.name, c.name) AS name,
       COALESCE(p.system_key, c.system_key) AS systemKey,
       SUM(t.amount) AS amount
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE t.kind = 'expense' AND t.occurred_on >= ? AND t.occurred_on <= ?
     GROUP BY COALESCE(c.parent_id, c.id), COALESCE(p.name, c.name), COALESCE(p.system_key, c.system_key)
     ORDER BY amount DESC, name ASC`,
    from,
    to,
  );
  assertSafeMoney(rows, 'ADVICE_EXPENSE_UNSAFE');

  const totals = await db.getFirstAsync<{
    totalExpense: number;
    transactionCount: number;
    uncategorizedAmount: number;
    uncategorizedCount: number;
  }>(
    `SELECT
       COALESCE(SUM(amount), 0) AS totalExpense,
       COUNT(*) AS transactionCount,
       COALESCE(SUM(CASE WHEN category_id IS NULL THEN amount ELSE 0 END), 0) AS uncategorizedAmount,
       COALESCE(SUM(CASE WHEN category_id IS NULL THEN 1 ELSE 0 END), 0) AS uncategorizedCount
     FROM transactions
     WHERE kind = 'expense' AND occurred_on >= ? AND occurred_on <= ?`,
    from,
    to,
  );

  const totalExpense = totals?.totalExpense ?? 0;
  const transactionCount = totals?.transactionCount ?? 0;
  const uncategorizedAmount = totals?.uncategorizedAmount ?? 0;
  const uncategorizedCount = totals?.uncategorizedCount ?? 0;
  if (
    !Number.isSafeInteger(totalExpense) ||
    !Number.isSafeInteger(uncategorizedAmount)
  ) {
    throw new Error('ADVICE_EXPENSE_UNSAFE');
  }

  const topCategories = rows
    .filter((row) => row.amount > 0 && row.name !== null && row.name !== '')
    .slice(0, 5)
    .map(toCategoryItem);
  const topSum = topCategories.reduce((sum, item) => sum + item.amount, 0);

  return {
    totalExpense,
    topCategories,
    otherAmount: Math.max(0, totalExpense - topSum),
    uncategorizedAmount,
    uncategorizedCount,
    transactionCount,
    hasData: transactionCount > 0,
  };
}

/**
 * Sum income and expense in one local date window. Transfers and debt movements
 * are intentionally excluded so the totals match the Statistics calendar.
 */
export async function readCashFlow(
  db: Queries,
  from: string,
  to: string,
): Promise<CashFlow> {
  const row = await db.getFirstAsync<{
    totalIncome: number;
    totalExpense: number;
    incomeCount: number;
    expenseCount: number;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN kind = 'income' THEN amount ELSE 0 END), 0) AS totalIncome,
       COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END), 0) AS totalExpense,
       COALESCE(SUM(CASE WHEN kind = 'income' THEN 1 ELSE 0 END), 0) AS incomeCount,
       COALESCE(SUM(CASE WHEN kind = 'expense' THEN 1 ELSE 0 END), 0) AS expenseCount
     FROM transactions
     WHERE kind IN ('income', 'expense') AND occurred_on >= ? AND occurred_on <= ?`,
    from,
    to,
  );

  const totalIncome = row?.totalIncome ?? 0;
  const totalExpense = row?.totalExpense ?? 0;
  if (
    !Number.isSafeInteger(totalIncome) ||
    !Number.isSafeInteger(totalExpense)
  ) {
    throw new Error('ADVICE_CASH_FLOW_UNSAFE');
  }
  const incomeCount = row?.incomeCount ?? 0;
  const expenseCount = row?.expenseCount ?? 0;
  return {
    totalIncome,
    totalExpense,
    net: totalIncome - totalExpense,
    incomeCount,
    expenseCount,
    hasData: incomeCount + expenseCount > 0,
  };
}
