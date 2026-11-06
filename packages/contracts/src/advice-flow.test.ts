import { describe, expect, it } from 'vitest';

import {
  AdviceBudgetGroupSchema,
  AdviceCompleteRequestSchema,
  AdviceDataGroupSchema,
  AdviceExpenseGroupSchema,
  AdviceGoalsGroupSchema,
  AdviceIncomeSourcesGroupSchema,
  AdvicePersonalBaselineGroupSchema,
  AdvicePlanRequestSchema,
  AdvicePlanSelectionSchema,
  AdviceRiskContextGroupSchema,
  AdviceScenarioSchema,
  AdviceSpendingHabitsGroupSchema,
} from './advice-flow';

const expenseGroup = {
  kind: 'expense_by_category' as const,
  rangeKind: 'last_7_days' as const,
  from: '2026-10-29',
  to: '2026-11-04',
  totalExpense: 5_000_000,
  topCategories: [
    { name: 'Tiền nhà', amount: 3_500_000 },
    { name: 'Ăn uống', amount: 1_500_000 },
  ],
  otherAmount: 0,
  uncategorizedAmount: 0,
};

const budgetGroup = {
  kind: 'budget_status' as const,
  month: '2026-11',
  items: [
    {
      name: 'Ăn uống',
      limitAmount: 3_000_000,
      spentAmount: 1_200_000,
      remainingAmount: 1_800_000,
    },
  ],
};

describe('AdviceScenarioSchema - savings wording', () => {
  it('distinguishes a monthly goal from a total target with a horizon', () => {
    expect(
      AdviceScenarioSchema.parse({ monthlySavingsGoal: 3_000_000 }),
    ).toEqual({ monthlySavingsGoal: 3_000_000 });
    expect(
      AdviceScenarioSchema.parse({
        savingsTarget: 30_000_000,
        savingsMonths: 10,
      }),
    ).toEqual({ savingsTarget: 30_000_000, savingsMonths: 10 });
  });

  it('rejects a zero or fractional horizon and unknown keys', () => {
    expect(
      AdviceScenarioSchema.safeParse({
        savingsTarget: 30_000_000,
        savingsMonths: 0,
      }).success,
    ).toBe(false);
    expect(
      AdviceScenarioSchema.safeParse({
        savingsTarget: 30_000_000,
        savingsMonths: 1.5,
      }).success,
    ).toBe(false);
    expect(
      AdviceScenarioSchema.safeParse({
        monthlySavingsGoal: 3_000_000,
        rate: 0.05,
      }).success,
    ).toBe(false);
  });
});

describe('AdviceExpenseGroupSchema', () => {
  it('accepts one supported range with at most five categories', () => {
    expect(AdviceExpenseGroupSchema.parse(expenseGroup)).toEqual(expenseGroup);
    expect(
      AdviceExpenseGroupSchema.safeParse({
        ...expenseGroup,
        topCategories: Array.from({ length: 6 }, (_, index) => ({
          name: `Nhóm ${index}`,
          amount: 100_000,
        })),
      }).success,
    ).toBe(false);
  });

  it('rejects an unsupported period and a malformed date', () => {
    expect(
      AdviceExpenseGroupSchema.safeParse({
        ...expenseGroup,
        rangeKind: 'last_90_days',
      }).success,
    ).toBe(false);
    expect(
      AdviceExpenseGroupSchema.safeParse({
        ...expenseGroup,
        from: '2026-13-01',
      }).success,
    ).toBe(false);
    expect(
      AdviceExpenseGroupSchema.safeParse({ ...expenseGroup, to: 'yesterday' })
        .success,
    ).toBe(false);
  });

  it('rejects names that are too long, empty or carry control characters', () => {
    for (const name of ['', ' '.repeat(3), 'x'.repeat(41), 'bad\u0000name']) {
      expect(
        AdviceExpenseGroupSchema.safeParse({
          ...expenseGroup,
          topCategories: [{ name, amount: 100_000 }],
        }).success,
      ).toBe(false);
    }
  });

  it('rejects unsafe or negative money and extra fields', () => {
    for (const amount of [-1, 0.5, 100_000_000_001, Number.MAX_SAFE_INTEGER]) {
      expect(
        AdviceExpenseGroupSchema.safeParse({
          ...expenseGroup,
          totalExpense: amount,
        }).success,
      ).toBe(false);
    }
    expect(
      AdviceExpenseGroupSchema.safeParse({
        ...expenseGroup,
        note: 'ghi chú riêng',
      }).success,
    ).toBe(false);
    expect(
      AdviceExpenseGroupSchema.safeParse({
        ...expenseGroup,
        topCategories: [{ name: 'Ăn uống', amount: 100_000, notes: 'x' }],
      }).success,
    ).toBe(false);
  });
});

