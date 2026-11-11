import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  BACKUP_ALLOWED_SETTINGS_KEYS,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_LATEST_SCHEMA_VERSION,
  BackupSnapshotSchema,
  type BackupAllowedSettingKey,
  type BackupBudgetRow,
  type BackupCategoryRow,
  type BackupCounts,
  type BackupDebtRow,
  type BackupGoalRow,
  type BackupParseLearningRow,
  type BackupRecurringRuleRow,
  type BackupRecurringSkipRow,
  type BackupSettingRow,
  type BackupSnapshot,
  type BackupTables,
  type BackupTransactionRow,
  type BackupWalletRow,
} from '@pfm/contracts';
import type { Database } from '@/data/migrate';
import { MIGRATIONS } from '@/data/migrate';

export type HashPort = (canonicalJson: string) => Promise<string> | string;

/**
 * Default SHA-256 hash port backed by `@noble/hashes`, shared across Node (Vitest) and React Native.
 */
export const defaultHashPort: HashPort = (canonicalJson: string): string =>
  bytesToHex(sha256(utf8ToBytes(canonicalJson)));

/**
 * Normalizes every row of every backup table into a fixed key order before JSON serialization,
 * guaranteeing deterministic canonical JSON output regardless of JS object property order.
 */
export function normalizeTablesForCanonicalJson(
  tables: BackupTables,
): BackupTables {
  return {
    wallets: tables.wallets.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      currency: row.currency,
      initial_balance: row.initial_balance,
      is_archived: row.is_archived,
      is_goal_funding: row.is_goal_funding,
      sort_order: row.sort_order,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    categories: tables.categories.map((row) => ({
      id: row.id,
      system_key: row.system_key,
      parent_id: row.parent_id,
      name: row.name,
      kind: row.kind,
      is_fixed_cost: row.is_fixed_cost,
      icon: row.icon,
      color: row.color,
      is_archived: row.is_archived,
      sort_order: row.sort_order,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    debts: tables.debts.map((row) => ({
      id: row.id,
      counterparty_label: row.counterparty_label,
      direction: row.direction,
      due_on: row.due_on,
      status: row.status,
      note: row.note,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    recurring_rules: tables.recurring_rules.map((row) => ({
      id: row.id,
      kind: row.kind,
      amount: row.amount,
      wallet_id: row.wallet_id,
      to_wallet_id: row.to_wallet_id,
      category_id: row.category_id,
      note: row.note,
      frequency: row.frequency,
      interval_count: row.interval_count,
      day_of_week: row.day_of_week,
      day_of_month: row.day_of_month,
      start_on: row.start_on,
      end_on: row.end_on,
      last_generated_on: row.last_generated_on,
      is_active: row.is_active,
      remind_before_days: row.remind_before_days,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    transactions: tables.transactions.map((row) => ({
      id: row.id,
      kind: row.kind,
      amount: row.amount,
      wallet_id: row.wallet_id,
      to_wallet_id: row.to_wallet_id,
      category_id: row.category_id,
      debt_id: row.debt_id,
      occurred_on: row.occurred_on,
      occurred_at: row.occurred_at,
      note: row.note,
      source: row.source,
      recurring_rule_id: row.recurring_rule_id,
      ...(row.original_currency !== undefined
        ? { original_currency: row.original_currency }
        : {}),
      ...(row.original_amount_minor !== undefined
        ? { original_amount_minor: row.original_amount_minor }
        : {}),
      ...(row.booking_rate !== undefined
        ? { booking_rate: row.booking_rate }
        : {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    recurring_skips: tables.recurring_skips.map((row) => ({
      recurring_rule_id: row.recurring_rule_id,
      occurred_on: row.occurred_on,
    })),
    budgets: tables.budgets.map((row) => ({
      id: row.id,
      category_id: row.category_id,
      amount: row.amount,
      warn_percent: row.warn_percent,
      start_month: row.start_month,
      end_month: row.end_month,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    goals: tables.goals.map((row) => ({
      id: row.id,
      name: row.name,
      target_amount: row.target_amount,
      deadline_on: row.deadline_on,
      funding_wallet_id: row.funding_wallet_id,
      manual_saved_amount: row.manual_saved_amount,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    parse_learning: tables.parse_learning.map((row) => ({
      token_key: row.token_key,
      kind: row.kind,
      category_id: row.category_id,
      hit_count: row.hit_count,
      updated_at: row.updated_at,
    })),
    settings: tables.settings.map((row) => ({
      key: row.key,
      value: row.value,
    })),
  };
}

/**
 * Produces canonical JSON of `tables` for SHA-256 checksum computation.
 */
export function canonicalizeBackupTables(tables: BackupTables): string {
  return JSON.stringify(normalizeTablesForCanonicalJson(tables));
}

/**
 * Computes the SHA-256 hex checksum of the canonicalized `tables` payload.
 */
export async function computeBackupTablesChecksum(
  tables: BackupTables,
  hashPort: HashPort = defaultHashPort,
): Promise<string> {
  const canonical = canonicalizeBackupTables(tables);
  return (await hashPort(canonical)).toLowerCase();
}

export function isAllowedBackupSettingKey(
  key: string,
): key is BackupAllowedSettingKey {
  if (key.startsWith('pref_')) return false;
  return (BACKUP_ALLOWED_SETTINGS_KEYS as readonly string[]).includes(key);
}

/**
 * Builds a complete, deterministic logical backup snapshot from SQLite inside a single transaction.
 * Performs zero network I/O.
 */
export async function buildSnapshot(
  db: Database,
  options?: {
    appVersion?: string;
    createdAt?: string;
    hashPort?: HashPort;
  },
): Promise<BackupSnapshot> {
  const appVersion = options?.appVersion ?? '0.1.0';
  const createdAt = options?.createdAt ?? new Date().toISOString();
  const hashPort = options?.hashPort ?? defaultHashPort;

  let schemaVersion: number = BACKUP_LATEST_SCHEMA_VERSION;
  let tables!: BackupTables;
  let walletBalances: Record<string, number> = {};

  await db.transaction(async (tx) => {
    const versionRow = await tx.getFirstAsync<{ user_version: number }>(
      'PRAGMA user_version',
    );
    schemaVersion =
      versionRow?.user_version && versionRow.user_version > 0
        ? versionRow.user_version
        : (MIGRATIONS.at(-1)?.version ?? BACKUP_LATEST_SCHEMA_VERSION);

    const wallets = await tx.getAllAsync<BackupWalletRow>(
      `SELECT id, name, kind, currency, initial_balance, is_archived, is_goal_funding, sort_order, created_at, updated_at
       FROM wallets
       ORDER BY id ASC`,
    );

    const categories = await tx.getAllAsync<BackupCategoryRow>(
      `SELECT id, system_key, parent_id, name, kind, is_fixed_cost, icon, color, is_archived, sort_order, created_at, updated_at
       FROM categories
       ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END ASC, id ASC`,
    );

    const debts = await tx.getAllAsync<BackupDebtRow>(
      `SELECT id, counterparty_label, direction, due_on, status, note, created_at, updated_at
       FROM debts
       ORDER BY id ASC`,
    );

    const recurring_rules = await tx.getAllAsync<BackupRecurringRuleRow>(
      `SELECT id, kind, amount, wallet_id, to_wallet_id, category_id, note, frequency, interval_count,
              day_of_week, day_of_month, start_on, end_on, last_generated_on, is_active, remind_before_days,
              created_at, updated_at
       FROM recurring_rules
       ORDER BY id ASC`,
    );

    // Explicitly omit note_search (derived) and raw_input (local-only).
    const transactions = await tx.getAllAsync<BackupTransactionRow>(
      `SELECT id, kind, amount, wallet_id, to_wallet_id, category_id, debt_id,
              occurred_on, occurred_at, note, source, recurring_rule_id,
              original_currency, original_amount_minor, booking_rate,
              created_at, updated_at
       FROM transactions
       ORDER BY id ASC`,
    );

    const recurring_skips = await tx.getAllAsync<BackupRecurringSkipRow>(
      `SELECT recurring_rule_id, occurred_on
       FROM recurring_skips
       ORDER BY recurring_rule_id ASC, occurred_on ASC`,
    );

    const budgets = await tx.getAllAsync<BackupBudgetRow>(
      `SELECT id, category_id, amount, warn_percent, start_month, end_month, is_active,
        COALESCE(period_type, 'monthly') AS period_type,
        start_date, end_date,
        created_at, updated_at
       FROM budgets
       ORDER BY id ASC`,
    );

    const goals = await tx.getAllAsync<BackupGoalRow>(
      `SELECT id, name, target_amount, deadline_on, funding_wallet_id, manual_saved_amount, status, created_at, updated_at
       FROM goals
       ORDER BY id ASC`,
    );

    const parse_learning = await tx.getAllAsync<BackupParseLearningRow>(
      `SELECT token_key, kind, category_id, hit_count, updated_at
       FROM parse_learning
       ORDER BY token_key ASC, kind ASC, COALESCE(category_id, '') ASC`,
    );

    const placeholders = BACKUP_ALLOWED_SETTINGS_KEYS.map(() => '?').join(', ');
    const rawSettings = await tx.getAllAsync<{ key: string; value: string }>(
      `SELECT key, value FROM settings WHERE key IN (${placeholders}) ORDER BY key ASC`,
      ...BACKUP_ALLOWED_SETTINGS_KEYS,
    );
    const settings: BackupSettingRow[] = rawSettings
      .filter((row): row is BackupSettingRow =>
        isAllowedBackupSettingKey(row.key),
      )
      .map((row) => ({ key: row.key, value: row.value }));

    const balanceRows = await tx.getAllAsync<{
      wallet_id: string;
      balance: number;
    }>('SELECT wallet_id, balance FROM v_wallet_balance ORDER BY wallet_id ASC');
    walletBalances = {};
    for (const row of balanceRows) {
      walletBalances[row.wallet_id] = row.balance;
    }

    tables = normalizeTablesForCanonicalJson({
      wallets,
      categories,
      debts,
      recurring_rules,
      transactions,
      recurring_skips,
      budgets,
      goals,
      parse_learning,
      settings,
    });
  });

  const counts: BackupCounts = {
    wallets: tables.wallets.length,
    categories: tables.categories.length,
    debts: tables.debts.length,
    recurring_rules: tables.recurring_rules.length,
    transactions: tables.transactions.length,
    recurring_skips: tables.recurring_skips.length,
    budgets: tables.budgets.length,
    goals: tables.goals.length,
    parse_learning: tables.parse_learning.length,
    settings: tables.settings.length,
  };

  const checksum = await computeBackupTablesChecksum(tables, hashPort);

  return BackupSnapshotSchema.parse({
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion,
    appVersion,
    createdAt,
    counts,
    walletBalances,
    checksum,
    tables,
  });
}
