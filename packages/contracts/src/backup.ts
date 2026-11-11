import { MAX_AMOUNT_VND } from '@pfm/domain';
import { z } from 'zod';

export const BACKUP_FORMAT = 'pfm-backup' as const;
export const BACKUP_FORMAT_VERSION = 1 as const;
export const BACKUP_LATEST_SCHEMA_VERSION = 5 as const;

export const BACKUP_ALLOWED_SETTINGS_KEYS = [
  'onboarding_complete',
  'budget_banner_dismissed_v1',
] as const;

export type BackupAllowedSettingKey =
  (typeof BACKUP_ALLOWED_SETTINGS_KEYS)[number];

const RowIdSchema = z.string().min(1);
const NullableRowIdSchema = RowIdSchema.nullable();
const SqliteBoolSchema = z.union([z.literal(0), z.literal(1)]);
const SignedAmountSchema = z
  .number()
  .int()
  .safe()
  .min(-MAX_AMOUNT_VND * 10)
  .max(MAX_AMOUNT_VND * 10);
const PositiveAmountSchema = z
  .number()
  .int()
  .safe()
  .min(1)
  .max(MAX_AMOUNT_VND);
const NonNegativeAmountSchema = z
  .number()
  .int()
  .safe()
  .min(0)
  .max(MAX_AMOUNT_VND);

