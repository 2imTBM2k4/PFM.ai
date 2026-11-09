import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_LATEST_SCHEMA_VERSION,
  type BackupSnapshot,
} from '@pfm/contracts';
import { migrate, type Database, type Queries } from '@/data/migrate';
import { foldSearchText } from '@/data/search-text';
import { DEFAULT_WALLET_ID, seed } from '@/data/seed';
import { listTransactions } from '@/data/transactions';
import {
  applySnapshot,
  upgradeSnapshotTablesInMemory,
  validateAndPrepareSnapshot,
} from './restore';
import { buildSnapshot, computeBackupTablesChecksum } from './snapshot';

function wrapSqlite(sqlite: DatabaseSync): Database {
  sqlite.exec('PRAGMA foreign_keys = ON');
  const queries: Queries = {
    execAsync: async (source) => {
      sqlite.exec(source);
    },
    runAsync: async (source, ...params) => {
      const result = sqlite
        .prepare(source)
        .run(...(params as (string | number | null)[]));
      return { changes: Number(result.changes) };
    },
    getFirstAsync: async <T>(source: string, ...params: unknown[]) =>
      ((sqlite
        .prepare(source)
        .get(...(params as (string | number | null)[])) as T | undefined) ??
        null) as T | null,
    getAllAsync: async <T>(source: string, ...params: unknown[]) =>
      sqlite
        .prepare(source)
        .all(...(params as (string | number | null)[])) as T[],
  };
  return {
    ...queries,
    transaction: async (task) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        await task(queries);
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

/**
 * Independently computes expected wallet balances from wallets + transactions without using SQLite views.
 */
function computeExpectedWalletBalancesIndependently(
  wallets: readonly { id: string; initial_balance: number }[],
  transactions: readonly {
    kind: string;
    amount: number;
    wallet_id: string;
    to_wallet_id: string | null;
  }[],
): Record<string, number> {
  const balances: Record<string, number> = {};
  for (const w of wallets) {
    let total = w.initial_balance;
    for (const tx of transactions) {
      if (
        tx.wallet_id === w.id &&
        (tx.kind === 'income' ||
          tx.kind === 'debt_borrow' ||
          tx.kind === 'debt_repay_received')
      ) {
        total += tx.amount;
      } else if (
        tx.wallet_id === w.id &&
        (tx.kind === 'expense' ||
          tx.kind === 'debt_lend' ||
          tx.kind === 'debt_repay_paid' ||
          tx.kind === 'transfer')
      ) {
        total -= tx.amount;
      } else if (tx.to_wallet_id === w.id && tx.kind === 'transfer') {
        total += tx.amount;
      }
    }
    balances[w.id] = total;
  }
  return balances;
}

const CAT_FOOD_ID = '00000000-0000-4000-8001-000000000001';
const CAT_HOUSING_ID = '00000000-0000-4000-8001-000000000009';
const CAT_SALARY_ID = '00000000-0000-4000-8001-000000000020';
const CAT_INCOME_OTHER_ID = '00000000-0000-4000-8001-000000000025';

async function populateComprehensiveDatabase(db: Database): Promise<void> {
  const now = '2026-06-15T10:00:00.000Z';
  await seed(db, now);

  // Additional wallets: bank, credit_card (negative initial_balance), savings (goal funding), archived ewallet
  await db.runAsync(
    `INSERT INTO wallets (id, name, kind, currency, initial_balance, is_archived, is_goal_funding, sort_order, created_at, updated_at)
     VALUES
       ('wallet-bank', 'Techcombank 🏦', 'bank', 'VND', 25000000, 0, 0, 1, ?, ?),
       ('wallet-credit', 'Thẻ tín dụng VIB', 'credit_card', 'VND', -4500000, 0, 0, 2, ?, ?),
       ('wallet-savings', 'Quỹ tiết kiệm mua nhà', 'savings', 'VND', 50000000, 0, 1, 3, ?, ?),
       ('wallet-archived', 'Ví MoMo cũ', 'ewallet', 'VND', 120000, 1, 0, 4, ?, ?)`,
    now,
    now,
    now,
    now,
    now,
    now,
    now,
    now,
  );

  // Custom parent category, custom child category, and archived category
  await db.runAsync(
    `INSERT INTO categories (id, system_key, parent_id, name, kind, is_fixed_cost, icon, color, is_archived, sort_order, created_at, updated_at)
     VALUES
       ('cat-custom-parent', NULL, NULL, 'Thú cưng 🐶', 'expense', 0, 'paw', '#F59E0B', 0, 20, ?, ?),
       ('cat-custom-child', NULL, 'cat-custom-parent', 'Thức ăn cho mèo 🐱', 'expense', 0, 'food-drumstick', '#F59E0B', 0, 21, ?, ?),
       ('cat-archived', NULL, NULL, 'Chi phí cũ đã ẩn', 'expense', 0, 'archive', '#6B7280', 1, 22, ?, ?)`,
    now,
    now,
    now,
    now,
    now,
    now,
  );

  // Debts: borrowed and lent (with partial repayments)
  await db.runAsync(
    `INSERT INTO debts (id, counterparty_label, direction, due_on, status, note, created_at, updated_at)
     VALUES
       ('debt-borrowed-1', 'Anh Tuấn (bạn đại học)', 'borrowed', '2026-12-31', 'open', 'Vay tiền sửa xe máy 🛠️', ?, ?),
       ('debt-lent-1', 'Chị Hương đồng nghiệp', 'lent', '2026-08-15', 'open', 'Cho mượn tiền đặt cọc', ?, ?)`,
    now,
    now,
    now,
    now,
  );

  // Recurring rules: monthly expense and weekly transfer
  await db.runAsync(
    `INSERT INTO recurring_rules (id, kind, amount, wallet_id, to_wallet_id, category_id, note, frequency, interval_count, day_of_week, day_of_month, start_on, end_on, last_generated_on, is_active, remind_before_days, created_at, updated_at)
     VALUES
       ('rec-rent', 'expense', 6500000, 'wallet-bank', NULL, '${CAT_HOUSING_ID}', 'Tiền thuê nhà quận 3', 'monthly', 1, NULL, 5, '2026-01-05', NULL, '2026-06-05', 1, 2, ?, ?),
       ('rec-save', 'transfer', 2000000, 'wallet-bank', 'wallet-savings', NULL, 'Tự động trích quỹ', 'weekly', 1, 1, NULL, '2026-01-01', '2026-12-31', '2026-06-08', 1, 0, ?, ?)`,
    now,
    now,
    now,
    now,
  );

  // Recurring skips
  await db.runAsync(
    `INSERT INTO recurring_skips (recurring_rule_id, occurred_on)
     VALUES ('rec-rent', '2026-05-05'), ('rec-save', '2026-06-01')`,
  );

  // Transactions: expense, income, transfer, 4 debt kinds, recurring generated, USD converted, near 1e11 amount
  const txRows: {
    id: string;
    kind: string;
    amount: number;
    wallet_id: string;
    to_wallet_id: string | null;
    category_id: string | null;
    debt_id: string | null;
    occurred_on: string;
    occurred_at: string;
    note: string | null;
    source: string;
    recurring_rule_id: string | null;
    raw_input: string | null;
    original_currency: 'VND' | 'USD';
    original_amount_minor: number;
    booking_rate: number | null;
  }[] = [
    {
      id: 'tx-01-expense',
      kind: 'expense',
      amount: 55000,
      wallet_id: DEFAULT_WALLET_ID,
      to_wallet_id: null,
      category_id: CAT_FOOD_ID,
      debt_id: null,
      occurred_on: '2026-06-01',
      occurred_at: '2026-06-01T08:00:00+07:00',
      note: 'Phở bò tái lăn & trà đá 🍜',
      source: 'parsed',
      recurring_rule_id: null,
      raw_input: 'pho bo tai lan 55k SECRET_RAW_INPUT_DO_NOT_EXPORT',
      original_currency: 'VND',
      original_amount_minor: 55000,
      booking_rate: null,
    },
    {
      id: 'tx-02-income',
      kind: 'income',
      amount: 35000000,
      wallet_id: 'wallet-bank',
      to_wallet_id: null,
      category_id: CAT_SALARY_ID,
      debt_id: null,
      occurred_on: '2026-06-02',
      occurred_at: '2026-06-02T09:30:00+07:00',
      note: 'Lương tháng 6 + thưởng dự án 🎉',
      source: 'manual',
      recurring_rule_id: null,
      raw_input: null,
      original_currency: 'VND',
      original_amount_minor: 35000000,
      booking_rate: null,
    },
    {
      id: 'tx-03-transfer',
      kind: 'transfer',
      amount: 5000000,
      wallet_id: 'wallet-bank',
      to_wallet_id: 'wallet-savings',
      category_id: null,
      debt_id: null,
      occurred_on: '2026-06-03',
      occurred_at: '2026-06-03T10:00:00+07:00',
      note: 'Chuyển tiền tiết kiệm định kỳ',
      source: 'manual',
      recurring_rule_id: null,
      raw_input: null,
      original_currency: 'VND',
      original_amount_minor: 5000000,
      booking_rate: null,
    },
    {
      id: 'tx-04-debt-borrow',
      kind: 'debt_borrow',
      amount: 3000000,
      wallet_id: DEFAULT_WALLET_ID,
      to_wallet_id: null,
      category_id: null,
      debt_id: 'debt-borrowed-1',
      occurred_on: '2026-06-04',
      occurred_at: '2026-06-04T11:00:00+07:00',
      note: 'Nhận tiền vay từ Anh Tuấn',
      source: 'manual',
      recurring_rule_id: null,
      raw_input: null,
      original_currency: 'VND',
      original_amount_minor: 3000000,
      booking_rate: null,
    },
    {
      id: 'tx-05-debt-repay-paid',
      kind: 'debt_repay_paid',
      amount: 1000000,
      wallet_id: 'wallet-bank',
      to_wallet_id: null,
      category_id: null,
      debt_id: 'debt-borrowed-1',
      occurred_on: '2026-06-10',
      occurred_at: '2026-06-10T14:00:00+07:00',
      note: 'Trả một phần nợ cho Anh Tuấn',
      source: 'manual',
      recurring_rule_id: null,
      raw_input: null,
      original_currency: 'VND',
      original_amount_minor: 1000000,
      booking_rate: null,
    },
    {
      id: 'tx-06-debt-lend',
      kind: 'debt_lend',
      amount: 4000000,
      wallet_id: 'wallet-bank',
      to_wallet_id: null,
      category_id: null,
      debt_id: 'debt-lent-1',
      occurred_on: '2026-06-05',
      occurred_at: '2026-06-05T15:00:00+07:00',
      note: 'Chuyển khoản cho Chị Hương mượn',
      source: 'manual',
      recurring_rule_id: null,
      raw_input: null,
      original_currency: 'VND',
      original_amount_minor: 4000000,
      booking_rate: null,
    },
    {
      id: 'tx-07-debt-repay-received',
      kind: 'debt_repay_received',
      amount: 1500000,
      wallet_id: 'wallet-bank',
      to_wallet_id: null,
      category_id: null,
      debt_id: 'debt-lent-1',
      occurred_on: '2026-06-12',
      occurred_at: '2026-06-12T16:00:00+07:00',
      note: 'Chị Hương trả đợt 1',
      source: 'manual',
      recurring_rule_id: null,
      raw_input: null,
      original_currency: 'VND',
      original_amount_minor: 1500000,
      booking_rate: null,
    },
    {
      id: 'tx-08-recurring-instance',
      kind: 'expense',
      amount: 6500000,
      wallet_id: 'wallet-bank',
      to_wallet_id: null,
      category_id: CAT_HOUSING_ID,
      debt_id: null,
      occurred_on: '2026-06-05',
      occurred_at: '2026-06-05T07:00:00+07:00',
      note: 'Tiền thuê nhà quận 3',
      source: 'recurring',
      recurring_rule_id: 'rec-rent',
      raw_input: null,
      original_currency: 'VND',
      original_amount_minor: 6500000,
      booking_rate: null,
    },
    {
      id: 'tx-09-usd-booking',
      kind: 'expense',
      amount: 508000,
      wallet_id: 'wallet-credit',
      to_wallet_id: null,
      category_id: 'cat-custom-child',
      debt_id: null,
      occurred_on: '2026-06-14',
      occurred_at: '2026-06-14T18:00:00+07:00',
      note: 'Mua pate nhập khẩu cho mèo 🐾',
      source: 'manual',
      recurring_rule_id: null,
      raw_input: null,
      original_currency: 'USD',
      original_amount_minor: 1999,
      booking_rate: 254.127,
    },
    {
      id: 'tx-10-large-amount',
      kind: 'income',
      amount: 99999999999,
      wallet_id: 'wallet-savings',
      to_wallet_id: null,
      category_id: CAT_INCOME_OTHER_ID,
      debt_id: null,
      occurred_on: '2026-06-15',
      occurred_at: '2026-06-15T09:00:00+07:00',
      note: 'Giao dịch kiểm thử số nguyên lớn gần 1e11',
      source: 'manual',
      recurring_rule_id: null,
      raw_input: null,
      original_currency: 'VND',
      original_amount_minor: 99999999999,
      booking_rate: null,
    },
  ];

  for (const t of txRows) {
    await db.runAsync(
      `INSERT INTO transactions (
        id, kind, amount, wallet_id, to_wallet_id, category_id, debt_id,
        occurred_on, occurred_at, note, note_search, source, recurring_rule_id,
        raw_input, original_currency, original_amount_minor, booking_rate, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      t.raw_input,
      t.original_currency,
      t.original_amount_minor,
      t.booking_rate,
      now,
      now,
    );
  }

  // Budgets: overall + category budget
  await db.runAsync(
    `INSERT INTO budgets (id, category_id, amount, warn_percent, start_month, end_month, is_active, created_at, updated_at)
     VALUES
       ('budget-overall', NULL, 15000000, 80, '2026-06', NULL, 1, ?, ?),
       ('budget-food', '${CAT_FOOD_ID}', 4000000, 75, '2026-06', '2026-12', 1, ?, ?)`,
    now,
    now,
    now,
    now,
  );

  // Goals: wallet-linked + manual saved
  await db.runAsync(
    `INSERT INTO goals (id, name, target_amount, deadline_on, funding_wallet_id, manual_saved_amount, status, created_at, updated_at)
     VALUES
       ('goal-house', 'Mua căn hộ 🏡', 1000000000, '2028-12-31', 'wallet-savings', 0, 'active', ?, ?),
       ('goal-laptop', 'Đổi MacBook mới 💻', 45000000, '2026-11-01', NULL, 18500000, 'active', ?, ?)`,
    now,
    now,
    now,
    now,
  );

  // Parse learning
  await db.runAsync(
    `INSERT INTO parse_learning (token_key, kind, category_id, hit_count, updated_at)
     VALUES
       ('pho bo', 'expense', '${CAT_FOOD_ID}', 5, ?),
       ('pate meo', 'expense', 'cat-custom-child', 2, ?)`,
    now,
    now,
  );

  // Settings: allowed keys + excluded device/sensitive keys
  await db.runAsync(
    `INSERT INTO settings (key, value)
     VALUES
       ('onboarding_complete', 'true'),
       ('budget_banner_dismissed_v1', '["budget-overall:2026-06:warning"]'),
       ('pref_seed_enabled', '1'),
       ('pref_language', 'vi'),
       ('ai_chat_replies_v1', '{"1":{"status":"positive"}}'),
       ('backup_state_v1', '{"enabled":true,"accountEmail":"secret@example.com"}')`,
  );

  // Local-only tables that must NOT be exported
  await db.runAsync(
    `INSERT INTO chat_messages (id, text, created_at, session_id)
     VALUES ('chat-1', 'Tin nhắn riêng tư với AI không được xuất lên Drive', ?, 'session-1')`,
    now,
  );
  await db.runAsync(
    `INSERT INTO ai_usage_local (usage_date, used) VALUES ('2026-06-15', 3)`,
  );
  await db.runAsync(
    `INSERT INTO budget_alerts_sent (budget_id, month, threshold_percent, sent_at)
     VALUES ('budget-overall', '2026-06', 80, ?)`,
    now,
  );
}

describe('Snapshot & Restore (B1 & B2)', () => {
  let sourceSqlite: DatabaseSync;
  let sourceDb: Database;
  let targetSqlite: DatabaseSync;
  let targetDb: Database;

  beforeEach(async () => {
    sourceSqlite = new DatabaseSync(':memory:');
    sourceDb = wrapSqlite(sourceSqlite);
    await migrate(sourceDb);

    targetSqlite = new DatabaseSync(':memory:');
    targetDb = wrapSqlite(targetSqlite);
    await migrate(targetDb);
  });

  afterEach(() => {
    sourceSqlite.close();
    targetSqlite.close();
  });

  it('1. Full DB roundtrip preserves all 10 tables row-by-row, wallet balances, and Vietnamese/emoji/1e11 precision', async () => {
    await populateComprehensiveDatabase(sourceDb);

    const snapshot = await buildSnapshot(sourceDb, {
      appVersion: '0.1.0',
      createdAt: '2026-06-15T12:00:00.000Z',
    });

    expect(snapshot.format).toBe(BACKUP_FORMAT);
    expect(snapshot.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(snapshot.schemaVersion).toBe(BACKUP_LATEST_SCHEMA_VERSION);
    expect(snapshot.counts.wallets).toBe(5);
    expect(snapshot.counts.transactions).toBe(10);
    expect(snapshot.counts.debts).toBe(2);
    expect(snapshot.counts.recurring_rules).toBe(2);
    expect(snapshot.counts.recurring_skips).toBe(2);
    expect(snapshot.counts.budgets).toBe(2);
    expect(snapshot.counts.goals).toBe(2);
    expect(snapshot.counts.parse_learning).toBe(2);
    expect(snapshot.counts.settings).toBe(2);

    // Verify independent balance calculation matches snapshot.walletBalances
    const independentBalances = computeExpectedWalletBalancesIndependently(
      snapshot.tables.wallets,
      snapshot.tables.transactions,
    );
    expect(snapshot.walletBalances).toEqual(independentBalances);

    // Serialize to JSON and parse back (simulating upload/download from Google Drive)
    const serialized = JSON.stringify(snapshot);
    const parsedFromWire = JSON.parse(serialized) as unknown;

    // Apply to fresh target DB
    await applySnapshot(targetDb, parsedFromWire);

    // Re-export from targetDb and verify deterministic equality
    const restoredSnapshot = await buildSnapshot(targetDb, {
      appVersion: '0.1.0',
      createdAt: '2026-06-15T12:00:00.000Z',
    });

    expect(restoredSnapshot.checksum).toBe(snapshot.checksum);
    expect(restoredSnapshot.tables).toEqual(snapshot.tables);
    expect(restoredSnapshot.walletBalances).toEqual(independentBalances);

    // Verify large integer precision (99_999_999_999) and negative initial balance (-4_500_000)
    const largeTx = restoredSnapshot.tables.transactions.find(
      (t) => t.id === 'tx-10-large-amount',
    );
    expect(largeTx?.amount).toBe(99999999999);
    const creditWallet = restoredSnapshot.tables.wallets.find(
      (w) => w.id === 'wallet-credit',
    );
    expect(creditWallet?.initial_balance).toBe(-4500000);
    expect(restoredSnapshot.walletBalances['wallet-credit']).toBe(
      -4500000 - 508000,
    );
  });

  it('2. Empty DB (freshly onboarded) exports and restores cleanly', async () => {
    const now = '2026-06-15T10:00:00.000Z';
    await seed(sourceDb, now);
    await sourceDb.runAsync(
      "INSERT INTO settings (key, value) VALUES ('onboarding_complete', 'true')",
    );

    const snapshot = await buildSnapshot(sourceDb, { createdAt: now });
    expect(snapshot.counts.transactions).toBe(0);
    expect(snapshot.counts.wallets).toBe(1);

    await applySnapshot(targetDb, JSON.parse(JSON.stringify(snapshot)));
    const restored = await buildSnapshot(targetDb, { createdAt: now });
    expect(restored.checksum).toBe(snapshot.checksum);
    expect(restored.tables).toEqual(snapshot.tables);
  });

  it('3. Accent-insensitive search (note_search) works after restore', async () => {
    await populateComprehensiveDatabase(sourceDb);
    const snapshot = await buildSnapshot(sourceDb);

    await applySnapshot(targetDb, JSON.parse(JSON.stringify(snapshot)));

    // Search without Vietnamese diacritics for "Phở bò tái lăn" and "quận 3"
    const phoResults = await listTransactions(targetDb, undefined, {
      text: 'pho bo',
    });
    expect(phoResults.map((r) => r.id)).toEqual(['tx-01-expense']);

    const rentResults = await listTransactions(targetDb, undefined, {
      text: 'thue nha quan 3',
    });
    expect(rentResults.map((r) => r.id)).toEqual(['tx-08-recurring-instance']);
  });

  it('4. Tampered checksum (1 char changed) is rejected before touching the target DB', async () => {
    await populateComprehensiveDatabase(sourceDb);
    await populateComprehensiveDatabase(targetDb);

    const beforeTargetSnapshot = await buildSnapshot(targetDb, {
      createdAt: '2026-06-15T00:00:00.000Z',
    });

    const snapshot = await buildSnapshot(sourceDb);
    const tampered: BackupSnapshot = {
      ...snapshot,
      checksum:
        (snapshot.checksum[0] === 'a' ? 'b' : 'a') +
        snapshot.checksum.slice(1),
    };

    await expect(applySnapshot(targetDb, tampered)).rejects.toThrow(
      'BACKUP_CHECKSUM_MISMATCH',
    );

    const afterTargetSnapshot = await buildSnapshot(targetDb, {
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    expect(afterTargetSnapshot.checksum).toBe(beforeTargetSnapshot.checksum);
  });

  it('5. Rejects schemaVersion newer than app, unsupported formatVersion, counts mismatch, and invalid Zod shapes', async () => {
    await populateComprehensiveDatabase(sourceDb);
    const snapshot = await buildSnapshot(sourceDb);

    await expect(
      validateAndPrepareSnapshot({ ...snapshot, schemaVersion: 99 }),
    ).rejects.toThrow('BACKUP_SCHEMA_NEWER_THAN_APP');

    await expect(
      validateAndPrepareSnapshot({ ...snapshot, format: 'wrong-format' }),
    ).rejects.toThrow('BACKUP_INVALID_FORMAT');

    await expect(
      validateAndPrepareSnapshot({ ...snapshot, formatVersion: 2 }),
    ).rejects.toThrow('BACKUP_FORMAT_VERSION_UNSUPPORTED');

    await expect(
      validateAndPrepareSnapshot({
        ...snapshot,
        counts: { ...snapshot.counts, wallets: 999 },
      }),
    ).rejects.toThrow('BACKUP_COUNTS_MISMATCH');

    const missingTableSnapshot = {
      ...snapshot,
      tables: { ...snapshot.tables, wallets: 'not-an-array' },
    };
    await expect(
      validateAndPrepareSnapshot(missingTableSnapshot),
    ).rejects.toThrow('BACKUP_INVALID_SNAPSHOT');
  });

  it('6. Rolls back atomically when an error occurs mid-restore, leaving existing data intact', async () => {
    await populateComprehensiveDatabase(sourceDb);
    await populateComprehensiveDatabase(targetDb);

    // Add a unique marker wallet in targetDb so we can verify targetDb is untouched on rollback
    await targetDb.runAsync(
      `INSERT INTO wallets (id, name, kind, currency, initial_balance, is_archived, is_goal_funding, sort_order, created_at, updated_at)
       VALUES ('wallet-local-survivor', 'Ví phải còn nguyên khi rollback', 'cash', 'VND', 777000, 0, 0, 99, '2026-06-15T00:00:00.000Z', '2026-06-15T00:00:00.000Z')`,
    );
    const beforeRollback = await buildSnapshot(targetDb, {
      createdAt: '2026-06-15T00:00:00.000Z',
    });

    const incomingSnapshot = await buildSnapshot(sourceDb);

    // Case 6a: simulated error via beforeCommitHook after all DELETEs and INSERTs have run
    await expect(
      applySnapshot(targetDb, incomingSnapshot, {
        beforeCommitHook: async () => {
          throw new Error('SIMULATED_MID_RESTORE_CRASH');
        },
      }),
    ).rejects.toThrow('SIMULATED_MID_RESTORE_CRASH');

    const afterHookRollback = await buildSnapshot(targetDb, {
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    expect(afterHookRollback.checksum).toBe(beforeRollback.checksum);

    // Case 6b: wallet balance mismatch at step 4 rolls back the entire transaction
    const badBalanceSnapshot: BackupSnapshot = {
      ...incomingSnapshot,
      walletBalances: {
        ...incomingSnapshot.walletBalances,
        [DEFAULT_WALLET_ID]: 123456789,
      },
    };
    await expect(
      applySnapshot(targetDb, badBalanceSnapshot),
    ).rejects.toThrow('BACKUP_WALLET_BALANCE_MISMATCH');

    const afterBalanceRollback = await buildSnapshot(targetDb, {
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    expect(afterBalanceRollback.checksum).toBe(beforeRollback.checksum);
  });

  it('7. Restoring over a populated DB completely replaces old financial data while preserving local device settings', async () => {
    await populateComprehensiveDatabase(sourceDb);
    const snapshot = await buildSnapshot(sourceDb);

    // Target DB has completely different wallets, transactions, and local settings
    await seed(targetDb, '2026-01-01T00:00:00.000Z');
    await targetDb.runAsync(
      `INSERT INTO wallets (id, name, kind, currency, initial_balance, is_archived, is_goal_funding, sort_order, created_at, updated_at)
       VALUES ('wallet-old-only', 'Ví cũ sẽ bị thay thế', 'cash', 'VND', 500000, 0, 0, 5, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    await targetDb.runAsync(
      `INSERT INTO settings (key, value) VALUES ('pref_language', 'en'), ('backup_state_v1', '{"enabled":true}')`,
    );

    await applySnapshot(targetDb, snapshot);

    const oldWallet = await targetDb.getFirstAsync(
      "SELECT id FROM wallets WHERE id = 'wallet-old-only'",
    );
    expect(oldWallet).toBeNull();

    // Local device settings not in BACKUP_ALLOWED_SETTINGS_KEYS remain intact on target device
    const prefLang = await targetDb.getFirstAsync<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'pref_language'",
    );
    expect(prefLang?.value).toBe('en');
  });

  it('8. Running seed() after restore is idempotent and does not duplicate system categories', async () => {
    await populateComprehensiveDatabase(sourceDb);
    const snapshot = await buildSnapshot(sourceDb);

    await applySnapshot(targetDb, snapshot);
    const countBeforeSeed = await targetDb.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM categories',
    );

    await seed(targetDb, '2026-06-16T00:00:00.000Z');

    const countAfterSeed = await targetDb.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM categories',
    );
    expect(countAfterSeed?.c).toBe(countBeforeSeed?.c);
  });

  it('9. Upgrades schemaVersion 1..3 snapshots in memory before inserting into v4 DB', async () => {
    await populateComprehensiveDatabase(sourceDb);
    const v4Snapshot = await buildSnapshot(sourceDb);

    // Simulate a v2 snapshot where transactions lack original_currency, original_amount_minor, booking_rate
    const v2Tables = {
      ...v4Snapshot.tables,
      transactions: v4Snapshot.tables.transactions.map((t) => {
        const copy = { ...t };
        delete copy.original_currency;
        delete copy.original_amount_minor;
        delete copy.booking_rate;
        return copy;
      }),
    };
    const v2Checksum = await computeBackupTablesChecksum(v2Tables);
    const v2Snapshot: BackupSnapshot = {
      ...v4Snapshot,
      schemaVersion: 2,
      checksum: v2Checksum,
      tables: v2Tables,
    };

    const upgraded = upgradeSnapshotTablesInMemory(v2Tables, 2, 4);
    expect(
      upgraded.transactions.every(
        (t) =>
          t.original_currency === 'VND' &&
          t.original_amount_minor === t.amount &&
          t.booking_rate === null,
      ),
    ).toBe(true);

    await applySnapshot(targetDb, v2Snapshot);
    const restoredRows = await targetDb.getAllAsync<{
      original_currency: string;
      original_amount_minor: number;
      amount: number;
    }>('SELECT original_currency, original_amount_minor, amount FROM transactions');
    expect(restoredRows.length).toBe(v4Snapshot.counts.transactions);
    expect(
      restoredRows.every(
        (r) =>
          r.original_currency === 'VND' && r.original_amount_minor === r.amount,
      ),
    ).toBe(true);
  });

  it('10. Serialized snapshot JSON excludes raw_input, note_search, chat_messages, ai_chat_replies_v1, and pref_seed_enabled', async () => {
    await populateComprehensiveDatabase(sourceDb);
    const snapshot = await buildSnapshot(sourceDb);
    const json = JSON.stringify(snapshot);

    expect(json).not.toContain('raw_input');
    expect(json).not.toContain('SECRET_RAW_INPUT_DO_NOT_EXPORT');
    expect(json).not.toContain('note_search');
    expect(json).not.toContain('chat_messages');
    expect(json).not.toContain('Tin nhắn riêng tư với AI');
    expect(json).not.toContain('ai_chat_replies_v1');
    expect(json).not.toContain('pref_seed_enabled');
    expect(json).not.toContain('pref_language');
    expect(json).not.toContain('backup_state_v1');
    expect(json).not.toContain('secret@example.com');
  });

  it('11. Performance benchmark: exports and restores 20,000 transactions within budget', async () => {
    const now = '2026-06-15T10:00:00.000Z';
    await seed(sourceDb, now);

    const txCount = 20_000;
    await sourceDb.transaction(async (tx) => {
      const batchSize = 250;
      for (let offset = 0; offset < txCount; offset += batchSize) {
        const valuesSql: string[] = [];
        const params: (string | number | null)[] = [];
        for (let i = 0; i < batchSize; i++) {
          const idx = offset + i;
          const id = `tx-bench-${String(idx).padStart(5, '0')}`;
          const day = String((idx % 28) + 1).padStart(2, '0');
          const date = `2026-06-${day}`;
          valuesSql.push(
            '(?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)',
          );
          params.push(
            id,
            idx % 5 === 0 ? 'income' : 'expense',
            ((idx % 200) + 1) * 1000,
            DEFAULT_WALLET_ID,
            idx % 5 === 0 ? CAT_SALARY_ID : CAT_FOOD_ID,
            date,
            `${date}T12:00:00+07:00`,
            `Ghi chú giao dịch #${idx}`,
            `ghi chu giao dich #${idx}`,
            'manual',
            'VND',
            ((idx % 200) + 1) * 1000,
            now,
            now,
          );
        }
        await tx.runAsync(
          `INSERT INTO transactions (
            id, kind, amount, wallet_id, to_wallet_id, category_id, debt_id,
            occurred_on, occurred_at, note, note_search, source, recurring_rule_id,
            raw_input, original_currency, original_amount_minor, booking_rate, created_at, updated_at
          ) VALUES ${valuesSql.join(', ')}`,
          ...params,
        );
      }
    });

    const exportStart = performance.now();
    const snapshot = await buildSnapshot(sourceDb, { createdAt: now });
    const exportMs = performance.now() - exportStart;

    expect(snapshot.counts.transactions).toBe(txCount);

    const restoreStart = performance.now();
    await applySnapshot(targetDb, snapshot);
    const restoreMs = performance.now() - restoreStart;

    const restoredCount = await targetDb.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM transactions',
    );
    expect(restoredCount?.c).toBe(txCount);
    expect(exportMs).toBeLessThan(5000);
    expect(restoreMs).toBeLessThan(8000);
  }, 20000);
});
