import { expect, it } from 'vitest';
import { AnalysisSummarySchema } from '@pfm/contracts';
import { computeAdviceMetrics, requiredMonthlySaving } from './advice-metrics';

const summary = AnalysisSummarySchema.parse({
  generatedForDate: '2026-11-02',
  currency: 'VND',
  window: { monthsRequested: 6, monthsWithData: 6 },
  income: {
    monthlyAvg: 9_000_000,
    monthlyMin: 8_000_000,
    monthlyMax: 10_000_000,
  },
  expense: {
    monthlyAvg: 3_000_000,
    monthlyMin: 2_000_000,
    monthlyMax: 4_000_000,
    fixedMonthlyAvg: 1_000_000,
    variableMonthlyAvg: 2_000_000,
  },
  surplus: {
    monthlyAvg: 6_000_000,
    p25: 3_000_000,
    median: 6_000_000,
    p75: 9_000_000,
  },
  currentMonth: {
    incomeSoFar: 9_000_000,
    expenseSoFar: 3_000_000,
    daysElapsed: 2,
    daysInMonth: 30,
    projectedExpense: null,
  },
  topExpenseCategories: [],
  commitments: {
    recurringMonthlyTotal: 1_500_000,
    debtMonthlyObligation: 900_000,
  },
  savings: {
    liquidBalance: 2_000_000,
    availableForGoals: 2_000_000,
    emergencyFundMonths: 0,
  },
  goals: [],
  debts: { outstandingBorrowed: 0, outstandingLent: 0, dtiBps: 0 },
  riskFlags: [],
  dataQuality: [],
});

const noHistory = {
  ...summary,
  window: { monthsRequested: 6, monthsWithData: 0 },
};

it('calculates a 40m purchase timeline locally and returns only requested metrics', () => {
  expect(
    computeAdviceMetrics(summary, {
      metrics: [
        'purchase_remaining',
        'purchase_months_p25',
        'purchase_months_median',
        'purchase_months_p75',
      ],
      scenario: { price: 40_000_000 },
    }),
  ).toEqual({
    purchase_remaining: 38_000_000,
    purchase_months_p25: 13,
    purchase_months_median: 7,
    purchase_months_p75: 5,
  });
});

it('calculates a 900k monthly obligation and marks missing history explicitly', () => {
  const selection = {
    metrics: [
      'surplus_after_payment',
      'payment_reserve_total',
      'existing_debt_monthly',
      'months_with_data',
    ] as const,
    scenario: { monthlyPayment: 900_000, paymentMonths: 7 },
  };
  expect(
    computeAdviceMetrics(summary, {
      ...selection,
      metrics: [...selection.metrics],
    }),
  ).toEqual({
    surplus_after_payment: 5_100_000,
    payment_reserve_total: 6_300_000,
    existing_debt_monthly: 900_000,
    months_with_data: 6,
  });
  expect(
    computeAdviceMetrics(noHistory, {
      ...selection,
      metrics: [...selection.metrics],
    }),
  ).toEqual({
    surplus_after_payment: null,
    payment_reserve_total: 6_300_000,
    existing_debt_monthly: 900_000,
    months_with_data: 0,
  });
});

it('recognizes an immediately affordable purchase even without income history', () => {
  const richSavings = {
    ...noHistory,
    savings: { ...noHistory.savings, availableForGoals: 40_000_000 },
  };
  expect(
    computeAdviceMetrics(richSavings, {
      metrics: ['purchase_remaining', 'purchase_months_median'],
      scenario: { price: 40_000_000 },
    }),
  ).toEqual({ purchase_remaining: 0, purchase_months_median: 0 });
});

it('uses USD scenario amounts for local calculations and returns USD money metrics', () => {
  expect(
    computeAdviceMetrics(
      summary,
      {
        metrics: [
          'monthly_income_avg',
          'surplus_after_payment',
          'payment_reserve_total',
          'months_with_data',
        ],
        scenario: { monthlyPayment: 10.25, paymentMonths: 3 },
      },
      'USD',
      25_000,
    ),
  ).toEqual({
    monthly_income_avg: 360,
    surplus_after_payment: 229.75,
    payment_reserve_total: 30.75,
    months_with_data: 6,
  });
  expect(() =>
    computeAdviceMetrics(
      summary,
      {
        metrics: ['monthly_income_avg'],
        scenario: {},
      },
      'USD',
      null,
    ),
  ).toThrow('exchange rate');
});

it('treats 3m a month as a monthly goal, not a total target', () => {
  const monthly = computeAdviceMetrics(summary, {
    metrics: ['savings_required_monthly', 'surplus_after_savings_goal'],
    scenario: { monthlySavingsGoal: 3_000_000 },
  });
  expect(monthly).toEqual({
    savings_required_monthly: 3_000_000,
    surplus_after_savings_goal: 3_000_000,
  });
});