describe('AdviceBudgetGroupSchema', () => {
  it('accepts a month with up to five budget rows', () => {
    expect(AdviceBudgetGroupSchema.parse(budgetGroup)).toEqual(budgetGroup);
  });

  it('rejects a bad month and more than five rows', () => {
    expect(
      AdviceBudgetGroupSchema.safeParse({ ...budgetGroup, month: '2026-11-01' })
        .success,
    ).toBe(false);
    expect(
      AdviceBudgetGroupSchema.safeParse({
        ...budgetGroup,
        items: Array.from({ length: 6 }, () => budgetGroup.items[0]),
      }).success,
    ).toBe(false);
  });
});

describe('AdviceDataGroupSchema', () => {
  it('selects the shape by kind', () => {
    expect(AdviceDataGroupSchema.parse(expenseGroup).kind).toBe(
      'expense_by_category',
    );
    expect(AdviceDataGroupSchema.parse(budgetGroup).kind).toBe('budget_status');
    expect(
      AdviceDataGroupSchema.safeParse({ kind: 'all_transactions' }).success,
    ).toBe(false);
  });
});

const habitsGroup = {
  kind: 'spending_habits' as const,
  rangeKind: 'last_30_days' as const,
  from: '2026-10-06',
  to: '2026-11-04',
  daysInRange: 30,
  transactionCount: 26,
  totalExpense: 12_000_000,
  flexibleAmount: 8_500_000,
  smallFrequentCount: 18,
  smallFrequentAmount: 1_350_000,
  parents: [
    {
      name: 'Ăn uống',
      amount: 4_200_000,
      previousAmount: 3_100_000,
      count: 14,
      avgTicket: 300_000,
      largestTicket: 850_000,
      isFlexible: true,
      children: [
        { name: 'Ăn ngoài', amount: 3_500_000, count: 11, avgTicket: 318_182 },
        {
          name: 'Cà phê & đồ uống',
          amount: 700_000,
          count: 3,
          avgTicket: 233_333,
        },
      ],
    },
  ],
};

const baselineGroup = {
  kind: 'personal_baseline' as const,
  monthsWithData: 4,
  rows: [
    {
      name: 'Ăn uống',
      currentAmount: 4_200_000,
      currentPercent: 35,
      baselineMonthlyAvg: 3_000_000,
      baselinePercent: 28,
    },
  ],
};