export const BackupWalletRowSchema = z
  .object({
    id: RowIdSchema,
    name: z.string().min(1),
    kind: z.enum([
      'cash',
      'bank',
      'ewallet',
      'credit_card',
      'savings',
      'other',
    ]),
    currency: z.literal('VND'),
    initial_balance: z
      .number()
      .int()
      .safe()
      .min(-MAX_AMOUNT_VND)
      .max(MAX_AMOUNT_VND),
    is_archived: SqliteBoolSchema,
    is_goal_funding: SqliteBoolSchema,
    sort_order: z.number().int().safe(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export const BackupCategoryRowSchema = z
  .object({
    id: RowIdSchema,
    system_key: z.string().min(1).nullable(),
    parent_id: NullableRowIdSchema,
    name: z.string().min(1),
    kind: z.enum(['expense', 'income']),
    is_fixed_cost: SqliteBoolSchema,
    icon: z.string().nullable(),
    color: z.string().nullable(),
    is_archived: SqliteBoolSchema,
    sort_order: z.number().int().safe(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export const BackupDebtRowSchema = z
  .object({
    id: RowIdSchema,
    counterparty_label: z.string().min(1),
    direction: z.enum(['borrowed', 'lent']),
    due_on: z.string().nullable(),
    status: z.enum(['open', 'closed']),
    note: z.string().nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export const BackupRecurringRuleRowSchema = z
  .object({
    id: RowIdSchema,
    kind: z.enum(['expense', 'income', 'transfer']),
    amount: PositiveAmountSchema,
    wallet_id: RowIdSchema,
    to_wallet_id: NullableRowIdSchema,
    category_id: NullableRowIdSchema,
    note: z.string().nullable(),
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval_count: z.number().int().safe().min(1),
    day_of_week: z.number().int().min(1).max(7).nullable(),
    day_of_month: z.number().int().min(1).max(31).nullable(),
    start_on: z.string().min(1),
    end_on: z.string().nullable(),
    last_generated_on: z.string().nullable(),
    is_active: SqliteBoolSchema,
    remind_before_days: z.number().int().safe().min(0),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export const BackupTransactionRowSchema = z
  .object({
    id: RowIdSchema,
    kind: z.enum([
      'expense',
      'income',
      'transfer',
      'debt_borrow',
      'debt_lend',
      'debt_repay_paid',
      'debt_repay_received',
    ]),
    amount: PositiveAmountSchema,
    wallet_id: RowIdSchema,
    to_wallet_id: NullableRowIdSchema,
    category_id: NullableRowIdSchema,
    debt_id: NullableRowIdSchema,
    occurred_on: z.string().min(1),
    occurred_at: z.string().min(1),
    note: z.string().nullable(),
    source: z.enum(['manual', 'parsed', 'recurring', 'import']),
    recurring_rule_id: NullableRowIdSchema,
    original_currency: z.enum(['VND', 'USD']).optional(),
    original_amount_minor: z.number().int().safe().nullable().optional(),
    booking_rate: z.number().finite().positive().nullable().optional(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export const BackupRecurringSkipRowSchema = z
  .object({
    recurring_rule_id: RowIdSchema,
    occurred_on: z.string().min(1),
  })
  .strict();

export const BackupBudgetRowSchema = z
  .object({
    id: RowIdSchema,
    category_id: NullableRowIdSchema,
    amount: PositiveAmountSchema,
    warn_percent: z.number().int().min(1).max(100),
    start_month: z.string().min(1),
    end_month: z.string().nullable(),
    is_active: SqliteBoolSchema,
    period_type: z.enum(['monthly', 'custom']).optional().default('monthly'),
    start_date: z.string().nullable().optional().default(null),
    end_date: z.string().nullable().optional().default(null),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export const BackupGoalRowSchema = z
  .object({
    id: RowIdSchema,
    name: z.string().min(1),
    target_amount: PositiveAmountSchema,
    deadline_on: z.string().nullable(),
    funding_wallet_id: NullableRowIdSchema,
    manual_saved_amount: NonNegativeAmountSchema,
    status: z.enum(['active', 'achieved', 'archived']),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export const BackupParseLearningRowSchema = z
  .object({
    token_key: z.string().min(1),
    kind: z.string().min(1),
    category_id: NullableRowIdSchema,
    hit_count: z.number().int().safe().min(0),
    updated_at: z.string().min(1),
  })
  .strict();

export const BackupSettingRowSchema = z
  .object({
    key: z.enum(BACKUP_ALLOWED_SETTINGS_KEYS),
    value: z.string(),
  })
  .strict();

export const BackupCountsSchema = z
  .object({
    wallets: z.number().int().min(0),
    categories: z.number().int().min(0),
    debts: z.number().int().min(0),
    recurring_rules: z.number().int().min(0),
    transactions: z.number().int().min(0),
    recurring_skips: z.number().int().min(0),
    budgets: z.number().int().min(0),
    goals: z.number().int().min(0),
    parse_learning: z.number().int().min(0),
    settings: z.number().int().min(0),
  })
  .strict();

export const BackupTablesSchema = z
  .object({
    wallets: z.array(BackupWalletRowSchema),
    categories: z.array(BackupCategoryRowSchema),
    debts: z.array(BackupDebtRowSchema),
    recurring_rules: z.array(BackupRecurringRuleRowSchema),
    transactions: z.array(BackupTransactionRowSchema),
    recurring_skips: z.array(BackupRecurringSkipRowSchema),
    budgets: z.array(BackupBudgetRowSchema),
    goals: z.array(BackupGoalRowSchema),
    parse_learning: z.array(BackupParseLearningRowSchema),
    settings: z.array(BackupSettingRowSchema),
  })
  .strict();

export const BackupSnapshotSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    formatVersion: z.number().int().min(1),
    schemaVersion: z.number().int().min(1),
    appVersion: z.string().min(1),
    createdAt: z.string().min(1),
    counts: BackupCountsSchema,
    walletBalances: z.record(z.string(), SignedAmountSchema),
    checksum: z.string().regex(/^[a-f0-9]{64}$/i),
    tables: BackupTablesSchema,
  })
  .strict();

export type BackupWalletRow = z.infer<typeof BackupWalletRowSchema>;
export type BackupCategoryRow = z.infer<typeof BackupCategoryRowSchema>;
export type BackupDebtRow = z.infer<typeof BackupDebtRowSchema>;
export type BackupRecurringRuleRow = z.infer<
  typeof BackupRecurringRuleRowSchema
>;
export type BackupTransactionRow = z.infer<typeof BackupTransactionRowSchema>;
export type BackupRecurringSkipRow = z.infer<
  typeof BackupRecurringSkipRowSchema
>;
export type BackupBudgetRow = z.infer<typeof BackupBudgetRowSchema>;
export type BackupGoalRow = z.infer<typeof BackupGoalRowSchema>;
export type BackupParseLearningRow = z.infer<
  typeof BackupParseLearningRowSchema
>;
export type BackupSettingRow = z.infer<typeof BackupSettingRowSchema>;
export type BackupCounts = z.infer<typeof BackupCountsSchema>;
export type BackupTables = z.infer<typeof BackupTablesSchema>;
export type BackupSnapshot = z.infer<typeof BackupSnapshotSchema>;
