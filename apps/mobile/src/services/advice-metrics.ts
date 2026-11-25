import type {
  AdviceMetric,
  AdvicePlanSelection,
  AnalysisSummary,
} from '@pfm/contracts';
import {
  CALCULATION_VERSION,
  calculateAdviceInputs,
  normalizeAdviceInputs,
  requiredMonthlySaving as domainRequiredMonthlySaving,
  convertMoney,
  ratioBps,
  timeToAfford,
  type AdviceInputContext,
  type AdviceInputs,
} from '@pfm/domain';

const NON_MONEY_METRICS = new Set<AdviceMetric>([
  'months_with_data',
  'emergency_fund_months',
  'emergency_fund_months_essential',
  'purchase_months_p25',
  'purchase_months_median',
  'purchase_months_p75',
  'savings_months_given',
  'savings_rate_bps',
  'dti_bps',
]);

/**
 * Resolve the monthly saving amount the user actually committed to. A stated
 * monthly goal wins; a total target is spread across the stated horizon.
 */
export function requiredMonthlySaving(
  scenario: AdvicePlanSelection['scenario'],
  availableForGoals: number,
): number | null {
  if (scenario.monthlySavingsGoal !== undefined) {
    return Math.max(0, Math.round(scenario.monthlySavingsGoal));
  }
  if (
    scenario.savingsTarget !== undefined &&
    scenario.savingsMonths !== undefined
  ) {
    return domainRequiredMonthlySaving(
      scenario.savingsTarget,
      availableForGoals,
      scenario.savingsMonths,
    );
  }
  return null;
}

export type AdviceCacheScope = { conversationId: string } & (
  { userId: string; deviceId?: never } | { deviceId: string; userId?: never }
);