it('spreads a 30m target over 10 months and flags it as infeasible', () => {
  const target = computeAdviceMetrics(summary, {
    metrics: [
      'savings_required_monthly',
      'savings_target_remaining',
      'savings_months_given',
      'surplus_after_savings_goal',
    ],
    scenario: { savingsTarget: 30_000_000, savingsMonths: 10 },
  });
  expect(target).toEqual({
    // 30m - 2m already available = 28m over 10 months = 2.8m a month.
    savings_required_monthly: 2_800_000,
    savings_target_remaining: 28_000_000,
    savings_months_given: 10,
    surplus_after_savings_goal: 3_200_000,
  });

  const infeasible = computeAdviceMetrics(summary, {
    metrics: ['savings_required_monthly', 'surplus_after_savings_goal'],
    scenario: { savingsTarget: 120_000_000, savingsMonths: 6 },
  });
  expect(infeasible).toEqual({
    savings_required_monthly: 19_666_667,
    surplus_after_savings_goal: -13_666_667,
  });
});

it('never reports a surplus after a savings goal without income history', () => {
  expect(
    computeAdviceMetrics(noHistory, {
      metrics: ['savings_required_monthly', 'surplus_after_savings_goal'],
      scenario: { monthlySavingsGoal: 3_000_000 },
    }),
  ).toEqual({
    savings_required_monthly: 3_000_000,
    surplus_after_savings_goal: null,
  });
});

it('returns the recurring commitment separately from the debt obligation', () => {
  expect(
    computeAdviceMetrics(summary, {
      metrics: ['recurring_monthly_total', 'existing_debt_monthly'],
      scenario: {},
    }),
  ).toEqual({
    recurring_monthly_total: 1_500_000,
    existing_debt_monthly: 900_000,
  });
});

it('converts a monthly savings goal from USD before comparing with VND surplus', () => {
  expect(
    computeAdviceMetrics(
      summary,
      {
        metrics: ['savings_required_monthly', 'surplus_after_savings_goal'],
        scenario: { monthlySavingsGoal: 120 },
      },
      'USD',
      25_000,
    ),
  ).toEqual({
    savings_required_monthly: 120,
    surplus_after_savings_goal: 120,
  });
});

it('never invents a required monthly saving without a stated goal', () => {
  expect(
    computeAdviceMetrics(summary, {
      metrics: ['savings_required_monthly', 'surplus_after_savings_goal'],
      scenario: {},
    }),
  ).toEqual({
    savings_required_monthly: null,
    surplus_after_savings_goal: null,
  });
});

it('reports cash-flow health metrics computed in code, never by the model', () => {
  const withDebt = AnalysisSummarySchema.parse({
    ...summary,
    debts: { ...summary.debts, dtiBps: 1000 },
  });
  expect(
    computeAdviceMetrics(withDebt, {
      metrics: [
        'savings_rate_bps',
        'dti_bps',
        'monthly_income_min',
        'monthly_income_max',
        'expense_fixed_avg',
        'expense_variable_avg',
      ],
      scenario: {},
    }),
  ).toEqual({
    // (9m - 3m) / 9m = 6667 bps; the DTI is passed through as computed.
    savings_rate_bps: 6667,
    dti_bps: 1000,
    monthly_income_min: 8_000_000,
    monthly_income_max: 10_000_000,
    expense_fixed_avg: 1_000_000,
    expense_variable_avg: 2_000_000,
  });
});

it('marks cash-flow health unknown without income history', () => {
  expect(
    computeAdviceMetrics(noHistory, {
      metrics: ['savings_rate_bps', 'monthly_income_min', 'monthly_income_max'],
      scenario: {},
    }),
  ).toEqual({
    savings_rate_bps: null,
    monthly_income_min: null,
    monthly_income_max: null,
  });
});

it('reports both emergency-fund figures and keeps essential spend in VND', () => {
  const withEssential = AnalysisSummarySchema.parse({
    ...summary,
    expense: { ...summary.expense, essentialMonthlyAvg: 2_000_000 },
    savings: {
      ...summary.savings,
      liquidBalance: 10_000_000,
      emergencyFundMonths: 3,
      emergencyFundMonthsEssential: 5,
    },
  });
  expect(
    computeAdviceMetrics(withEssential, {
      metrics: [
        'essential_monthly_expense',
        'emergency_fund_months_essential',
        'emergency_fund_months',
      ],
      scenario: {},
    }),
  ).toEqual({
    essential_monthly_expense: 2_000_000,
    emergency_fund_months_essential: 5,
    emergency_fund_months: 3,
  });
  expect(
    computeAdviceMetrics(
      withEssential,
      { metrics: ['essential_monthly_expense'], scenario: {} },
      'USD',
      25_000,
    ),
  ).toEqual({ essential_monthly_expense: 80 });
});

it('resolves the monthly saving from either wording', () => {
  expect(requiredMonthlySaving({ monthlySavingsGoal: 3_000_000 }, 0)).toBe(
    3_000_000,
  );
  expect(
    requiredMonthlySaving(
      { savingsTarget: 10_000_000, savingsMonths: 4 },
      2_000_000,
    ),
  ).toBe(2_000_000);
  expect(
    requiredMonthlySaving(
      { savingsTarget: 1_000, savingsMonths: 4 },
      2_000_000,
    ),
  ).toBe(0);
  expect(requiredMonthlySaving({}, 2_000_000)).toBeNull();
});
