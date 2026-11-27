import {
  AdviceToolContextSchema as ToolContextSchema,
  GetTransactionsParamsSchema as GetTransactionsSchema,
  CalculateBudgetStatusParamsSchema as BudgetStatusSchema,
  PlanSavingsGoalParamsSchema as SavingsGoalSchema,
  GetFinancialSnapshotParamsSchema as SnapshotSchema,
  GetSpendingBreakdownParamsSchema as SpendingBreakdownSchema,
  GetUpcomingObligationsParamsSchema as UpcomingObligationsSchema,
  GetSavingsGoalsParamsSchema as SavingsGoalsSchema,
  ConversationStateSchema,
  isDurationFact,
  isMoneyFact,
  type GetTransactionsParams,
  type CalculateBudgetStatusParams,
  type PlanSavingsGoalParams,
  type GetFinancialSnapshotParams,
  type GetSpendingBreakdownParams,
  type GetUpcomingObligationsParams,
  type GetSavingsGoalsParams,
  type ConversationState,
  type ToolErrorCode,
  type ToolResult,
} from '@pfm/contracts';
import {
  CALCULATION_VERSION,
  addDays,
  addMonths,
  nextOccurrence,
  today,
  normalizeAdviceInputs,
  calculateAdviceInputs,
} from '@pfm/domain';
import { withDatabase } from '@/data/connection';
import { listTransactions } from '@/data/transactions';
import { readBudgetMonth } from '@/data/budgets';
import { readAnalysisSummary } from '@/data/analysis';
import { readCashFlow } from '@/data/advice-insights';
import { listRecurringRules, scheduleOf } from '@/data/recurring';
import { readDebtBalances } from '@/data/debt-balances';
import { listGoals } from '@/data/goals';
import { getScenarioFactIds } from './advice-context';

interface ToolContext {
  sessionId: string;
  stateRevision: number;
}
interface DispatchContext extends ToolContext {
  state?: ConversationState;
  deadline: number;
}
function failure(code: ToolErrorCode): ToolResult<never> {
  return { status: 'error', code, retryable: false };
}
function success<T>(
  data: T,
  context: ToolContext,
  truncated?: boolean,
): ToolResult<T> {
  return {
    status: 'ok',
    data,
    stateRevision: context.stateRevision,
    calculationVersion: CALCULATION_VERSION,
    ...(truncated === undefined ? {} : { truncated }),
  };
}

/** Return only permitted ledger fields; amounts are booked VND, not original-currency values. */
async function executeGetTransactions(
  params: GetTransactionsParams,
  context: ToolContext,
) {
  const rows = await withDatabase((db) =>
    listTransactions(db, undefined, {
      from: params.from,
      to: params.to,
      ...(params.kind === null ? {} : { kind: params.kind }),
      ...(params.category_id === null
        ? {}
        : { categoryId: params.category_id }),
    }),
  );
  const truncated = rows.length > params.limit;
  return success(
    {
      transactions: rows.slice(0, params.limit).map((row) => ({
        id: row.id,
        date: row.occurred_on,
        amount: row.amount,
        currency: 'VND' as const,
        kind: row.kind,
        category_id: row.category_id,
      })),
      truncated,
    },
    context,
    truncated,
  );
}

/** Preserve actual spending and report only active monthly budgets within the requested month. */
async function executeCalculateBudgetStatus(
  params: CalculateBudgetStatusParams,
  context: ToolContext,
) {
  const rows = await withDatabase((db) =>
    readBudgetMonth(db, params.month, params.budget_id ?? undefined),
  );
  return success(
    {
      budgets: rows
        .filter(
          (row) =>
            row.is_active === 1 &&
            row.in_period === 1 &&
            (row.period_type ?? 'monthly') === 'monthly',
        )
        .map((row) => ({
          id: row.id,
          category_id: row.category_id,
          limit_amount: row.amount,
          spent_amount: row.spent,
          remaining_amount: Math.max(0, row.amount - row.spent),
          overspent_amount: Math.max(0, row.spent - row.amount),
        })),
    },
    context,
  );
}

