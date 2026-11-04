import { MAX_AMOUNT_VND } from '@pfm/domain';
import { z } from 'zod';

import { CurrencySchema, MoneySchema } from './money';

export const RiskFlagSchema = z.enum(['DEBT_STRESS', 'NO_INCOME_RECORDED']);
export type RiskFlag = z.infer<typeof RiskFlagSchema>;

export const DataQualityFlagSchema = z.enum([
  'FEW_MONTHS',
  'LESS_THAN_3_MONTHS',
  'MANY_UNCATEGORIZED',
  'HIGH_VARIANCE',
]);
export type DataQualityFlag = z.infer<typeof DataQualityFlagSchema>;

export const SignedMoneySchema = z
  .number()
  .int()
  .safe()
  .min(-MAX_AMOUNT_VND)
  .max(MAX_AMOUNT_VND);

export const WindowSummarySchema = z.object({
  monthsRequested: z.number().int().min(1).max(12),
  monthsWithData: z.number().int().min(0).max(12),
});
export type WindowSummary = z.infer<typeof WindowSummarySchema>;

export const IncomeSummarySchema = z.object({
  monthlyAvg: MoneySchema,
  monthlyMin: MoneySchema,
  monthlyMax: MoneySchema,
});
export type IncomeSummary = z.infer<typeof IncomeSummarySchema>;

export const ExpenseSummarySchema = z.object({
  monthlyAvg: MoneySchema,
  monthlyMin: MoneySchema,
  monthlyMax: MoneySchema,
  fixedMonthlyAvg: MoneySchema,
  variableMonthlyAvg: MoneySchema,
  /** Essential spend only; null when the device could not classify it. */
  essentialMonthlyAvg: MoneySchema.nullable().default(null),
});
export type ExpenseSummary = z.infer<typeof ExpenseSummarySchema>;

export const SurplusSummarySchema = z.object({
  monthlyAvg: SignedMoneySchema,
  p25: SignedMoneySchema,
  median: SignedMoneySchema,
  p75: SignedMoneySchema,
});
export type SurplusSummary = z.infer<typeof SurplusSummarySchema>;

export const CurrentMonthSummarySchema = z.object({
  incomeSoFar: MoneySchema,
  expenseSoFar: MoneySchema,
  daysElapsed: z.number().int().min(1).max(31),
  daysInMonth: z.number().int().min(28).max(31),
  projectedExpense: MoneySchema.nullable(),
});
export type CurrentMonthSummary = z.infer<typeof CurrentMonthSummarySchema>;

export const TopExpenseCategorySchema = z.object({
  key: z.string().trim().min(1),
  shareBps: z.number().int().min(0).max(10000),
  monthlyAvg: MoneySchema,
  changeVsPrevPctBps: z.number().int().nullable(),
});
export type TopExpenseCategory = z.infer<typeof TopExpenseCategorySchema>;

export const CommitmentsSummarySchema = z.object({
  recurringMonthlyTotal: MoneySchema,
  debtMonthlyObligation: MoneySchema,
});
export type CommitmentsSummary = z.infer<typeof CommitmentsSummarySchema>;

export const SavingsSummarySchema = z.object({
  liquidBalance: MoneySchema,
  availableForGoals: MoneySchema,
  emergencyFundMonths: z.number().int().min(0).nullable(),
  /** Months of cover using essential spend only; null when unknown. */
  emergencyFundMonthsEssential: z
    .number()
    .int()
    .min(0)
    .nullable()
    .default(null),
});
export type SavingsSummary = z.infer<typeof SavingsSummarySchema>;

export const GoalSummaryItemSchema = z.object({
  progressBps: z.number().int().min(0).max(10000),
  monthsLeft: z.number().int().min(0).nullable(),
  requiredPerMonth: MoneySchema.nullable(),
});
export type GoalSummaryItem = z.infer<typeof GoalSummaryItemSchema>;

export const DebtsSummarySchema = z.object({
  outstandingBorrowed: MoneySchema,
  outstandingLent: MoneySchema,
  dtiBps: z.number().int().min(0).nullable(),
});
export type DebtsSummary = z.infer<typeof DebtsSummarySchema>;

export const AnalysisSummarySchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedForDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid ISO date string.'),
  currency: CurrencySchema.default('VND'),
  window: WindowSummarySchema,
  income: IncomeSummarySchema,
  expense: ExpenseSummarySchema,
  surplus: SurplusSummarySchema,
  currentMonth: CurrentMonthSummarySchema,
  topExpenseCategories: z.array(TopExpenseCategorySchema).max(8),
  commitments: CommitmentsSummarySchema,
  savings: SavingsSummarySchema,
  goals: z.array(GoalSummaryItemSchema).max(5),
  debts: DebtsSummarySchema,
  riskFlags: z.array(RiskFlagSchema),
  dataQuality: z.array(DataQualityFlagSchema),
});
export type AnalysisSummary = z.infer<typeof AnalysisSummarySchema>;
