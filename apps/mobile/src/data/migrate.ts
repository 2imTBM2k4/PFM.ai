import { INITIAL_SCHEMA } from './migrations/001_initial';
import { backfillNoteSearch } from './migrations/002_note_search';

type SqlValue = string | number | null;

export interface Queries {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: SqlValue[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: SqlValue[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
}

export interface Database extends Queries {
  transaction(task: (transaction: Queries) => Promise<void>): Promise<void>;
}

export interface Migration {
  version: number;
  description: string;
  sql: string;
  backfill?(db: Queries): Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial local finance schema',
    sql: INITIAL_SCHEMA,
  },
  {
    version: 2,
    description: 'Derived accent-insensitive note search',
    sql: "ALTER TABLE transactions ADD COLUMN note_search TEXT NOT NULL DEFAULT '';",
    backfill: backfillNoteSearch,
  },
  {
    version: 3,
    description: 'Group local chat messages into sessions',
    sql: "ALTER TABLE chat_messages ADD COLUMN session_id TEXT NOT NULL DEFAULT 'legacy'; CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at, id);",
  },
  {
    version: 4,
    description: 'Preserve original transaction currency and booking exchange rate',
    sql: "ALTER TABLE transactions ADD COLUMN original_currency TEXT NOT NULL DEFAULT 'VND' CHECK(original_currency IN ('VND','USD')); ALTER TABLE transactions ADD COLUMN original_amount_minor INTEGER; ALTER TABLE transactions ADD COLUMN booking_rate REAL; UPDATE transactions SET original_amount_minor=amount;",
  },
  {
    version: 5,
    description: 'Add period_type, start_date, and end_date to budgets',
    sql: "ALTER TABLE budgets ADD COLUMN period_type TEXT NOT NULL DEFAULT 'monthly' CHECK(period_type IN ('monthly','custom')); ALTER TABLE budgets ADD COLUMN start_date TEXT; ALTER TABLE budgets ADD COLUMN end_date TEXT;",
  },
  {
    version: 6,
    description: 'Store versioned local conversation state without backfilling sessions',
    sql: `CREATE TABLE conversation_states (
      session_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  },
  {
    version: 7,
    description: 'Allow debt and repayment transactions to optionally skip wallet balance adjustment',
    sql: `ALTER TABLE transactions ADD COLUMN affects_wallet_balance INTEGER NOT NULL DEFAULT 1 CHECK(affects_wallet_balance IN (0, 1));
DROP VIEW IF EXISTS v_wallet_balance;
CREATE VIEW v_wallet_balance AS
SELECT w.id AS wallet_id,
       w.initial_balance + COALESCE(SUM(CASE
         WHEN COALESCE(t.affects_wallet_balance, 1) = 0 THEN 0
         WHEN t.wallet_id = w.id AND t.kind IN ('income','debt_borrow','debt_repay_received') THEN t.amount
         WHEN t.wallet_id = w.id AND t.kind IN ('expense','debt_lend','debt_repay_paid','transfer') THEN -t.amount
         WHEN t.to_wallet_id = w.id AND t.kind = 'transfer' THEN t.amount
         ELSE 0 END), 0) AS balance
FROM wallets w
LEFT JOIN transactions t ON t.wallet_id = w.id OR t.to_wallet_id = w.id
GROUP BY w.id;`,
  },
];

export async function checkIntegrity(db: Queries) {
  const integrity = await db.getAllAsync<{ integrity_check: string }>(
    'PRAGMA integrity_check',
  );
  const foreignKeys = await db.getAllAsync('PRAGMA foreign_key_check');
  if (
    integrity.length !== 1 ||
    integrity[0].integrity_check !== 'ok' ||
    foreignKeys.length
  ) {
    throw new Error('DATABASE_INTEGRITY_FAILED');
  }
}

export async function migrate(db: Database, migrations = MIGRATIONS) {
  const current =
    (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))
      ?.user_version ?? 0;
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) throw new Error('SCHEMA_NEWER_THAN_APP');
  for (const migration of migrations.filter(
    ({ version }) => version > current,
  )) {
    await db.transaction(async (transaction) => {
      await transaction.execAsync(migration.sql);
      await migration.backfill?.(transaction);
      await transaction.runAsync(
        'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
        migration.version,
        migration.description,
        new Date().toISOString(),
      );
      await transaction.execAsync(`PRAGMA user_version = ${migration.version}`);
      await checkIntegrity(transaction);
    });
  }
  await checkIntegrity(db);
}
