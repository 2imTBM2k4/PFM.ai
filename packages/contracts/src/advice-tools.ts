import { z } from 'zod';
import { addDays, validateDate } from '@pfm/domain';

export const AdviceToolContextSchema = z.object({
  sessionId: z.string().trim().min(1).max(64),
  stateRevision: z.number().int().safe().nonnegative(),
  deadline: z.number().finite(),
});
const DateSchema = z.string().superRefine((date, context) => {
  try {
    validateDate(date);
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid calendar date.' });
  }
});
export const GetTransactionsParamsSchema = z
  .object({
    from: DateSchema,
    to: DateSchema,
    kind: z.enum(['income', 'expense']).nullable().default(null),
    category_id: z.string().trim().min(1).max(120).nullable().default(null),
    limit: z.number().int().min(1).max(20).default(20),
  })
  .strict()
  .refine(({ from, to }) => from <= to, 'Reversed date range.');
export const CalculateBudgetStatusParamsSchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .refine((month) => {
        try {
          validateDate(`${month}-01`);
          return true;
        } catch {
          return false;
        }
      }),
    budget_id: z.string().trim().min(1).max(120).nullable().default(null),
  })
  .strict();
export const PlanSavingsGoalParamsSchema = z.object({}).strict();
export const GetFinancialSnapshotParamsSchema = z
  .object({
    months: z.number().int().min(1).max(12),
    fields: z
      .array(
        z.enum([
          'monthly_income_avg',
          'monthly_expense_avg',
          'liquid_balance',
          'months_with_data',
        ]),
      )
      .min(1)
      .max(4)
      .refine((fields) => new Set(fields).size === fields.length),
  })
  .strict();
export const GetSpendingBreakdownParamsSchema = z
  .object({
    from: DateSchema,
    to: DateSchema,
  })
  .strict()
  .refine(({ from, to }) => from <= to, 'Reversed date range.')
  .refine(
    ({ from, to }) => to <= addDays(from, 365),
    'Date range exceeds 366 days.',
  );
export const GetUpcomingObligationsParamsSchema = z
  .object({
    days_ahead: z.number().int().min(7).max(31).default(30),
  })
  .strict();
export const GetSavingsGoalsParamsSchema = z
  .object({
    include_achieved: z.boolean().default(false),
  })
  .strict();
export type GetTransactionsParams = z.infer<typeof GetTransactionsParamsSchema>;
export type CalculateBudgetStatusParams = z.infer<
  typeof CalculateBudgetStatusParamsSchema
>;
export type PlanSavingsGoalParams = z.infer<typeof PlanSavingsGoalParamsSchema>;
export type GetFinancialSnapshotParams = z.infer<
  typeof GetFinancialSnapshotParamsSchema
>;
export type GetSpendingBreakdownParams = z.infer<
  typeof GetSpendingBreakdownParamsSchema
>;
export type GetUpcomingObligationsParams = z.infer<
  typeof GetUpcomingObligationsParamsSchema
>;
export type GetSavingsGoalsParams = z.infer<typeof GetSavingsGoalsParamsSchema>;

export type ToolErrorCode =
  | 'INVALID_PARAMS'
  | 'TIMEOUT'
  | 'TOOL_NOT_ALLOWED'
  | 'DATA_ERROR'
  | 'STATE_ERROR';

export type ToolResult<T = unknown> =
  | {
      status: 'ok';
      data: T;
      stateRevision: number;
      calculationVersion: number;
      truncated?: boolean;
    }
  | { status: 'needs_clarification'; fields: string[] }
  | { status: 'error'; code: ToolErrorCode; retryable: boolean };
