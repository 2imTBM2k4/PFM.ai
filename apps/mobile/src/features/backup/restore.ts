import {
  BACKUP_ALLOWED_SETTINGS_KEYS,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_LATEST_SCHEMA_VERSION,
  BackupSnapshotSchema,
  type BackupCategoryRow,
  type BackupSnapshot,
  type BackupTables,
} from '@pfm/contracts';
import type { Database, Queries } from '@/data/migrate';
import { foldSearchText } from '@/data/search-text';
import {
  computeBackupTablesChecksum,
  defaultHashPort,
  isAllowedBackupSettingKey,
  type HashPort,
} from './snapshot';

const BATCH_SIZE = 200;

/**
 * Step-by-step in-memory upgrader for snapshots created by older schema versions (1..4).
 */
export function upgradeSnapshotTablesInMemory(
  tables: BackupTables,
  fromSchemaVersion: number,
  targetSchemaVersion: number = BACKUP_LATEST_SCHEMA_VERSION,
): BackupTables {
  if (fromSchemaVersion > targetSchemaVersion) {
    throw new Error('BACKUP_SCHEMA_NEWER_THAN_APP');
  }
  let current: BackupTables = tables;
  for (let v = fromSchemaVersion; v < targetSchemaVersion; v++) {
    if (v === 1 || v === 2) {
      // v1 -> v2 added derived transactions.note_search (recomputed during restore)
      // v2 -> v3 added chat_messages.session_id (chat_messages is excluded from backups)
      continue;
    }
    if (v === 3) {
      // v3 -> v4 added original_currency, original_amount_minor, booking_rate to transactions
      current = {
        ...current,
        transactions: current.transactions.map((row) => ({
          ...row,
          original_currency: row.original_currency ?? 'VND',
          original_amount_minor: row.original_amount_minor ?? row.amount,
          booking_rate: row.booking_rate ?? null,
        })),
      };
    }
  }
  // Ensure v4 defaults are populated on every transaction row
  return {
    ...current,
    transactions: current.transactions.map((row) => ({
      ...row,
      original_currency: row.original_currency ?? 'VND',
      original_amount_minor: row.original_amount_minor ?? row.amount,
      booking_rate: row.booking_rate ?? null,
    })),
  };
}

/**
 * Orders categories so parent categories (`parent_id === null`) always precede child categories.
 */
function orderCategoriesParentFirst(
  categories: BackupCategoryRow[],
): BackupCategoryRow[] {
  const parents = categories.filter((c) => c.parent_id === null);
  const children = categories.filter((c) => c.parent_id !== null);
  return [...parents, ...children];
}

/**
 * Validates a raw snapshot object against format, version, schemaVersion, Zod schema,
 * table row counts, and SHA-256 checksum before touching the database.
 */
export async function validateAndPrepareSnapshot(
  rawSnapshot: unknown,
  options?: {
    maxSchemaVersion?: number;
    hashPort?: HashPort;
  },
): Promise<{ snapshot: BackupSnapshot; upgradedTables: BackupTables }> {
  const maxSchemaVersion =
    options?.maxSchemaVersion ?? BACKUP_LATEST_SCHEMA_VERSION;
  const hashPort = options?.hashPort ?? defaultHashPort;

  if (!rawSnapshot || typeof rawSnapshot !== 'object') {
    throw new Error('BACKUP_INVALID_SNAPSHOT');
  }
  const record = rawSnapshot as Record<string, unknown>;
  if (record.format !== BACKUP_FORMAT) {
    throw new Error('BACKUP_INVALID_FORMAT');
  }
  if (
    typeof record.formatVersion !== 'number' ||
    record.formatVersion !== BACKUP_FORMAT_VERSION
  ) {
    throw new Error('BACKUP_FORMAT_VERSION_UNSUPPORTED');
  }
  if (
    typeof record.schemaVersion !== 'number' ||
    !Number.isInteger(record.schemaVersion) ||
    record.schemaVersion < 1
  ) {
    throw new Error('BACKUP_INVALID_SNAPSHOT');
  }
  if (record.schemaVersion > maxSchemaVersion) {
    throw new Error('BACKUP_SCHEMA_NEWER_THAN_APP');
  }

  const parsedResult = BackupSnapshotSchema.safeParse(rawSnapshot);
  if (!parsedResult.success) {
    throw new Error('BACKUP_INVALID_SNAPSHOT');
  }
  const snapshot = parsedResult.data;

  // Verify table row counts match the declared counts object
  const { counts, tables } = snapshot;
  if (
    counts.wallets !== tables.wallets.length ||
    counts.categories !== tables.categories.length ||
    counts.debts !== tables.debts.length ||
    counts.recurring_rules !== tables.recurring_rules.length ||
    counts.transactions !== tables.transactions.length ||
    counts.recurring_skips !== tables.recurring_skips.length ||
    counts.budgets !== tables.budgets.length ||
    counts.goals !== tables.goals.length ||
    counts.parse_learning !== tables.parse_learning.length ||
    counts.settings !== tables.settings.length
  ) {
    throw new Error('BACKUP_COUNTS_MISMATCH');
  }

  // Verify SHA-256 checksum over canonicalized tables before any DB write
  const actualChecksum = await computeBackupTablesChecksum(tables, hashPort);
  if (actualChecksum.toLowerCase() !== snapshot.checksum.toLowerCase()) {
    throw new Error('BACKUP_CHECKSUM_MISMATCH');
  }

  const upgradedTables = upgradeSnapshotTablesInMemory(
    tables,
    snapshot.schemaVersion,
    maxSchemaVersion,
  );

  return { snapshot, upgradedTables };
}

