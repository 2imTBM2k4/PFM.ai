import { describe, expect, it } from 'vitest';

import {
  buildAnalysisSummary,
  calculateSurplusPercentiles,
  percentileType7,
} from './index';

describe('Percentiles Type 7', () => {
  it('handles single-item and two-item arrays', () => {
    expect(percentileType7([500], 0.5)).toBe(500);
    expect(percentileType7([100, 200], 0.5)).toBe(150);
    expect(percentileType7([100, 200], 0.25)).toBe(125);
  });

  it('computes correct percentiles for 4 sorted values', () => {
    const vals = [100, 200, 300, 400];
    expect(percentileType7(vals, 0.25)).toBe(175);
    expect(percentileType7(vals, 0.5)).toBe(250);
    expect(percentileType7(vals, 0.75)).toBe(325);
  });

  it('falls back to min, median, max when fewer than 4 data points exist', () => {
    const vals = [100, 200, 400];
    const res = calculateSurplusPercentiles(vals);
    expect(res.p25).toBe(100); // min
    expect(res.median).toBe(200); // median
    expect(res.p75).toBe(400); // max
  });
});

describe('buildAnalysisSummary', () => {
  const sampleInput = {
    generatedForDate: '2026-10-23',
    monthsRequested: 6,
    completeMonths: [
      {
        monthKey: '2026-04',
        income: 8500000,
        expense: 7900000,
        fixedExpense: 4000000,
        variableExpense: 3900000,
        debtRepayPaid: 0,
        uncategorizedExpense: 100000,
      },
      {
        monthKey: '2026-05',
        income: 9000000,
        expense: 8000000,
        fixedExpense: 4100000,
        variableExpense: 3900000,
        debtRepayPaid: 0,
        uncategorizedExpense: 100000,
      },
      {
        monthKey: '2026-06',
        income: 9200000,
        expense: 8500000,
        fixedExpense: 4200000,
        variableExpense: 4300000,
        debtRepayPaid: 0,
        uncategorizedExpense: 100000,
      },
      {
        monthKey: '2026-07',
        income: 8800000,
        expense: 8200000,
        fixedExpense: 4200000,
        variableExpense: 4000000,
        debtRepayPaid: 0,
        uncategorizedExpense: 100000,
      },
      {
        monthKey: '2026-08',
        income: 9800000,
        expense: 9100000,
        fixedExpense: 4300000,
        variableExpense: 4800000,
        debtRepayPaid: 0,
        uncategorizedExpense: 100000,
      },
      {
        monthKey: '2026-09',
        income: 8700000,
        expense: 8700000,
        fixedExpense: 4400000,
        variableExpense: 4300000,
        debtRepayPaid: 0,
        uncategorizedExpense: 100000,
      },
    ],
    categories: [
      {
        key: 'expense.food',
        isCustom: false,
        totalExpense: 18000000,
        lastMonthExpense: 3000000,
        prevMonthExpense: 3100000,
      },
      {
        key: 'expense.housing',
        isCustom: false,
        totalExpense: 15000000,
        lastMonthExpense: 2500000,
        prevMonthExpense: 2500000,
      },
      {
        key: 'custom_bida',
        isCustom: true,
        totalExpense: 1200000,
        lastMonthExpense: 200000,
        prevMonthExpense: 200000,
      },
      {
        key: 'custom_cafe',
        isCustom: true,
        totalExpense: 1800000,
        lastMonthExpense: 300000,
        prevMonthExpense: 250000,
      },
    ],
    currentMonth: {
      incomeSoFar: 9000000,
      expenseSoFar: 3100000,
      dayOfMonth: 23,
    },
    recurringMonthlyTotal: 4200000,
    liquidBalance: 3200000,
    availableForGoals: 200000,
    goals: [
      {
        targetAmount: 10000000,
        currentAmount: 2000000,
        deadline: '2027-04-30',
      },
    ],
    debts: {
      outstandingBorrowed: 0,
      outstandingLent: 0,
    },
  };

  it('produces a full analysis summary matching expectation', () => {
    const summary = buildAnalysisSummary(sampleInput);

    expect(summary.schemaVersion).toBe(1);
    expect(summary.currency).toBe('VND');
    expect(summary.window.monthsWithData).toBe(6);
    expect(summary.income.monthlyMin).toBe(8500000);
    expect(summary.income.monthlyMax).toBe(9800000);
    expect(summary.currentMonth.projectedExpense).toBe(
      Math.round((3100000 * 31) / 23),
    );

    // Custom categories merged under key 'custom'
    const customCat = summary.topExpenseCategories.find(
      (c) => c.key === 'custom',
    );
    expect(customCat).toBeDefined();
    expect(customCat?.monthlyAvg).toBe(Math.round((1200000 + 1800000) / 6));

    // Emergency fund
    expect(summary.savings.emergencyFundMonths).toBe(0);
    expect(summary.riskFlags).toHaveLength(0);
  });

  it('does not flag missing income when only the current month contains income', () => {
    const summary = buildAnalysisSummary({
      ...sampleInput,
      firstTransactionMonth: '2026-10',
      completeMonths: [],
      currentMonth: {
        incomeSoFar: 3_000_000,
        expenseSoFar: 2_916_000,
        dayOfMonth: 4,
      },
    });
    expect(summary.window.monthsWithData).toBe(0);
    expect(summary.income.monthlyAvg).toBe(0);
    expect(summary.currentMonth.incomeSoFar).toBe(3_000_000);
    expect(summary.riskFlags).not.toContain('NO_INCOME_RECORDED');
    expect(summary.dataQuality).toContain('LESS_THAN_3_MONTHS');
  });

  it('flags DEBT_STRESS when median surplus is negative over >= 3 months', () => {
    const stressedInput = {
      ...sampleInput,
      completeMonths: sampleInput.completeMonths.map((m) => ({
        ...m,
        income: 5000000,
        expense: 7000000,
      })),
    };
    const summary = buildAnalysisSummary(stressedInput);
    expect(summary.riskFlags).toContain('DEBT_STRESS');
  });

  it('sets data quality flags for new accounts with few months', () => {
    const newAccountInput = {
      ...sampleInput,
      completeMonths: sampleInput.completeMonths.slice(0, 2),
    };
    const summary = buildAnalysisSummary(newAccountInput);
    expect(summary.dataQuality).toContain('FEW_MONTHS');
    expect(summary.dataQuality).toContain('LESS_THAN_3_MONTHS');
  });
});
