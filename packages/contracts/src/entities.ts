import { MAX_AMOUNT_VND, validateDate } from '@pfm/domain';
import { z } from 'zod';

import { MoneySchema } from './money';

// Check canonical calendar dates without letting validation throw to callers.
function isCalendarDate(value: string): boolean {
  try {
    validateDate(value);
    return true;
  } catch {
    return false;
  }
}

// Preserve optional text exactly, except for empty or missing values becoming null.
function nullableText(value: string | null | undefined): string | null {
  return value === '' || value === undefined ? null : value;
}

const IdSchema = z.string().uuid();
const NullableIdSchema = IdSchema.nullable().default(null);
const NameSchema = z.string().trim().min(1);
const DateSchema = z.string().refine(isCalendarDate, 'Invalid calendar date.');
const MonthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine((value) => isCalendarDate(`${value}-01`), 'Invalid month.');
const TextSchema = z.string().nullable().optional().transform(nullableText);

export const WalletInputSchema = z
  .object({
    name: NameSchema,
    kind: z.enum([
      'cash',
      'bank',
      'ewallet',
      'credit_card',
      'savings',
      'other',
    ]),
    initialBalance: z
      .number()
      .int()
      .safe()
      .min(-MAX_AMOUNT_VND)
      .max(MAX_AMOUNT_VND)
      .default(0),
    isGoalFunding: z.boolean().default(false),
    sortOrder: z.number().int().safe().min(0).default(0),
  })
  .strict();

export const CategoryInputSchema = z
  .object({
    name: NameSchema,
    kind: z.enum(['expense', 'income']),
    parentId: NullableIdSchema,
    isFixedCost: z.boolean().default(false),
    icon: TextSchema,
    color: TextSchema,
  })
  .strict();

const TransactionKindSchema = z.enum([
  'expense',
  'income',
  'transfer',
  'debt_borrow',
  'debt_lend',
  'debt_repay_paid',
  'debt_repay_received',
]);

export const ParseLearningInputSchema = z
  .object({
    noteText: z.string(),
    kind: TransactionKindSchema,
    categoryId: NullableIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.kind !== 'expense' &&
      value.kind !== 'income' &&
      value.categoryId !== null
    )
      context.addIssue({
        code: 'custom',
        path: ['categoryId'],
        message: 'Only income and expense can have categories.',
      });
  });
export type ParseLearningInput = z.input<typeof ParseLearningInputSchema>;

export const TransactionInputSchema = z
  .object({
    kind: TransactionKindSchema,
    amount: MoneySchema.positive(),
    currency: z.enum(['VND', 'USD']).default('VND'),
    vndPerUsd: z.number().finite().positive().nullable().default(null),
    walletId: IdSchema,
    toWalletId: NullableIdSchema,
    categoryId: NullableIdSchema,
    debtId: NullableIdSchema,
    occurredOn: DateSchema,
    occurredAt: z.string().datetime({ offset: true }),
    note: TextSchema,
    source: z
      .enum(['manual', 'parsed', 'recurring', 'import'])
      .default('manual'),
    recurringRuleId: NullableIdSchema,
    rawInput: TextSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.currency === 'USD' && value.vndPerUsd === null)
      context.addIssue({ code: 'custom', path: ['vndPerUsd'], message: 'USD requires an exchange rate.' });
    if (value.kind === 'transfer') {
      if (value.toWalletId === null || value.toWalletId === value.walletId) {
        context.addIssue({
          code: 'custom',
          path: ['toWalletId'],
          message: 'A transfer requires a different destination wallet.',
        });
      }
      if (value.categoryId !== null || value.debtId !== null) {
        context.addIssue({
          code: 'custom',
          message: 'Transfers cannot have a category or debt.',
        });
      }
    } else if (value.kind === 'income' || value.kind === 'expense') {
      if (value.toWalletId !== null || value.debtId !== null) {
        context.addIssue({
          code: 'custom',
          message:
            'Income and expense cannot have destination wallets or debts.',
        });
      }
    } else if (
      value.debtId === null ||
      value.toWalletId !== null ||
      value.categoryId !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['debtId'],
        message:
          'Debt entries require a debt and cannot have a destination or category.',
      });
    }
  });

