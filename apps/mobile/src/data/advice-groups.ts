import {
  AdviceBudgetGroupSchema,
  AdviceExpenseGroupSchema,
  AdviceGoalsGroupSchema,
  AdviceIncomeSourcesGroupSchema,
  AdviceRiskContextGroupSchema,
  type AdviceDataGroup,
  type AdviceDataQualityFlag,
  type AdvicePlanSelection,
  type AdviceRiskFlag,
} from '@pfm/contracts';
import {
  DEFAULT_ADVICE_RANGE_KIND,
  resolveAdviceRange,
  today,
  type AdviceDateRange,
} from '@pfm/domain';

import { readExpenseByCategory } from './advice-insights';
import {
  readPersonalBaseline,
  readSpendingHabits,
  spendingHabitsGroup,
} from './advice-habits';
import { readBudgetMonth } from './budgets';
import { listGoals } from './goals';
import type { Queries } from './migrate';

const ADVICE_CLOCK = {
  now: () => new Date(),
  timeZone: 'Asia/Ho_Chi_Minh',
} as const;

const SAFE_CATEGORY_NAME = /[\u0000-\u001f\u007f]/;

/**
 * Category names reach the model, so keep them short and printable. Names that
 * look like instructions or personal data become a neutral label instead.
 */
export function sanitizeAdviceCategoryName(
  name: string | null | undefined,
  fallback: string,
): string {
  const trimmed = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > 40 || SAFE_CATEGORY_NAME.test(trimmed)) {
    return fallback;
  }
  if (
    /\b(ignore|system|assistant|prompt|instruction|bo qua|chi dan)\b/i.test(
      trimmed,
    )
  ) {
    return fallback;
  }
  return trimmed;
}

function assertSafeMoney(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000_000) {
    throw new Error(code);
  }
}

/**
 * Fill exactly the structured groups the signed plan asks for, using only the
 * stored local data. Nothing else leaves the device.
 */
export async function readAdviceGroups(
  db: Queries,
  selection: AdvicePlanSelection,
  options: {
    fallbackCategoryLabel: string;
    todayIso?: string;
    /** Data quality and stress flags the device already computed. */
    riskContext?: {
      monthsWithData: number;
      riskFlags: AdviceRiskFlag[];
      dataQuality: AdviceDataQualityFlag[];
    };
  },
): Promise<AdviceDataGroup[]> {
  const groups = selection.groups ?? [];
  if (!groups.length) return [];
  const currentDate = options.todayIso ?? today(ADVICE_CLOCK);
  const currentMonth = currentDate.slice(0, 7);

  const result: AdviceDataGroup[] = [];
  for (const group of groups) {
    if (group.kind === 'expense_by_category') {
      const range = resolveAdviceRange(group.rangeKind, currentDate);
      const expenses = await readExpenseByCategory(db, range.from, range.to);
      assertSafeMoney(expenses.totalExpense, 'ADVICE_GROUP_UNSAFE');
      assertSafeMoney(expenses.otherAmount, 'ADVICE_GROUP_UNSAFE');
      assertSafeMoney(expenses.uncategorizedAmount, 'ADVICE_GROUP_UNSAFE');
      result.push(
        AdviceExpenseGroupSchema.parse({
          kind: 'expense_by_category',
          rangeKind: range.kind,
          from: range.from,
          to: range.to,
          totalExpense: expenses.totalExpense,
          topCategories: expenses.topCategories.slice(0, 5).map((item) => ({
            name: sanitizeAdviceCategoryName(
              item.name,
              options.fallbackCategoryLabel,
            ),
            amount: item.amount,
          })),
          otherAmount: expenses.otherAmount,
          uncategorizedAmount: expenses.uncategorizedAmount,
        }),
      );
      continue;
    }

    if (group.kind === 'spending_habits') {
      const range = resolveAdviceRange(group.rangeKind, currentDate);
      const habits = await readSpendingHabits(db, range);
      result.push(
        spendingHabitsGroup({
          ...habits,
          parents: habits.parents.map((parent) => ({
            ...parent,
            name: sanitizeAdviceCategoryName(
              parent.name,
              options.fallbackCategoryLabel,
            ),
            children: parent.children.map((child) => ({
              ...child,
              name: sanitizeAdviceCategoryName(
                child.name,
                options.fallbackCategoryLabel,
              ),
            })),
          })),
        }),
      );
      continue;
    }

    if (group.kind === 'personal_baseline') {
      const range = resolveAdviceRange(DEFAULT_ADVICE_RANGE_KIND, currentDate);
      const baseline = await readPersonalBaseline(db, range, currentDate);
      result.push({
        ...baseline,
        rows: baseline.rows.map((row) => ({
          ...row,
          name: sanitizeAdviceCategoryName(
            row.name,
            options.fallbackCategoryLabel,
          ),
        })),
      });
      continue;
    }

    if (group.kind === 'goals_status') {
      result.push(
        AdviceGoalsGroupSchema.parse(
          await readGoalsGroup(db, currentDate, options.fallbackCategoryLabel),
        ),
      );
      continue;
    }

    if (group.kind === 'income_sources') {
      const range = resolveAdviceRange(group.rangeKind, currentDate);
      result.push(
        AdviceIncomeSourcesGroupSchema.parse(
          await readIncomeSourcesGroup(
            db,
            range,
            currentDate,
            options.fallbackCategoryLabel,
          ),
        ),
      );
      continue;
    }

    if (group.kind === 'risk_context') {
      const context = options.riskContext;
      if (!context) throw new Error('ADVICE_RISK_CONTEXT_MISSING');
      result.push(
        AdviceRiskContextGroupSchema.parse({
          kind: 'risk_context',
          monthsWithData: context.monthsWithData,
          riskFlags: context.riskFlags,
          dataQuality: context.dataQuality,
        }),
      );
      continue;
    }

    const budgets = await readBudgetMonth(db, currentMonth);
    const items = budgets
      .filter((row) => row.is_active === 1 && row.in_period === 1)
      .slice(0, 5)
      .map((row) => {
        const spent = Math.max(0, Math.min(row.amount, row.spent));
        assertSafeMoney(row.amount, 'ADVICE_GROUP_UNSAFE');
        assertSafeMoney(spent, 'ADVICE_GROUP_UNSAFE');
        return {
          name: sanitizeAdviceCategoryName(
            row.category_name ?? undefined,
            options.fallbackCategoryLabel,
          ),
          limitAmount: row.amount,
          spentAmount: spent,
          remainingAmount: Math.max(0, row.amount - spent),
        };
      });
    result.push(
      AdviceBudgetGroupSchema.parse({
        kind: 'budget_status',
        month: currentMonth,
        items,
      }),
    );
  }
  return result;
}