/** Calculate the verified active scenario using domain normalization and arithmetic only. */
async function executePlanSavingsGoal(
  _params: PlanSavingsGoalParams,
  context: DispatchContext,
): Promise<ToolResult> {
  const parsed = ConversationStateSchema.safeParse(context.state);
  if (
    !parsed.success ||
    parsed.data.sessionId !== context.sessionId ||
    parsed.data.revision !== context.stateRevision
  )
    return failure('STATE_ERROR');
  const state = parsed.data;
  const scenario = state.activeScenario;
  const { income, expenseTotal, goalTarget, savingsMonths, savingsForGoal } =
    scenario;
  const required = [
    'income',
    'expenseTotal',
    'goalTarget',
    'savingsMonths',
    'savingsForGoal',
  ] as const;
  if (
    income.status === 'unknown' ||
    expenseTotal.status === 'unknown' ||
    goalTarget.status === 'unknown' ||
    savingsMonths.status === 'unknown' ||
    savingsForGoal.status === 'unknown'
  )
    return {
      status: 'needs_clarification',
      fields: required.filter((field) => scenario[field].status === 'unknown'),
    };

  const byId = new Map(state.facts.map((fact) => [fact.id, fact]));
  const referenced = getScenarioFactIds(scenario);
  // Include correction ancestors in stored order: the domain validator requires a complete chain.
  for (const id of referenced) {
    const previousId = byId.get(id)?.supersedes_id;
    if (previousId) referenced.add(previousId);
  }
  const facts = state.facts.filter((fact) => referenced.has(fact.id));
  if (
    facts.some(
      (fact) =>
        fact.mode !== scenario.mode ||
        (isMoneyFact(fact) && fact.currency !== scenario.currency),
    )
  )
    return failure('STATE_ERROR');
  for (const slot of [income, expenseTotal, goalTarget, savingsForGoal]) {
    const fact = byId.get(slot.factIds[0]);
    if (
      slot.factIds.length === 1 &&
      (!fact || !isMoneyFact(fact) || fact.amount !== slot.value)
    )
      return failure('STATE_ERROR');
  }
  const durationFact = byId.get(savingsMonths.factIds[0]);
  if (
    savingsMonths.factIds.length === 1 &&
    (!durationFact ||
      !isDurationFact(durationFact) ||
      durationFact.months !== savingsMonths.value)
  )
    return failure('STATE_ERROR');
  const normalized = normalizeAdviceInputs(facts, null, {
    mode: scenario.mode,
    currency: scenario.currency,
    cashFlowBasis:
      scenario.cashFlowBasis.status === 'known'
        ? scenario.cashFlowBasis.value
        : undefined,
    savingsForGoal: savingsForGoal.value,
    savingsMonths: savingsMonths.value,
  });
  if (!normalized.ok) {
    if (
      normalized.needsClarification.some(
        (field) => field === 'conversationFacts' || field === 'amount',
      )
    )
      return failure('STATE_ERROR');
    return {
      status: 'needs_clarification',
      fields: normalized.needsClarification,
    };
  }
  const calculation = calculateAdviceInputs(normalized.result);
  if (
    normalized.result.goal === null ||
    calculation.requiredMonthlySaving === null ||
    calculation.remainingAfterGoal === null
  )
    return failure('STATE_ERROR');
  return success(
    {
      monthlyAvailable: calculation.surplusBeforeGoal,
      requiredMonthlySaving: calculation.requiredMonthlySaving,
      remainingAfterSaving: calculation.remainingAfterGoal,
      months: savingsMonths.value,
      goalAmount: normalized.result.goal.amount,
      savingsForGoal: savingsForGoal.value,
    },
    context,
  );
}

/** Read historical averages and current liquidity without returning the underlying summary. */
async function executeGetFinancialSnapshot(
  params: GetFinancialSnapshotParams,
  context: ToolContext,
) {
  const date = today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' });
  const monthStart = `${date.slice(0, 7)}-01`;
  const summary = await withDatabase((db) =>
    readAnalysisSummary(db, date, params.months),
  );
  const monthsWithData = summary.window.monthsWithData;
  const values = {
    monthly_income_avg: monthsWithData ? summary.income.monthlyAvg : null,
    monthly_expense_avg: monthsWithData ? summary.expense.monthlyAvg : null,
    liquid_balance: summary.savings.liquidBalance,
    months_with_data: monthsWithData,
  };
  return success(
    {
      indicators: Object.fromEntries(
        params.fields.map((field) => [field, values[field]]),
      ),
      period: {
        from: addMonths(monthStart, -params.months),
        to: addDays(monthStart, -1),
      },
      currency: summary.currency,
      // Coverage only; complete does not imply the absence of other quality warnings.
      dataQuality:
        monthsWithData === 0
          ? 'insufficient'
          : monthsWithData < params.months
            ? 'partial'
            : 'complete',
    },
    context,
  );
}

