import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, type Database, type Queries } from '@/data/migrate';
import { DEFAULT_WALLET_ID, seed } from '@/data/seed';
import type { RemoteBackupMetadata } from './drive-client';
import { DEFAULT_BACKUP_STATE } from './google-auth';
import {
  decideInitialConnectSync,
  hasMeaningfulLocalData,
} from './sync-decision';

function wrapSqlite(sqlite: DatabaseSync): Database {
  const queries: Queries = {
    execAsync: async (sql) => {
      sqlite.exec(sql);
    },
    runAsync: async (sql, ...params) => {
      const result = sqlite
        .prepare(sql)
        .run(...(params as (string | number | null)[]));
      return { changes: Number(result.changes) };
    },
    getFirstAsync: async <T,>(sql: string, ...params: unknown[]) => {
      return (
        (sqlite
          .prepare(sql)
          .get(...(params as (string | number | null)[])) as T | undefined) ??
        null
      );
    },
    getAllAsync: async <T,>(sql: string, ...params: unknown[]) => {
      return sqlite
        .prepare(sql)
        .all(...(params as (string | number | null)[])) as T[];
    },
  };
  return {
    ...queries,
    transaction: async (task) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await task(queries);
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function makeRemoteMeta(
  overrides: Partial<RemoteBackupMetadata> = {},
): RemoteBackupMetadata {
  return {
    fileId: 'drive-file-1',
    modifiedTime: '2026-06-15T12:00:00.000Z',
    createdAt: '2026-06-15T12:00:00.000Z',
    sha256: 'a'.repeat(64),
    schemaVersion: 7,
    formatVersion: 1,
    txCount: 5,
    walletCount: 2,
    sizeBytes: 1024,
    ...overrides,
  };
}

describe('hasMeaningfulLocalData', () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON;');
    db = wrapSqlite(sqlite);
    await migrate(db);
    await seed(db, '2026-06-15T00:00:00.000Z');
  });

  afterEach(() => {
    sqlite.close();
  });

  it('returns false for a fresh seeded database with zero-balance default wallet', async () => {
    expect(await hasMeaningfulLocalData(db)).toBe(false);
  });

  it('returns true when default wallet has non-zero initial balance', async () => {
    await db.runAsync(
      'UPDATE wallets SET initial_balance = 500000 WHERE id = ?',
      DEFAULT_WALLET_ID,
    );
    expect(await hasMeaningfulLocalData(db)).toBe(true);
  });

  it('returns true when a second wallet is added', async () => {
    await db.runAsync(
      `INSERT INTO wallets (id, name, kind, initial_balance, created_at, updated_at)
       VALUES ('wallet-2', 'Bank', 'bank', 0, '2026-06-15T00:00:00.000Z', '2026-06-15T00:00:00.000Z')`,
    );
    expect(await hasMeaningfulLocalData(db)).toBe(true);
  });

  it('returns true when a transaction exists', async () => {
    await db.runAsync(
      `INSERT INTO transactions (id, kind, amount, wallet_id, occurred_on, occurred_at, source, created_at, updated_at)
       VALUES ('tx-1', 'expense', 45000, ?, '2026-06-15', '2026-06-15T09:00:00.000Z', 'manual', '2026-06-15T00:00:00.000Z', '2026-06-15T00:00:00.000Z')`,
      DEFAULT_WALLET_ID,
    );
    expect(await hasMeaningfulLocalData(db)).toBe(true);
  });

  it('returns true when a custom category exists', async () => {
    await db.runAsync(
      `INSERT INTO categories (id, system_key, parent_id, name, kind, is_fixed_cost, sort_order, created_at, updated_at)
       VALUES ('cat-custom', NULL, NULL, 'Coffee', 'expense', 0, 99, '2026-06-15T00:00:00.000Z', '2026-06-15T00:00:00.000Z')`,
    );
    expect(await hasMeaningfulLocalData(db)).toBe(true);
  });
});

describe('decideInitialConnectSync (A2)', () => {
  it('uploads initial backup when Drive has no backup file yet', () => {
    const decision = decideInitialConnectSync({
      signedInEmail: 'minh@example.com',
      previousState: DEFAULT_BACKUP_STATE,
      localChecksum: '1'.repeat(64),
      hasLocalData: true,
      remoteMetadata: null,
    });
    expect(decision).toEqual({ action: 'upload_initial' });
  });

  it('marks already_synced when local checksum matches remote sha256', () => {
    const remote = makeRemoteMeta({ sha256: 'b'.repeat(64) });
    const decision = decideInitialConnectSync({
      signedInEmail: 'minh@example.com',
      previousState: DEFAULT_BACKUP_STATE,
      localChecksum: 'B'.repeat(64),
      hasLocalData: true,
      remoteMetadata: remote,
    });
    expect(decision).toEqual({ action: 'already_synced' });
  });

  it('auto-restores from Drive when device has no meaningful local data', () => {
    const remote = makeRemoteMeta({ fileId: 'remote-ios-backup' });
    const decision = decideInitialConnectSync({
      signedInEmail: 'minh@example.com',
      previousState: DEFAULT_BACKUP_STATE,
      localChecksum: '2'.repeat(64),
      hasLocalData: false,
      remoteMetadata: remote,
    });
    expect(decision).toEqual({
      action: 'auto_restore',
      fileId: 'remote-ios-backup',
    });
  });

  it('asks once on conflict when both fresh device and Drive have different real data', () => {
    const remote = makeRemoteMeta({ sha256: 'a'.repeat(64) });
    const decision = decideInitialConnectSync({
      signedInEmail: 'minh@example.com',
      previousState: DEFAULT_BACKUP_STATE,
      localChecksum: 'c'.repeat(64),
      hasLocalData: true,
      remoteMetadata: remote,
    });
    expect(decision).toEqual({
      action: 'ask_conflict',
      remoteMetadata: remote,
    });
  });

  it('uploads local edits without conflict prompt on same-account re-auth when Drive is unchanged', () => {
    const remote = makeRemoteMeta({ sha256: 'a'.repeat(64) });
    const decision = decideInitialConnectSync({
      signedInEmail: 'minh@example.com',
      previousState: {
        ...DEFAULT_BACKUP_STATE,
        accountEmail: 'minh@example.com',
        lastUploadedHash: 'a'.repeat(64),
      },
      localChecksum: 'd'.repeat(64),
      hasLocalData: true,
      remoteMetadata: remote,
    });
    expect(decision).toEqual({ action: 'upload_local' });
  });

  it('auto-restores without conflict prompt on same-account re-auth when only Drive changed', () => {
    const remote = makeRemoteMeta({
      fileId: 'drive-newer',
      sha256: 'e'.repeat(64),
    });
    const decision = decideInitialConnectSync({
      signedInEmail: 'minh@example.com',
      previousState: {
        ...DEFAULT_BACKUP_STATE,
        accountEmail: 'minh@example.com',
        lastUploadedHash: 'a'.repeat(64),
      },
      localChecksum: 'a'.repeat(64),
      hasLocalData: true,
      remoteMetadata: remote,
    });
    expect(decision).toEqual({
      action: 'auto_restore',
      fileId: 'drive-newer',
    });
  });
});
