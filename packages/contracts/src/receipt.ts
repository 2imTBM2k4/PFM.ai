import { z } from 'zod';

const validDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export const ReceiptScanRequestSchema = z.object({
  mimeType: z.literal('image/jpeg'),
  imageBase64: z.string().min(4).max(Math.ceil((2 * 1024 * 1024 * 4) / 3) + 4),
}).strict();

export const ReceiptCategoryKeySchema = z.enum([
  'expense.food', 'expense.food.eating_out', 'expense.food.coffee', 'expense.food.groceries',
  'expense.transport', 'expense.transport.fuel', 'expense.transport.ride', 'expense.transport.parking',
  'expense.housing', 'expense.housing.rent', 'expense.housing.utilities', 'expense.housing.internet',
  'expense.shopping', 'expense.health', 'expense.education', 'expense.entertainment',
  'expense.family_gifts', 'expense.bills_subscriptions',
]);

export const ReceiptDataSchema = z.object({
  merchant: z.string().trim().min(1).max(100).nullable(),
  totalVnd: z.number().int().positive().safe().nullable().optional(),
  totalMinor: z.number().int().positive().safe().nullable().optional(),
  currency: z.enum(['VND', 'USD']).nullable().optional(),
  occurredOn: z.string().refine(validDate).nullable(),
  categoryKey: ReceiptCategoryKeySchema.nullable().catch(null),
}).strict().superRefine((value, context) => {
  if (value.totalVnd === undefined && value.totalMinor === undefined)
    context.addIssue({ code: 'custom', message: 'A receipt total field is required.' });
  if (value.totalMinor !== undefined && value.totalMinor !== null && !value.currency)
    context.addIssue({ code: 'custom', path: ['currency'], message: 'Receipt currency is required.' });
  if (value.totalVnd !== undefined && value.totalMinor !== undefined)
    context.addIssue({ code: 'custom', message: 'Only one receipt total is allowed.' });
});

export const ReceiptScanResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  code: z.literal('OK'),
  receipt: ReceiptDataSchema,
  warnings: z.array(z.string()),
});

export type ReceiptData = z.infer<typeof ReceiptDataSchema>;
export type ReceiptScanResponse = z.infer<typeof ReceiptScanResponseSchema>;