describe('AdviceSpendingHabitsGroupSchema', () => {
  it('accepts a habit profile with child categories', () => {
    expect(AdviceDataGroupSchema.parse(habitsGroup)).toEqual(habitsGroup);
  });

  it('caps parents at four and children at five', () => {
    expect(
      AdviceSpendingHabitsGroupSchema.safeParse({
        ...habitsGroup,
        parents: Array.from({ length: 5 }, () => habitsGroup.parents[0]),
      }).success,
    ).toBe(false);
    expect(
      AdviceSpendingHabitsGroupSchema.safeParse({
        ...habitsGroup,
        parents: [
          {
            ...habitsGroup.parents[0],
            children: Array.from({ length: 6 }, (_, index) => ({
              name: `Con ${index}`,
              amount: 100_000,
              count: 1,
              avgTicket: 100_000,
            })),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects negative counts, unsafe money and extra fields', () => {
    expect(
      AdviceSpendingHabitsGroupSchema.safeParse({
        ...habitsGroup,
        transactionCount: -1,
      }).success,
    ).toBe(false);
    expect(
      AdviceSpendingHabitsGroupSchema.safeParse({
        ...habitsGroup,
        flexibleAmount: 100_000_000_001,
      }).success,
    ).toBe(false);
    expect(
      AdviceSpendingHabitsGroupSchema.safeParse({
        ...habitsGroup,
        parents: [{ ...habitsGroup.parents[0], note: 'ghi chú riêng' }],
      }).success,
    ).toBe(false);
  });

  it('requires a supported range kind and a boolean flexibility flag', () => {
    expect(
      AdviceSpendingHabitsGroupSchema.safeParse({
        ...habitsGroup,
        rangeKind: 'last_90_days',
      }).success,
    ).toBe(false);
    expect(
      AdviceSpendingHabitsGroupSchema.safeParse({
        ...habitsGroup,
        parents: [{ ...habitsGroup.parents[0], isFlexible: 'yes' }],
      }).success,
    ).toBe(false);
  });
});

describe('AdviceGoalsGroupSchema', () => {
  const goalsGroup = {
    kind: 'goals_status' as const,
    activeCount: 2,
    totalRequiredPerMonth: 4_500_000,
    rows: [
      {
        name: 'Quỹ khẩn cấp',
        targetAmount: 30_000_000,
        savedAmount: 9_000_000,
        progressPercent: 30,
        monthsLeft: 6,
        requiredPerMonth: 3_500_000,
      },
      {
        name: 'Mua xe máy',
        targetAmount: 40_000_000,
        savedAmount: 20_000_000,
        progressPercent: 50,
        monthsLeft: null,
        requiredPerMonth: null,
      },
    ],
  };

  it('accepts goals with and without a deadline', () => {
    expect(AdviceDataGroupSchema.parse(goalsGroup)).toEqual(goalsGroup);
  });

  it('rejects more than five rows and a percent above 100', () => {
    expect(
      AdviceGoalsGroupSchema.safeParse({
        ...goalsGroup,
        rows: Array.from({ length: 6 }, () => goalsGroup.rows[0]),
      }).success,
    ).toBe(false);
    expect(
      AdviceGoalsGroupSchema.safeParse({
        ...goalsGroup,
        rows: [{ ...goalsGroup.rows[0], progressPercent: 101 }],
      }).success,
    ).toBe(false);
  });
});

describe('AdviceIncomeSourcesGroupSchema', () => {
  const sourcesGroup = {
    kind: 'income_sources' as const,
    rangeKind: 'this_month' as const,
    from: '2026-11-01',
    to: '2026-11-04',
    monthsWithData: 4,
    totalIncome: 20_000_000,
    sources: [
      { name: 'Lương', amount: 16_000_000, count: 1, percentPercent: 80 },
      {
        name: 'Thu nhập kinh doanh',
        amount: 4_000_000,
        count: 3,
        percentPercent: 20,
      },
    ],
  };

  it('accepts income sources with their share', () => {
    expect(AdviceDataGroupSchema.parse(sourcesGroup)).toEqual(sourcesGroup);
  });

  it('requires a supported range and bounds the source list', () => {
    expect(
      AdviceIncomeSourcesGroupSchema.safeParse({
        ...sourcesGroup,
        rangeKind: 'last_90_days',
      }).success,
    ).toBe(false);
    expect(
      AdviceIncomeSourcesGroupSchema.safeParse({
        ...sourcesGroup,
        sources: Array.from({ length: 6 }, () => sourcesGroup.sources[0]),
      }).success,
    ).toBe(false);
  });

  it('rejects a negative count', () => {
    expect(
      AdviceIncomeSourcesGroupSchema.safeParse({
        ...sourcesGroup,
        sources: [{ ...sourcesGroup.sources[0], count: -1 }],
      }).success,
    ).toBe(false);
  });
});

describe('AdviceRiskContextGroupSchema', () => {
  it('accepts known flags only', () => {
    expect(
      AdviceDataGroupSchema.parse({
        kind: 'risk_context',
        monthsWithData: 1,
        riskFlags: ['DEBT_STRESS'],
        dataQuality: ['LESS_THAN_3_MONTHS', 'MANY_UNCATEGORIZED'],
      }),
    ).toMatchObject({ monthsWithData: 1 });
    expect(
      AdviceRiskContextGroupSchema.safeParse({
        kind: 'risk_context',
        monthsWithData: 1,
        riskFlags: ['MADE_UP'],
        dataQuality: [],
      }).success,
    ).toBe(false);
    expect(
      AdviceRiskContextGroupSchema.safeParse({
        kind: 'risk_context',
        monthsWithData: 13,
        riskFlags: [],
        dataQuality: [],
      }).success,
    ).toBe(false);
  });
});

describe('AdvicePersonalBaselineGroupSchema', () => {
  it('accepts a comparison against the user own history', () => {
    expect(AdviceDataGroupSchema.parse(baselineGroup)).toEqual(baselineGroup);
  });

  it('rejects more than five rows, a percent above 100 and an unsafe month count', () => {
    expect(
      AdvicePersonalBaselineGroupSchema.safeParse({
        ...baselineGroup,
        rows: Array.from({ length: 6 }, () => baselineGroup.rows[0]),
      }).success,
    ).toBe(false);
    expect(
      AdvicePersonalBaselineGroupSchema.safeParse({
        ...baselineGroup,
        rows: [{ ...baselineGroup.rows[0], currentPercent: 101 }],
      }).success,
    ).toBe(false);
    expect(
      AdvicePersonalBaselineGroupSchema.safeParse({
        ...baselineGroup,
        monthsWithData: 13,
      }).success,
    ).toBe(false);
  });
});

describe('AdvicePlanSelectionSchema', () => {
  it('keeps a legacy plan without groups valid', () => {
    expect(
      AdvicePlanSelectionSchema.parse({
        metrics: ['purchase_months_median'],
        scenario: { price: 40_000_000 },
      }),
    ).toEqual({
      metrics: ['purchase_months_median'],
      scenario: { price: 40_000_000 },
    });
  });

  it('allows zero metrics when at least one group is selected', () => {
    expect(
      AdvicePlanSelectionSchema.parse({
        metrics: [],
        scenario: {},
        groups: [
          { kind: 'expense_by_category', rangeKind: 'last_30_days' },
          { kind: 'budget_status' },
        ],
      }).groups,
    ).toHaveLength(2);
  });

  it('accepts the habit and baseline selections without amounts', () => {
    expect(
      AdvicePlanSelectionSchema.parse({
        metrics: [],
        scenario: {},
        groups: [
          { kind: 'spending_habits', rangeKind: 'last_30_days' },
          { kind: 'personal_baseline' },
        ],
      }).groups,
    ).toEqual([
      { kind: 'spending_habits', rangeKind: 'last_30_days' },
      { kind: 'personal_baseline' },
    ]);
    expect(
      AdvicePlanSelectionSchema.safeParse({
        metrics: [],
        scenario: {},
        groups: [{ kind: 'personal_baseline', rows: [] }],
      }).success,
    ).toBe(false);
    expect(
      AdvicePlanSelectionSchema.safeParse({
        metrics: [],
        scenario: {},
        groups: [{ kind: 'spending_habits', rangeKind: 'last_90_days' }],
      }).success,
    ).toBe(false);
  });

  it('never accepts amounts in the plan stage groups', () => {
    expect(
      AdvicePlanSelectionSchema.safeParse({
        metrics: [],
        scenario: {},
        groups: [
          {
            kind: 'expense_by_category',
            rangeKind: 'last_7_days',
            totalExpense: 1,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AdvicePlanSelectionSchema.safeParse({
        metrics: [],
        scenario: {},
        groups: [{ kind: 'budget_status', items: [] }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unsupported period in a plan group', () => {
    expect(
      AdvicePlanSelectionSchema.safeParse({
        metrics: [],
        scenario: {},
        groups: [{ kind: 'expense_by_category', rangeKind: 'last_90_days' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an empty selection and duplicate group kinds', () => {
    expect(
      AdvicePlanSelectionSchema.safeParse({ metrics: [], scenario: {} })
        .success,
    ).toBe(false);
    expect(
      AdvicePlanSelectionSchema.safeParse({
        metrics: [],
        scenario: {},
        groups: [{ kind: 'budget_status' }, { kind: 'budget_status' }],
      }).success,
    ).toBe(false);
    expect(
      AdvicePlanSelectionSchema.safeParse({
        metrics: ['surplus_median'],
        scenario: {},
        groups: [
          { kind: 'expense_by_category', rangeKind: 'this_month' },
          { kind: 'expense_by_category', rangeKind: 'this_month' },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects more than eight metrics and duplicate metric ids', () => {
    expect(
      AdvicePlanSelectionSchema.safeParse({
        metrics: [
          'monthly_income_avg',
          'monthly_expense_avg',
          'current_month_income',
          'current_month_expense',
          'current_month_projected_expense',
          'surplus_p25',
          'surplus_median',
          'surplus_p75',
          'available_for_goals',
        ],
        scenario: {},
      }).success,
    ).toBe(false);
    expect(
      AdvicePlanSelectionSchema.safeParse({
        metrics: ['surplus_median', 'surplus_median'],
        scenario: {},
      }).success,
    ).toBe(false);
  });

  it('accepts the new savings metrics', () => {
    const selection = AdvicePlanSelectionSchema.parse({
      metrics: [
        'savings_required_monthly',
        'surplus_after_savings_goal',
        'recurring_monthly_total',
        'savings_target_remaining',
        'savings_months_given',
      ],
      scenario: { savingsTarget: 30_000_000, savingsMonths: 10 },
    });
    expect(selection.metrics).toContain('savings_required_monthly');
  });
});

describe('AdviceCompleteRequestSchema - data groups', () => {
  const base = {
    requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d470',
    question: 'Tháng này tôi tiêu gì nhiều?',
  };

  it('accepts signed groups and rejects unknown fields', () => {
    expect(
      AdviceCompleteRequestSchema.parse({
        ...base,
        planToken: 'token',
        results: {},
        dataGroups: [expenseGroup],
      }).dataGroups,
    ).toHaveLength(1);
    expect(
      AdviceCompleteRequestSchema.safeParse({
        ...base,
        planToken: 'token',
        results: {},
        dataGroups: [expenseGroup],
        transactions: [],
      }).success,
    ).toBe(false);
    expect(
      AdviceCompleteRequestSchema.safeParse({
        ...base,
        planToken: 'token',
        results: {},
        dataGroups: [{ ...expenseGroup, note: 'ghi chú' }],
      }).success,
    ).toBe(false);
  });

  it('stays compatible with a request that omits groups', () => {
    expect(
      AdviceCompleteRequestSchema.parse({
        ...base,
        planToken: 'token',
        results: { surplus_median: 1 },
      }).dataGroups,
    ).toBeUndefined();
  });
});

describe('AdvicePlanRequestSchema', () => {
  it('bounds the question and history length', () => {
    expect(
      AdvicePlanRequestSchema.safeParse({
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d470',
        question: 'x'.repeat(501),
      }).success,
    ).toBe(false);
    expect(
      AdvicePlanRequestSchema.safeParse({
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d470',
        question: 'Tháng này tôi chi bao nhiêu?',
        history: Array.from({ length: 9 }, () => ({
          role: 'user',
          text: 'x',
        })),
      }).success,
    ).toBe(false);
  });
});