function canonicalInput(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalInput).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalInput(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Keep only calculation results in memory; scope changes immediately discard the old window. */
export function createAdviceCalculationCache(now: () => number = Date.now) {
  let activeScope = '';
  const entries = new Map<
    number,
    { input: string; createdAt: number; value: unknown }
  >();
  return {
    clear() {
      entries.clear();
      activeScope = '';
    },
    getOrCompute<T>(
      scope: AdviceCacheScope,
      input: unknown,
      calculate: () => T,
      version = CALCULATION_VERSION,
    ): T {
      const identity =
        scope.userId !== undefined
          ? ['user', scope.userId]
          : ['device', scope.deviceId];
      if (!identity[1] || !scope.conversationId) return calculate();
      const scopeKey = JSON.stringify([...identity, scope.conversationId]);
      if (scopeKey !== activeScope) {
        entries.clear();
        activeScope = scopeKey;
      }
      const serialized = canonicalInput({ input, version });
      let hash = 2166136261;
      for (let i = 0; i < serialized.length; i++)
        hash = Math.imul(hash ^ serialized.charCodeAt(i), 16777619) >>> 0;
      const time = now();
      for (const [key, entry] of entries)
        if (time - entry.createdAt >= 300_000) entries.delete(key);
      const hit = entries.get(hash);
      const clone = <V>(value: V): V => JSON.parse(JSON.stringify(value)) as V;
      // Check the canonical input too: a non-cryptographic hash collision must never reuse another result.
      if (hit && hit.input === serialized) {
        entries.delete(hash);
        entries.set(hash, hit);
        return clone(hit.value as T);
      }
      const value = calculate();
      if (
        value !== null &&
        typeof value === 'object' &&
        'ok' in value &&
        value.ok === false
      )
        return value;
      entries.set(hash, {
        input: serialized,
        createdAt: time,
        value: clone(value),
      });
      while (entries.size > 32) entries.delete(entries.keys().next().value!);
      return value;
    },
  };
}

export const adviceCalculationCache = createAdviceCalculationCache();

/** Preserve the legacy metric interface while new fact-based callers receive explicit clarification. */
export function resolveAdviceMetrics(
  summary: AnalysisSummary | null,
  selection: AdvicePlanSelection,
  context: AdviceInputContext,
  scope?: AdviceCacheScope,
):
  | {
      ok: true;
      result: {
        metrics: Partial<Record<AdviceMetric, number | null>>;
        inputs: AdviceInputs | null;
      };
    }
  | { ok: false; needsClarification: string[] } {
  const normalized =
    selection.scenario.conversationFacts === undefined
      ? null
      : normalizeAdviceInputs(
          selection.scenario.conversationFacts,
          summary,
          context,
        );
  if (normalized && !normalized.ok) return normalized;
  const compute = () => {
    if (selection.scenario.conversationFacts === undefined) {
      return {
        ok: true as const,
        result: {
          metrics: summary
            ? computeAdviceMetrics(
                summary,
                selection,
                context.currency,
                context.vndPerUsd ?? null,
              )
            : {},
          inputs: null,
        },
      };
    }
    const inputs = normalized!.ok ? normalized!.result : null;
    if (!inputs)
      return { ok: false as const, needsClarification: ['conversationFacts'] };
    const calculation = calculateAdviceInputs(inputs);
    const derived: Partial<Record<AdviceMetric, number | null>> = {
      monthly_income_avg: inputs.income.amount,
      monthly_expense_avg: inputs.expense.amount,
      surplus_median: calculation.surplusBeforeGoal,
      surplus_after_savings_goal: calculation.remainingAfterGoal,
      savings_required_monthly: calculation.requiredMonthlySaving,
      savings_target_remaining: inputs.goal
        ? Math.max(0, inputs.goal.amount - inputs.savingsForGoal!.amount)
        : null,
      savings_months_given: context.savingsMonths ?? null,
    };
    const metrics = Object.fromEntries(
      selection.metrics.map((metric) => [
        metric,
        derived[metric] === undefined
          ? null
          : context.currency === 'USD' &&
              !NON_MONEY_METRICS.has(metric) &&
              derived[metric] !== null
            ? derived[metric]! / 100
            : derived[metric],
      ]),
    );
    return { ok: true as const, result: { metrics, inputs } };
  };
  return scope
    ? adviceCalculationCache.getOrCompute(
        scope,
        {
          inputs: normalized?.ok ? normalized.result : { summary, context },
          selection,
        },
        compute,
      )
    : compute();
}

// Compute only the metrics selected by the planner; null marks insufficient local data.
export function computeAdviceMetrics(
  summary: AnalysisSummary,
  selection: AdvicePlanSelection,
  currency: 'VND' | 'USD' = 'VND',
  vndPerUsd: number | null = null,
): Partial<Record<AdviceMetric, number | null>> {
  if (currency === 'USD' && vndPerUsd === null)
    throw new Error('USD conversion requires an exchange rate');
  const scenarioMoneyToVnd = (value: number) =>
    currency === 'USD'
      ? convertMoney(Math.round(value * 100), 'USD', 'VND', vndPerUsd!)
      : value;
  const scenarioVnd = {
    ...selection.scenario,
    ...(selection.scenario.monthlySavingsGoal !== undefined
      ? {
          monthlySavingsGoal: scenarioMoneyToVnd(
            selection.scenario.monthlySavingsGoal,
          ),
        }
      : {}),
    ...(selection.scenario.savingsTarget !== undefined
      ? { savingsTarget: scenarioMoneyToVnd(selection.scenario.savingsTarget) }
      : {}),
  };
  const hasHistory = summary.window.monthsWithData > 0;
  const purchase =
    selection.scenario.price === undefined
      ? null
      : timeToAfford({
          price: scenarioMoneyToVnd(selection.scenario.price),
          available: summary.savings.availableForGoals,
          surplus: hasHistory ? summary.surplus.median : 0,
          surplusScenarios: {
            conservative: hasHistory ? summary.surplus.p25 : 0,
            typical: hasHistory ? summary.surplus.median : 0,
            optimistic: hasHistory ? summary.surplus.p75 : 0,
          },
        });
  const requiredSaving = requiredMonthlySaving(
    scenarioVnd,
    summary.savings.availableForGoals,
  );
  const savingsTargetRemaining =
    scenarioVnd.savingsTarget === undefined
      ? null
      : Math.max(
          0,
          scenarioVnd.savingsTarget - summary.savings.availableForGoals,
        );
  const values: Record<AdviceMetric, number | null> = {
    monthly_income_avg: hasHistory ? summary.income.monthlyAvg : null,
    monthly_expense_avg: hasHistory ? summary.expense.monthlyAvg : null,
    current_month_income: summary.currentMonth.incomeSoFar,
    current_month_expense: summary.currentMonth.expenseSoFar,
    current_month_projected_expense: summary.currentMonth.projectedExpense,
    surplus_p25: hasHistory ? summary.surplus.p25 : null,
    surplus_median: hasHistory ? summary.surplus.median : null,
    surplus_p75: hasHistory ? summary.surplus.p75 : null,
    available_for_goals: summary.savings.availableForGoals,
    liquid_balance: summary.savings.liquidBalance,
    existing_debt_monthly: summary.commitments.debtMonthlyObligation,
    months_with_data: summary.window.monthsWithData,
    emergency_fund_months: summary.savings.emergencyFundMonths,
    purchase_remaining: purchase?.remaining ?? null,
    purchase_months_p25: purchase?.conservativeMonths ?? null,
    purchase_months_median: purchase?.typicalMonths ?? null,
    purchase_months_p75: purchase?.optimisticMonths ?? null,
    surplus_after_payment:
      hasHistory && selection.scenario.monthlyPayment !== undefined
        ? summary.surplus.median -
          scenarioMoneyToVnd(selection.scenario.monthlyPayment)
        : null,
    payment_reserve_total:
      selection.scenario.monthlyPayment !== undefined &&
      selection.scenario.paymentMonths !== undefined
        ? scenarioMoneyToVnd(selection.scenario.monthlyPayment) *
          selection.scenario.paymentMonths
        : null,
    savings_required_monthly: requiredSaving,
    surplus_after_savings_goal:
      hasHistory && requiredSaving !== null
        ? summary.surplus.median - requiredSaving
        : null,
    recurring_monthly_total: summary.commitments.recurringMonthlyTotal,
    savings_target_remaining: savingsTargetRemaining,
    savings_months_given: scenarioVnd.savingsMonths ?? null,
    savings_rate_bps:
      hasHistory && summary.income.monthlyAvg > 0
        ? ratioBps(
            summary.income.monthlyAvg - summary.expense.monthlyAvg,
            summary.income.monthlyAvg,
          )
        : null,
    dti_bps: summary.debts.dtiBps,
    monthly_income_min: hasHistory ? summary.income.monthlyMin : null,
    monthly_income_max: hasHistory ? summary.income.monthlyMax : null,
    expense_fixed_avg: hasHistory ? summary.expense.fixedMonthlyAvg : null,
    expense_variable_avg: hasHistory
      ? summary.expense.variableMonthlyAvg
      : null,
    essential_monthly_expense: summary.expense.essentialMonthlyAvg,
    emergency_fund_months_essential:
      summary.savings.emergencyFundMonthsEssential,
  };
  return Object.fromEntries(
    selection.metrics.map((metric) => [
      metric,
      values[metric] === null ||
      currency === 'VND' ||
      NON_MONEY_METRICS.has(metric)
        ? values[metric]
        : convertMoney(values[metric]!, 'VND', 'USD', vndPerUsd!) / 100,
    ]),
  ) as Partial<Record<AdviceMetric, number | null>>;
}