const GOAL_ROW_LIMIT = 5;
const INCOME_SOURCE_LIMIT = 5;

interface GoalRow {
  name: string;
  target_amount: number;
  progress: number;
  deadline_on: string | null;
  status: string;
}

/** Active goals with progress, remaining months and what each needs per month. */
async function readGoalsGroup(
  db: Queries,
  todayIso: string,
  fallbackLabel: string,
) {
  const goals = (await listGoals(db)) as GoalRow[];
  const active = goals.filter((goal) => goal.status !== 'archived');
  const [year, month] = todayIso.split('-').map(Number);
  // Deadlines first (soonest first), then by name, so the model sees a stable order.
  const ordered = [...active].sort((a, b) => {
    if (a.deadline_on && b.deadline_on) {
      return a.deadline_on.localeCompare(b.deadline_on);
    }
    if (a.deadline_on) return -1;
    if (b.deadline_on) return 1;
    return a.name.localeCompare(b.name);
  });

  const rows = ordered.slice(0, GOAL_ROW_LIMIT).map((goal) => {
    const target = Math.max(0, goal.target_amount);
    const saved = Math.max(0, Math.min(target, goal.progress));
    assertSafeMoney(target, 'ADVICE_GOAL_UNSAFE');
    assertSafeMoney(saved, 'ADVICE_GOAL_UNSAFE');
    let monthsLeft: number | null = null;
    let requiredPerMonth: number | null = null;
    if (goal.deadline_on) {
      const [deadlineYear, deadlineMonth] = goal.deadline_on
        .split('-')
        .map(Number);
      const diff = (deadlineYear - year) * 12 + (deadlineMonth - month);
      monthsLeft = Math.max(0, diff);
      if (monthsLeft >= 1) {
        requiredPerMonth = Math.ceil(Math.max(0, target - saved) / monthsLeft);
        assertSafeMoney(requiredPerMonth, 'ADVICE_GOAL_UNSAFE');
      }
    }
    return {
      name: sanitizeAdviceCategoryName(goal.name, fallbackLabel),
      targetAmount: target,
      savedAmount: saved,
      progressPercent:
        target > 0 ? Math.min(100, Math.round((saved * 100) / target)) : 100,
      monthsLeft,
      requiredPerMonth,
    };
  });

  const totalRequiredPerMonth = rows.reduce(
    (sum, row) => sum + (row.requiredPerMonth ?? 0),
    0,
  );
  assertSafeMoney(totalRequiredPerMonth, 'ADVICE_GOAL_UNSAFE');
  return {
    kind: 'goals_status' as const,
    activeCount: active.length,
    totalRequiredPerMonth,
    rows,
  };
}

interface IncomeSourceRow {
  name: string | null;
  amount: number;
  count: number;
}

/** Income grouped by source over one window, with its share of total income. */
async function readIncomeSourcesGroup(
  db: Queries,
  range: AdviceDateRange,
  todayIso: string,
  fallbackLabel: string,
) {
  const { from, to } = range;
  const rows = await db.getAllAsync<IncomeSourceRow>(
    `SELECT
       COALESCE(p.name, c.name) AS name,
       SUM(t.amount) AS amount,
       COUNT(*) AS count
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE t.kind = 'income' AND t.occurred_on >= ? AND t.occurred_on <= ?
     GROUP BY COALESCE(c.parent_id, c.id), COALESCE(p.name, c.name)
     ORDER BY amount DESC, name ASC`,
    from,
    to,
  );
  const totalIncome = rows.reduce((sum, row) => sum + row.amount, 0);
  assertSafeMoney(totalIncome, 'ADVICE_INCOME_UNSAFE');
  if (rows.some((row) => !Number.isSafeInteger(row.amount))) {
    throw new Error('ADVICE_INCOME_UNSAFE');
  }

  const monthsRow = await db.getFirstAsync<{ monthsWithData: number }>(
    `SELECT COUNT(DISTINCT substr(occurred_on, 1, 7)) AS monthsWithData
     FROM transactions WHERE kind = 'income' AND occurred_on <= ?`,
    todayIso,
  );

  return {
    kind: 'income_sources' as const,
    rangeKind: range.kind,
    from,
    to,
    monthsWithData: Math.min(12, Math.max(0, monthsRow?.monthsWithData ?? 0)),
    totalIncome,
    sources: rows
      .filter((row) => row.amount > 0)
      .slice(0, INCOME_SOURCE_LIMIT)
      .map((row) => ({
        name: sanitizeAdviceCategoryName(row.name, fallbackLabel),
        amount: row.amount,
        count: row.count,
        percentPercent:
          totalIncome > 0
            ? Math.min(100, Math.round((row.amount * 100) / totalIncome))
            : 0,
      })),
  };
}