async function runBatchedInsert<T>(
  tx: Queries,
  rows: readonly T[],
  columnsSql: string,
  rowPlaceholders: string,
  mapRowParams: (row: T) => (string | number | null)[],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + BATCH_SIZE);
    const valuesSql = chunk.map(() => rowPlaceholders).join(', ');
    const params: (string | number | null)[] = [];
    for (const row of chunk) {
      params.push(...mapRowParams(row));
    }
    await tx.runAsync(`${columnsSql} VALUES ${valuesSql}`, ...params);
  }
}

/**
 * Atomically replaces all financial data in `db` with `rawSnapshot` inside a single SQLite transaction.
 * Recomputes `transactions.note_search` via `foldSearchText`, verifies `PRAGMA foreign_key_check`,
 * and checks every wallet balance in `v_wallet_balance` against `snapshot.walletBalances`.
 * Any failure rolls back the transaction leaving the existing database untouched.
 */
export async function applySnapshot(
  db: Database,
  rawSnapshot: unknown,
  options?: {
    maxSchemaVersion?: number;
    hashPort?: HashPort;
    beforeCommitHook?: (tx: Queries) => Promise<void>;
  },
): Promise<BackupSnapshot> {
  const { snapshot, upgradedTables } = await validateAndPrepareSnapshot(
    rawSnapshot,
    options,
  );

  await db.transaction(async (tx) => {
    // 1. Delete existing rows in reverse foreign-key dependency order
    await tx.runAsync('DELETE FROM budget_alerts_sent');
    await tx.runAsync('DELETE FROM parse_learning');
    await tx.runAsync('DELETE FROM goals');
    await tx.runAsync('DELETE FROM budgets');
    await tx.runAsync('DELETE FROM recurring_skips');
    await tx.runAsync('DELETE FROM transactions');
    await tx.runAsync('DELETE FROM recurring_rules');
    await tx.runAsync('DELETE FROM debts');
    await tx.runAsync('DELETE FROM categories WHERE parent_id IS NOT NULL');
    await tx.runAsync('DELETE FROM categories');
    await tx.runAsync('DELETE FROM wallets');

    const settingPlaceholders = BACKUP_ALLOWED_SETTINGS_KEYS.map(
      () => '?',
    ).join(', ');
    await tx.runAsync(
      `DELETE FROM settings WHERE key IN (${settingPlaceholders})`,
      ...BACKUP_ALLOWED_SETTINGS_KEYS,
    );

    // 2. Insert rows in foreign-key dependency order
    // 2a. wallets
    await runBatchedInsert(
      tx,
      upgradedTables.wallets,
      `INSERT INTO wallets (id, name, kind, currency, initial_balance, is_archived, is_goal_funding, sort_order, created_at, updated_at)`,
      '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      (w) => [
        w.id,
        w.name,
        w.kind,
        w.currency,
        w.initial_balance,
        w.is_archived,
        w.is_goal_funding,
        w.sort_order,
        w.created_at,
        w.updated_at,
      ],
    );

    // 2b. categories (parents before children)
    const orderedCategories = orderCategoriesParentFirst(
      upgradedTables.categories,
    );
    const parentCategories = orderedCategories.filter(
      (c) => c.parent_id === null,
    );
    const childCategories = orderedCategories.filter(
      (c) => c.parent_id !== null,
    );
    for (const group of [parentCategories, childCategories]) {
      await runBatchedInsert(
        tx,
        group,
        `INSERT INTO categories (id, system_key, parent_id, name, kind, is_fixed_cost, icon, color, is_archived, sort_order, created_at, updated_at)`,
        '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (c) => [
          c.id,
          c.system_key,
          c.parent_id,
          c.name,
          c.kind,
          c.is_fixed_cost,
          c.icon,
          c.color,
          c.is_archived,
          c.sort_order,
          c.created_at,
          c.updated_at,
        ],
      );
    }

    // 2c. debts
    await runBatchedInsert(
      tx,
      upgradedTables.debts,
      `INSERT INTO debts (id, counterparty_label, direction, due_on, status, note, created_at, updated_at)`,
      '(?, ?, ?, ?, ?, ?, ?, ?)',
      (d) => [
        d.id,
        d.counterparty_label,
        d.direction,
        d.due_on,
        d.status,
        d.note,
        d.created_at,
        d.updated_at,
      ],
    );

    // 2d. recurring_rules
    await runBatchedInsert(
      tx,
      upgradedTables.recurring_rules,
      `INSERT INTO recurring_rules (id, kind, amount, wallet_id, to_wallet_id, category_id, note, frequency, interval_count, day_of_week, day_of_month, start_on, end_on, last_generated_on, is_active, remind_before_days, created_at, updated_at)`,
      '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      (r) => [
        r.id,
        r.kind,
        r.amount,
        r.wallet_id,
        r.to_wallet_id,
        r.category_id,
        r.note,
        r.frequency,
        r.interval_count,
        r.day_of_week,
        r.day_of_month,
        r.start_on,
        r.end_on,
        r.last_generated_on,
        r.is_active,
        r.remind_before_days,
        r.created_at,
        r.updated_at,
      ],
    );

    // 2e. transactions (recomputing note_search and keeping raw_input = NULL)
    await runBatchedInsert(
      tx,
      upgradedTables.transactions,
      `INSERT INTO transactions (id, kind, amount, wallet_id, to_wallet_id, category_id, debt_id, occurred_on, occurred_at, note, note_search, source, recurring_rule_id, raw_input, original_currency, original_amount_minor, booking_rate, created_at, updated_at)`,
      '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
      (t) => [
        t.id,
        t.kind,
        t.amount,
        t.wallet_id,
        t.to_wallet_id,
        t.category_id,
        t.debt_id,
        t.occurred_on,
        t.occurred_at,
        t.note,
        foldSearchText(t.note ?? ''),
        t.source,
        t.recurring_rule_id,
        t.original_currency ?? 'VND',
        t.original_amount_minor ?? t.amount,
        t.booking_rate ?? null,
        t.created_at,
        t.updated_at,
      ],
    );

    // 2f. recurring_skips
    await runBatchedInsert(
      tx,
      upgradedTables.recurring_skips,
      `INSERT INTO recurring_skips (recurring_rule_id, occurred_on)`,
      '(?, ?)',
      (s) => [s.recurring_rule_id, s.occurred_on],
    );

    // 2g. budgets
    await runBatchedInsert(
      tx,
      upgradedTables.budgets,
      `INSERT INTO budgets (id, category_id, amount, warn_percent, start_month, end_month, is_active, created_at, updated_at)`,
      '(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      (b) => [
        b.id,
        b.category_id,
        b.amount,
        b.warn_percent,
        b.start_month,
        b.end_month,
        b.is_active,
        b.created_at,
        b.updated_at,
      ],
    );

    // 2h. goals
    await runBatchedInsert(
      tx,
      upgradedTables.goals,
      `INSERT INTO goals (id, name, target_amount, deadline_on, funding_wallet_id, manual_saved_amount, status, created_at, updated_at)`,
      '(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      (g) => [
        g.id,
        g.name,
        g.target_amount,
        g.deadline_on,
        g.funding_wallet_id,
        g.manual_saved_amount,
        g.status,
        g.created_at,
        g.updated_at,
      ],
    );

    // 2i. parse_learning
    await runBatchedInsert(
      tx,
      upgradedTables.parse_learning,
      `INSERT INTO parse_learning (token_key, kind, category_id, hit_count, updated_at)`,
      '(?, ?, ?, ?, ?)',
      (p) => [p.token_key, p.kind, p.category_id, p.hit_count, p.updated_at],
    );

    // 2j. settings (strict allowlist; never restore pref_* or pref_seed_enabled)
    for (const s of upgradedTables.settings) {
      if (!isAllowedBackupSettingKey(s.key)) {
        throw new Error('BACKUP_FORBIDDEN_SETTING_KEY');
      }
      await tx.runAsync(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        s.key,
        s.value,
      );
    }

    if (options?.beforeCommitHook) {
      await options.beforeCommitHook(tx);
    }

    // 3. Verify foreign key integrity
    const fkIssues = await tx.getAllAsync('PRAGMA foreign_key_check');
    if (fkIssues.length > 0) {
      throw new Error('BACKUP_FOREIGN_KEY_FAILED');
    }

    // 4. Verify v_wallet_balance matches snapshot.walletBalances
    const balanceRows = await tx.getAllAsync<{
      wallet_id: string;
      balance: number;
    }>('SELECT wallet_id, balance FROM v_wallet_balance');
    const expectedWalletIds = Object.keys(snapshot.walletBalances);
    if (balanceRows.length !== expectedWalletIds.length) {
      throw new Error('BACKUP_WALLET_BALANCE_MISMATCH');
    }
    for (const row of balanceRows) {
      if (
        !Object.prototype.hasOwnProperty.call(
          snapshot.walletBalances,
          row.wallet_id,
        ) ||
        snapshot.walletBalances[row.wallet_id] !== row.balance
      ) {
        throw new Error('BACKUP_WALLET_BALANCE_MISMATCH');
      }
    }
  });

  return snapshot;
}