/** Read aggregated income, expense, net cash flow, and top parent categories without free-text names. */
async function executeGetSpendingBreakdown(
  params: GetSpendingBreakdownParams,
  context: ToolContext,
) {
  const data = await withDatabase(async (db) => {
    const cashFlow = await readCashFlow(db, params.from, params.to);
    const rows = await db.getAllAsync<{
      category_id: string | null;
      system_key: string | null;
      amount: number;
    }>(
      `SELECT
         COALESCE(c.parent_id, c.id) AS category_id,
         COALESCE(p.system_key, c.system_key) AS system_key,
         SUM(t.amount) AS amount
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN categories p ON p.id = c.parent_id
       WHERE t.kind = 'expense' AND t.occurred_on >= ? AND t.occurred_on <= ?
       GROUP BY COALESCE(c.parent_id, c.id), COALESCE(p.system_key, c.system_key)
       ORDER BY amount DESC, category_id ASC`,
      params.from,
      params.to,
    );
    const uncategorized = await db.getFirstAsync<{ amount: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS amount
       FROM transactions
       WHERE kind = 'expense' AND category_id IS NULL AND occurred_on >= ? AND occurred_on <= ?`,
      params.from,
      params.to,
    );
    const uncategorizedAmount = uncategorized?.amount ?? 0;
    if (
      !Number.isSafeInteger(uncategorizedAmount) ||
      rows.some((row) => !Number.isSafeInteger(row.amount))
    )
      throw new Error('ADVICE_EXPENSE_UNSAFE');
    const topCategories = rows
      .filter((row) => row.amount > 0 && row.category_id !== null)
      .slice(0, 5)
      .map((row) => ({
        category_id: row.category_id,
        system_key: row.system_key,
        amount: row.amount,
      }));
    const topSum = topCategories.reduce((sum, item) => sum + item.amount, 0);
    return {
      period: { from: params.from, to: params.to },
      currency: 'VND' as const,
      total_income: cashFlow.totalIncome,
      total_expense: cashFlow.totalExpense,
      net: cashFlow.net,
      top_categories: topCategories,
      other_amount: Math.max(0, cashFlow.totalExpense - topSum),
      uncategorized_amount: uncategorizedAmount,
      transaction_count: cashFlow.incomeCount + cashFlow.expenseCount,
    };
  });
  return success(data, context);
}

/** Read upcoming scheduled recurring items and aggregated open debt totals without PII labels or notes. */
async function executeGetUpcomingObligations(
  params: GetUpcomingObligationsParams,
  context: ToolContext,
) {
  const asOf = today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' });
  const through = addDays(asOf, params.days_ahead);
  const data = await withDatabase(async (db) => {
    const rules = await listRecurringRules(db);
    const dueItems: {
      kind: 'expense' | 'income' | 'transfer';
      amount: number;
      due_on: string;
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
      dueItems.push({ kind: rule.kind, amount: rule.amount, due_on: dueOn });
    }
    dueItems.sort((left, right) => left.due_on.localeCompare(right.due_on));
    let totalExpense = 0;
    let totalIncome = 0;
    for (const item of dueItems) {
      if (item.kind === 'expense') totalExpense += item.amount;
      if (item.kind === 'income') totalIncome += item.amount;
    }
    const debts = await readDebtBalances(db);
    let borrowedOutstanding = 0;
    let lentOutstanding = 0;
    let openBorrowedCount = 0;
    let openLentCount = 0;
    let nearestDueOn: string | null = null;
    for (const debt of debts) {
      if (debt.status !== 'open') continue;
      if (debt.direction === 'borrowed') {
        borrowedOutstanding += debt.outstanding;
        openBorrowedCount += 1;
      } else {
        lentOutstanding += debt.outstanding;
        openLentCount += 1;
      }
      if (debt.due_on && (nearestDueOn === null || debt.due_on < nearestDueOn))
        nearestDueOn = debt.due_on;
    }
    return {
      as_of: asOf,
      through,
      currency: 'VND' as const,
      scheduled_due: {
        total_count: dueItems.length,
        total_expense: totalExpense,
        total_income: totalIncome,
        items: dueItems.slice(0, 5),
      },
      debts_summary: {
        borrowed_outstanding: borrowedOutstanding,
        lent_outstanding: lentOutstanding,
        open_borrowed_count: openBorrowedCount,
        open_lent_count: openLentCount,
        nearest_due_on: nearestDueOn,
      },
    };
  });
  return success(data, context);
}

/** Read bounded non-archived savings goals without exposing free-text goal or wallet names. */
async function executeGetSavingsGoals(
  params: GetSavingsGoalsParams,
  context: ToolContext,
) {
  const rows = await withDatabase((db) => listGoals(db));
  const filtered = rows.filter((row) =>
    params.include_achieved
      ? row.status !== 'archived'
      : row.status === 'active',
  );
  return success(
    {
      currency: 'VND' as const,
      total_count: filtered.length,
      goals: filtered.slice(0, 10).map((row) => ({
        id: row.id,
        target_amount: row.target_amount,
        saved_amount: row.progress,
        remaining_amount: Math.max(0, row.target_amount - row.progress),
        deadline_on: row.deadline_on,
        status: row.status as 'active' | 'achieved',
      })),
    },
    context,
  );
}

/** Validate and dispatch one permitted local tool, checking elapsed time without cancelling SQLite. */
export async function executeTool(
  toolName: string,
  params: unknown,
  allowedTools: string[],
  context: DispatchContext,
): Promise<ToolResult> {
  if (
    !allowedTools.includes(toolName) ||
    ![
      'get_transactions',
      'calculate_budget_status',
      'plan_savings_goal',
      'get_financial_snapshot',
      'get_spending_breakdown',
      'get_upcoming_obligations',
      'get_savings_goals',
    ].includes(toolName)
  )
    return failure('TOOL_NOT_ALLOWED');
  if (!ToolContextSchema.safeParse(context).success)
    return failure('STATE_ERROR');
  const deadline = Math.min(context.deadline, Date.now() + 1_500);
  if (Date.now() >= deadline) return failure('TIMEOUT');
  try {
    let result: ToolResult;
    switch (toolName) {
      case 'get_transactions': {
        const parsed = GetTransactionsSchema.safeParse(params);
        result = parsed.success
          ? await executeGetTransactions(parsed.data, context)
          : failure('INVALID_PARAMS');
        break;
      }
      case 'calculate_budget_status': {
        const parsed = BudgetStatusSchema.safeParse(params);
        result = parsed.success
          ? await executeCalculateBudgetStatus(parsed.data, context)
          : failure('INVALID_PARAMS');
        break;
      }
      case 'plan_savings_goal': {
        const parsed = SavingsGoalSchema.safeParse(params);
        result = parsed.success
          ? await executePlanSavingsGoal(parsed.data, context)
          : failure('INVALID_PARAMS');
        break;
      }
      case 'get_financial_snapshot': {
        const parsed = SnapshotSchema.safeParse(params);
        result = parsed.success
          ? await executeGetFinancialSnapshot(parsed.data, context)
          : failure('INVALID_PARAMS');
        break;
      }
      case 'get_spending_breakdown': {
        const parsed = SpendingBreakdownSchema.safeParse(params);
        result = parsed.success
          ? await executeGetSpendingBreakdown(parsed.data, context)
          : failure('INVALID_PARAMS');
        break;
      }
      case 'get_upcoming_obligations': {
        const parsed = UpcomingObligationsSchema.safeParse(params);
        result = parsed.success
          ? await executeGetUpcomingObligations(parsed.data, context)
          : failure('INVALID_PARAMS');
        break;
      }
      case 'get_savings_goals': {
        const parsed = SavingsGoalsSchema.safeParse(params);
        result = parsed.success
          ? await executeGetSavingsGoals(parsed.data, context)
          : failure('INVALID_PARAMS');
        break;
      }
      default:
        return failure('TOOL_NOT_ALLOWED');
    }
    return Date.now() >= deadline ? failure('TIMEOUT') : result;
  } catch {
    return failure(Date.now() >= deadline ? 'TIMEOUT' : 'DATA_ERROR');
  }
}
