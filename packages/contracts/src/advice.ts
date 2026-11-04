import { z } from 'zod';

import { AnalysisSummarySchema } from './analysis';
import { MoneySchema } from './money';

export const IntentSchema = z.enum([
  'purchase_affordability',
  'loan_estimate',
  'savings_plan',
  'budget_review',
  'spending_overview',
  'general',
]);
export type Intent = z.infer<typeof IntentSchema>;

// C1: Time to afford calculation
export const TimeToAffordCalculationSchema = z.object({
  type: z.literal('time_to_afford'),
  inputs: z.object({
    price: MoneySchema,
    available: MoneySchema,
    surplus: z.number().int().safe(),
    categoryMonthlyAvg: MoneySchema.optional(),
    reductionBps: z.number().int().min(0).max(10000).optional(),
  }),
  results: z.object({
    remaining: MoneySchema,
    conservativeMonths: z.number().int().min(0).nullable(),
    typicalMonths: z.number().int().min(0).nullable(),
    optimisticMonths: z.number().int().min(0).nullable(),
    cutMonths: z.number().int().min(0).nullable().optional(),
  }),
});
export type TimeToAffordCalculation = z.infer<
  typeof TimeToAffordCalculationSchema
>;

// C2: Savings plan calculation
export const SavingsPlanCalculationSchema = z.object({
  type: z.literal('savings_plan'),
  inputs: z.object({
    target: MoneySchema,
    available: MoneySchema,
    months: z.number().int().min(1),
    annualRate: z.number().min(0).max(1).optional(),
  }),
  results: z.object({
    remaining: MoneySchema,
    requiredPerMonth: MoneySchema,
  }),
});
export type SavingsPlanCalculation = z.infer<
  typeof SavingsPlanCalculationSchema
>;

// C3: Loan estimate calculation
export const LoanEstimateCalculationSchema = z.object({
  type: z.literal('loan_estimate'),
  inputs: z.object({
    principal: MoneySchema,
    annualRate: z.number().min(0).max(1),
    months: z.number().int().min(1),
    rateType: z.enum(['declining', 'flat']),
    upfrontFee: MoneySchema.optional(),
  }),
  results: z.object({
    monthlyPayment: MoneySchema,
    totalInterest: MoneySchema,
    totalPayment: MoneySchema,
    effectiveRateBps: z.number().int().min(0),
  }),
});
export type LoanEstimateCalculation = z.infer<
  typeof LoanEstimateCalculationSchema
>;

// C4: Growth calculation
export const GrowthCalculationSchema = z.object({
  type: z.literal('growth'),
  inputs: z.object({
    presentValue: MoneySchema,
    monthlyContribution: MoneySchema,
    annualRate: z.number().min(0).max(1),
    months: z.number().int().min(1),
  }),
  results: z.object({
    futureValue: MoneySchema,
    totalContributions: MoneySchema,
    totalInterest: MoneySchema,
  }),
});
export type GrowthCalculation = z.infer<typeof GrowthCalculationSchema>;

// C5: Financial ratios calculation
export const RatiosCalculationSchema = z.object({
  type: z.literal('ratios'),
  inputs: z.object({
    liquidBalance: MoneySchema,
    monthlyExpenseAvg: MoneySchema,
    debtMonthlyObligation: MoneySchema,
    monthlyIncomeAvg: MoneySchema,
  }),
  results: z.object({
    emergencyFundMonths: z.number().int().min(0).nullable(),
    dtiBps: z.number().int().min(0).nullable(),
  }),
});
export type RatiosCalculation = z.infer<typeof RatiosCalculationSchema>;

export const CalculationSchema = z.discriminatedUnion('type', [
  TimeToAffordCalculationSchema,
  SavingsPlanCalculationSchema,
  LoanEstimateCalculationSchema,
  GrowthCalculationSchema,
  RatiosCalculationSchema,
]);
export type Calculation = z.infer<typeof CalculationSchema>;

export const AdviceHistoryItemSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().trim().min(1).max(500),
});
export type AdviceHistoryItem = z.infer<typeof AdviceHistoryItemSchema>;

export const AdviceRequestSchema = z.object({
  requestId: z.string().uuid(),
  appVersion: z.string().min(1),
  locale: z.literal('vi-VN').default('vi-VN'),
  plan: z.literal('free').default('free'),
  question: z.string().trim().min(1).max(500),
  intent: IntentSchema,
  calculations: z.array(CalculationSchema).default([]),
  summary: AnalysisSummarySchema,
  history: z.array(AdviceHistoryItemSchema).max(6).default([]),
});
export type AdviceRequest = z.infer<typeof AdviceRequestSchema>;

export const AdviceErrorCodeSchema = z.enum([
  'QUOTA_EXCEEDED_DEVICE',
  'QUOTA_EXCEEDED_GLOBAL',
  'UPSTREAM_UNAVAILABLE',
  'ANSWER_UNVERIFIED',
  'PII_DETECTED',
  'ADVICE_OUT_OF_SCOPE',
  'ADVICE_RESTRICTED',
  'ADVICE_AMBIGUOUS',
  'RATE_LIMIT_EXCEEDED',
  'INTERNAL_ERROR',
  'BAD_REQUEST',
]);
export type AdviceErrorCode = z.infer<typeof AdviceErrorCodeSchema>;

export const AdviceSuccessResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().default('OK'),
  code: z.literal('OK').default('OK'),
  requestId: z.string().uuid(),
  intent: IntentSchema,
  answer: z.string(),
  calculations: z.array(CalculationSchema).default([]),
  model: z.string().optional(),
});
export type AdviceSuccessResponse = z.infer<
  typeof AdviceSuccessResponseSchema
>;

export const AdviceErrorResponseSchema = z.object({
  success: z.literal(false),
  message: z.string(),
  code: AdviceErrorCodeSchema,
  requestId: z.string().uuid().optional(),
  fallbackTemplate: z.string().optional(),
});
export type AdviceErrorResponse = z.infer<typeof AdviceErrorResponseSchema>;

export const AdviceResponseSchema = z.discriminatedUnion('success', [
  AdviceSuccessResponseSchema,
  AdviceErrorResponseSchema,
]);
export type AdviceResponse = z.infer<typeof AdviceResponseSchema>;
