import { describe, expect, it } from 'vitest';

import {
  AdviceRequestSchema,
  AdviceResponseSchema,
  CalculationSchema,
} from './advice';

describe('Advice schemas', () => {
  const sampleSummary = {
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
    topExpenseCategories: [],
    commitments: {
      recurringMonthlyTotal: 4200000,
      debtMonthlyObligation: 0,
    },
    savings: {
      liquidBalance: 3200000,
      availableForGoals: 200000,
      emergencyFundMonths: 0,
    },
    goals: [],
    debts: { outstandingBorrowed: 0, outstandingLent: 0, dtiBps: 0 },
    riskFlags: [],
    dataQuality: [],
  };

  it('validates a time_to_afford calculation', () => {
    const calc = {
      type: 'time_to_afford',
      inputs: {
        price: 2000000,
        available: 200000,
        surplus: 600000,
      },
      results: {
        remaining: 1800000,
        conservativeMonths: 6,
        typicalMonths: 3,
        optimisticMonths: 2,
        cutMonths: null,
      },
    };
    const parsed = CalculationSchema.parse(calc);
    expect(parsed.type).toBe('time_to_afford');
    if (parsed.type === 'time_to_afford') {
      expect(parsed.results.typicalMonths).toBe(3);
    }
  });

  it('validates a valid AdviceRequest', () => {
    const request = {
      requestId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      appVersion: '0.1.0',
      locale: 'vi-VN',
      plan: 'free',
      question: 'Mình có mua được điện thoại 10 triệu không?',
      intent: 'purchase_affordability',
      calculations: [],
      summary: sampleSummary,
      history: [
        {
          role: 'user',
          text: 'Chào bạn',
        },
      ],
    };
    const parsed = AdviceRequestSchema.parse(request);
    expect(parsed.intent).toBe('purchase_affordability');
    expect(parsed.history).toHaveLength(1);
  });

  it('validates an AdviceSuccessResponse and an AdviceErrorResponse', () => {
    const successRes = {
      success: true,
      message: 'OK',
      code: 'OK',
      requestId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      intent: 'loan_estimate',
      answer: 'Khoản vay trả góp 10 triệu với lãi 12%...',
      calculations: [],
    };
    const parsedSuccess = AdviceResponseSchema.parse(successRes);
    expect(parsedSuccess.success).toBe(true);

    const errorRes = {
      success: false,
      message: 'Bạn đã dùng hết lượt hỏi AI hôm nay.',
      code: 'QUOTA_EXCEEDED_DEVICE',
      requestId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      fallbackTemplate: 'Khoản vay 10 triệu...',
    };
    const parsedError = AdviceResponseSchema.parse(errorRes);
    expect(parsedError.success).toBe(false);
  });
});
