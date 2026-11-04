import type {
  AdviceMetric,
  AdvicePlanSelection,
  AnalysisSummary,
} from '@pfm/contracts';
import { convertMoney, ratioBps, timeToAfford } from '@pfm/domain';

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
    const remaining = Math.max(0, scenario.savingsTarget - availableForGoals);
    return Math.ceil(remaining / scenario.savingsMonths);
  }
  return null;
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