export const BudgetInputSchema = z
  .object({
    categoryId: NullableIdSchema,
    amount: MoneySchema.positive(),
    warnPercent: z.number().int().min(1).max(100).default(80),
    startMonth: MonthSchema,
    endMonth: MonthSchema.nullable().default(null),
  })
  .strict()
  .refine(
    (value) => value.endMonth === null || value.endMonth >= value.startMonth,
    {
      path: ['endMonth'],
      message: 'The end month must not precede the start month.',
    },
  );

export const GoalInputSchema = z
  .object({
    name: NameSchema,
    targetAmount: MoneySchema.positive(),
    manualSavedAmount: MoneySchema.default(0),
    fundingWalletId: NullableIdSchema,
    deadlineOn: DateSchema.nullable().default(null),
  })
  .strict();

export const DebtChangesSchema = z
  .object({
    counterpartyLabel: NameSchema,
    dueOn: DateSchema.nullable().default(null),
    note: TextSchema,
  })
  .strict();
export const DebtInputSchema = DebtChangesSchema.extend({
  direction: z.enum(['borrowed', 'lent']),
  amount: MoneySchema.positive(),
  walletId: IdSchema,
  occurredOn: DateSchema,
}).strict();
export type DebtInput = z.input<typeof DebtInputSchema>;
export type DebtChanges = z.input<typeof DebtChangesSchema>;
export const DebtRepaymentSchema = DebtInputSchema.pick({
  amount: true,
  walletId: true,
  occurredOn: true,
})
  .extend({ note: TextSchema })
  .strict();
export type DebtRepayment = z.input<typeof DebtRepaymentSchema>;

export const RecurringInputSchema = z
  .object({
    kind: z.enum(['expense', 'income', 'transfer']),
    amount: MoneySchema.positive(),
    walletId: IdSchema,
    toWalletId: NullableIdSchema,
    categoryId: NullableIdSchema,
    note: TextSchema,
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    intervalCount: z.number().int().safe().positive().default(1),
    startOn: DateSchema,
    endOn: DateSchema.nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endOn && value.endOn < value.startOn)
      context.addIssue({
        code: 'custom',
        path: ['endOn'],
        message: 'End precedes start.',
      });
    if (
      value.kind === 'transfer'
        ? !value.toWalletId ||
          value.toWalletId === value.walletId ||
          value.categoryId !== null
        : value.toWalletId !== null
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid transfer references.',
      });
  });
export type RecurringInput = z.input<typeof RecurringInputSchema>;

export const TransactionFiltersSchema = z
  .object({
    debtId: IdSchema.optional(),
    text: z.string().default(''),
    from: DateSchema.optional(),
    to: DateSchema.optional(),
    kind: z
      .enum([
        'income',
        'expense',
        'transfer',
        'debt_borrow',
        'debt_lend',
        'debt_repay_paid',
        'debt_repay_received',
      ])
      .optional(),
    walletId: IdSchema.optional(),
    categoryId: IdSchema.optional(),
    minAmount: MoneySchema.optional(),
    maxAmount: MoneySchema.optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'Invalid date range.',
  })
  .refine(
    (value) =>
      value.minAmount === undefined ||
      value.maxAmount === undefined ||
      value.minAmount <= value.maxAmount,
    { message: 'Invalid amount range.' },
  );

export type TransactionFilters = z.input<typeof TransactionFiltersSchema>;

export type WalletInput = z.input<typeof WalletInputSchema>;
export type CategoryInput = z.input<typeof CategoryInputSchema>;
export type TransactionInput = z.input<typeof TransactionInputSchema>;
export type BudgetInput = z.input<typeof BudgetInputSchema>;
export type GoalInput = z.input<typeof GoalInputSchema>;
