import {
  AdviceToolContextSchema as ToolContextSchema,
  GetTransactionsParamsSchema as GetTransactionsSchema,
  CalculateBudgetStatusParamsSchema as BudgetStatusSchema,
  PlanSavingsGoalParamsSchema as SavingsGoalSchema,
  GetFinancialSnapshotParamsSchema as SnapshotSchema,
  ConversationStateSchema,
  isDurationFact,
  isMoneyFact,
  type GetTransactionsParams,
  type CalculateBudgetStatusParams,
  type PlanSavingsGoalParams,
  type GetFinancialSnapshotParams,
  type ConversationState,
  type ToolErrorCode,
  type ToolResult,
} from '@pfm/contracts';
import {
  CALCULATION_VERSION,
  addDays,
  addMonths,
  today,
  normalizeAdviceInputs,
  calculateAdviceInputs,
} from '@pfm/domain';
import { withDatabase } from '@/data/connection';
import { listTransactions } from '@/data/transactions';
import { readBudgetMonth } from '@/data/budgets';
import { readAnalysisSummary } from '@/data/analysis';
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
      default:
        return failure('TOOL_NOT_ALLOWED');
    }
    return Date.now() >= deadline ? failure('TIMEOUT') : result;
  } catch {
    return failure(Date.now() >= deadline ? 'TIMEOUT' : 'DATA_ERROR');
  }
}
