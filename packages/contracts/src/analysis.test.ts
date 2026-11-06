import { buildAnalysisSummary } from '@pfm/domain';
import { describe, expect, it } from 'vitest';

import { AnalysisSummarySchema } from './analysis';

describe('AnalysisSummarySchema', () => {
  const sampleSyntheticSummary = {
    schemaVersion: 1,
    generatedForDate: '2026-10-23',
    currency: 'VND',
    window: { monthsRequested: 6, monthsWithData: 6 },
    income: { monthlyAvg: 9000000, monthlyMin: 8500000, monthlyMax: 9800000 },
    expense: {
      monthlyAvg: 8400000,
      monthlyMin: 7900000,
      monthlyMax: 9100000,
      fixedMonthlyAvg: 4200000,
      variableMonthlyAvg: 4200000,
    },
    surplus: { monthlyAvg: 600000, p25: 300000, median: 600000, p75: 900000 },
    currentMonth: {
      incomeSoFar: 9000000,
      expenseSoFar: 3100000,
      daysElapsed: 23,
      daysInMonth: 31,
      projectedExpense: 4178261,
    },
    topExpenseCategories: [
      {
        key: 'expense.food',
        shareBps: 3500,
        monthlyAvg: 2940000,
        changeVsPrevPctBps: -500,
      },
      {
        key: 'expense.housing',
        shareBps: 3000,
        monthlyAvg: 2520000,
        changeVsPrevPctBps: 0,
      },
      {
        key: 'expense.transport',
        shareBps: 1200,
        monthlyAvg: 1008000,
        changeVsPrevPctBps: 200,
      },
      {
        key: 'custom',
        shareBps: 500,
        monthlyAvg: 420000,
        changeVsPrevPctBps: null,
      },
    ],
    commitments: {
      recurringMonthlyTotal: 4200000,
      debtMonthlyObligation: 0,
    },
    savings: {
      liquidBalance: 3200000,
      availableForGoals: 200000,
      emergencyFundMonths: 0,
    },
    goals: [
      {
        progressBps: 2000,
        monthsLeft: 6,
        requiredPerMonth: 1333334,
      },
    ],
    debts: { outstandingBorrowed: 0, outstandingLent: 0, dtiBps: 0 },
    riskFlags: [],
    dataQuality: [],
  };

  it('validates the Appendix G synthetic sample without error', () => {
    const parsed = AnalysisSummarySchema.parse(sampleSyntheticSummary);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.currency).toBe('VND');
    expect(parsed.surplus.monthlyAvg).toBe(600000);
  });

  it('validates outputs produced by domain buildAnalysisSummary', () => {
    const domainSummary = buildAnalysisSummary({
      generatedForDate: '2026-10-23',
      monthsRequested: 6,
      completeMonths: [
        {
          monthKey: '2026-04',
          income: 9000000,
          expense: 8000000,
          fixedExpense: 4000000,
          variableExpense: 4000000,
          debtRepayPaid: 0,
          uncategorizedExpense: 0,
        },
      ],
      categories: [],
      currentMonth: {
        incomeSoFar: 9000000,
        expenseSoFar: 3000000,
        dayOfMonth: 23,
      },
      recurringMonthlyTotal: 0,
      liquidBalance: 5000000,
      availableForGoals: 0,
      goals: [],
      debts: {
        outstandingBorrowed: 0,
        outstandingLent: 0,
      },
    });

    const parsed = AnalysisSummarySchema.parse(domainSummary);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.generatedForDate).toBe('2026-10-23');
  });

  it('allows negative surplus values when expenses exceed income', () => {
    const withDeficit = {
      ...sampleSyntheticSummary,
      surplus: {
        monthlyAvg: -500000,
        p25: -1000000,
        median: -400000,
        p75: -100000,
      },
      riskFlags: ['DEBT_STRESS'],
    };
    const parsed = AnalysisSummarySchema.parse(withDeficit);
    expect(parsed.surplus.monthlyAvg).toBe(-500000);
    expect(parsed.riskFlags).toContain('DEBT_STRESS');
  });

  it('rejects more than 8 top expense categories', () => {
    const tooManyCategories = {
      ...sampleSyntheticSummary,
      topExpenseCategories: Array.from({ length: 9 }, (_, i) => ({
        key: `expense.cat_${i}`,
        shareBps: 1000,
        monthlyAvg: 100000,
        changeVsPrevPctBps: null,
      })),
    };
    expect(() => AnalysisSummarySchema.parse(tooManyCategories)).toThrow();
  });

  it('rejects more than 5 goals', () => {
    const tooManyGoals = {
      ...sampleSyntheticSummary,
      goals: Array.from({ length: 6 }, () => ({
        progressBps: 1000,
        monthsLeft: 5,
        requiredPerMonth: 200000,
      })),
    };
    expect(() => AnalysisSummarySchema.parse(tooManyGoals)).toThrow();
  });

  it('rejects invalid ISO dates for generatedForDate', () => {
    const invalidDate = {
      ...sampleSyntheticSummary,
      generatedForDate: 'not-a-date',
    };
    expect(() => AnalysisSummarySchema.parse(invalidDate)).toThrow();
  });
});
