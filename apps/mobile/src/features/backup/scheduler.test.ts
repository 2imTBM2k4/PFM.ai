import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, type Database, type Queries } from '@/data/migrate';
import { DEFAULT_WALLET_ID, seed } from '@/data/seed';
import type { DriveClient, DriveUploadResult } from './drive-client';
import {
  readBackupState,
  updateBackupState,
  type GoogleAuthService,
} from './google-auth';
import {
  createBackupScheduler,
  hasBackupIndicatorIssue,
} from './scheduler';

function wrapSqlite(sqlite: DatabaseSync): Database {
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

function createMockAuthService(): GoogleAuthService {
  return {
    isSupportedRuntime: () => true,
    signIn: vi.fn(),
    getAccessToken: vi.fn(async () => ({
      ok: true,
      accessToken: 'ya29.token',
    })),
    signOut: vi.fn(),
  };
}

describe('Automatic Backup Scheduler (B5)', () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(async () => {
    vi.useFakeTimers();
    sqlite = new DatabaseSync(':memory:');
    db = wrapSqlite(sqlite);
    await migrate(db);
    await seed(db, '2026-06-15T10:00:00.000Z');
    await updateBackupState(db, {
      enabled: true,
      accountEmail: 'minh@example.com',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  it('1. Skips upload when database tables hash matches lastUploadedHash and dirty is false', async () => {
    const uploadSnapshot = vi.fn<DriveClient['uploadSnapshot']>(
      async (snapshot) => ({
        ok: true,
        folderId: 'folder-1',
        fileId: 'file-1',
        sha256: snapshot.checksum,
        modifiedTime: '2026-06-15T12:00:00.000Z',
      }),
    );

    const driveClient: DriveClient = {
      uploadSnapshot,
      fetchRemoteBackupMetadata: vi.fn(),
      downloadRemoteBackup: vi.fn(),
      deleteRemoteBackup: vi.fn(),
    };

    const scheduler = createBackupScheduler({
      runWithDatabase: (task) => task(db),
      driveClient,
      authService: createMockAuthService(),
      now: () => '2026-06-15T12:00:00.000Z',
    });

    // 1st run uploads initial snapshot
    const first = await scheduler.runBackupCycle();
    expect(first.uploaded).toBe(true);
    expect(uploadSnapshot).toHaveBeenCalledTimes(1);

    // 2nd run with no DB changes skips upload completely
    const second = await scheduler.runBackupCycle();
    expect(second.uploaded).toBe(false);
    expect(second.skippedUnchanged).toBe(true);
    expect(uploadSnapshot).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('2. Debounces notifyDataChanged() and uploads once when data changes', async () => {
    const uploadSnapshot = vi.fn<DriveClient['uploadSnapshot']>(
      async (snapshot) => ({
        ok: true,
        folderId: 'folder-1',
        fileId: 'file-1',
        sha256: snapshot.checksum,
        modifiedTime: '2026-06-15T12:00:00.000Z',
      }),
    );

    const scheduler = createBackupScheduler({
      runWithDatabase: (task) => task(db),
      driveClient: {
        uploadSnapshot,
        fetchRemoteBackupMetadata: vi.fn(),
        downloadRemoteBackup: vi.fn(),
        deleteRemoteBackup: vi.fn(),
      },
      authService: createMockAuthService(),
      debounceMs: 3000,
    });

    await scheduler.refreshState();

    // Mutate DB and call notifyDataChanged 4 times rapidly
    await db.runAsync(
      `UPDATE wallets SET initial_balance = 500000 WHERE id = ?`,
      DEFAULT_WALLET_ID,
    );
    scheduler.notifyDataChanged();
    scheduler.notifyDataChanged();
    scheduler.notifyDataChanged();
    scheduler.notifyDataChanged();

    expect(uploadSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(uploadSnapshot).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('3. Single-flight: coalesces multiple changes during an in-flight upload into a single follow-up upload', async () => {
    let resolveFirstUpload!: (value: DriveUploadResult) => void;
    let callCount = 0;

    const uploadSnapshot = vi.fn<DriveClient['uploadSnapshot']>((snapshot) => {
      callCount++;
      if (callCount === 1) {
        return new Promise<DriveUploadResult>((resolve) => {
          resolveFirstUpload = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        folderId: 'folder-1',
        fileId: 'file-1',
        sha256: snapshot.checksum,
        modifiedTime: '2026-06-15T12:05:00.000Z',
      });
    });

    const scheduler = createBackupScheduler({
      runWithDatabase: (task) => task(db),
      driveClient: {
        uploadSnapshot,
        fetchRemoteBackupMetadata: vi.fn(),
        downloadRemoteBackup: vi.fn(),
        deleteRemoteBackup: vi.fn(),
      },
      authService: createMockAuthService(),
    });

    const firstCyclePromise = scheduler.runBackupCycle();

    // Wait for first uploadSnapshot to be entered
    await vi.advanceTimersByTimeAsync(10);
    expect(uploadSnapshot).toHaveBeenCalledTimes(1);

    // While first upload is in flight, mutate DB and trigger 3 more cycles
    await db.runAsync(
      `UPDATE wallets SET initial_balance = 900000 WHERE id = ?`,
      DEFAULT_WALLET_ID,
    );
    void scheduler.runBackupCycle();
    void scheduler.runBackupCycle();
    void scheduler.runBackupCycle();

    // Still only 1 in-flight upload
    expect(uploadSnapshot).toHaveBeenCalledTimes(1);

    const firstSnapshotArg = uploadSnapshot.mock.calls[0]![0];
    resolveFirstUpload({
      ok: true,
      folderId: 'folder-1',
      fileId: 'file-1',
      sha256: firstSnapshotArg.checksum,
      modifiedTime: '2026-06-15T12:01:00.000Z',
    });

    await firstCyclePromise;
    // Exactly 1 follow-up upload ran for the new DB state
    expect(uploadSnapshot).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('4. Persists dirty=true before upload so an app kill mid-upload triggers a recovery upload on next startup', async () => {
    let dirtyDuringUpload = false;
    const crashingScheduler = createBackupScheduler({
      runWithDatabase: (task) => task(db),
      driveClient: {
        uploadSnapshot: vi.fn(async () => {
          const stateWhileInFlight = await readBackupState(db);
          dirtyDuringUpload = stateWhileInFlight.dirty;
          return { ok: false, errorCode: 'network_error' };
        }),
        fetchRemoteBackupMetadata: vi.fn(),
        downloadRemoteBackup: vi.fn(),
        deleteRemoteBackup: vi.fn(),
      },
      authService: createMockAuthService(),
    });

    await crashingScheduler.runBackupCycle();
    expect(dirtyDuringUpload).toBe(true);
    expect((await readBackupState(db)).dirty).toBe(true);
    crashingScheduler.stop();

    // Simulate app restart with a fresh scheduler instance
    const recoveryUpload = vi.fn<DriveClient['uploadSnapshot']>(
      async (snapshot) => ({
        ok: true,
        folderId: 'folder-1',
        fileId: 'file-1',
        sha256: snapshot.checksum,
        modifiedTime: '2026-06-15T12:10:00.000Z',
      }),
    );

    const restartedScheduler = createBackupScheduler({
      runWithDatabase: (task) => task(db),
      driveClient: {
        uploadSnapshot: recoveryUpload,
        fetchRemoteBackupMetadata: vi.fn(),
        downloadRemoteBackup: vi.fn(),
        deleteRemoteBackup: vi.fn(),
      },
      authService: createMockAuthService(),
    });

    await restartedScheduler.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(recoveryUpload).toHaveBeenCalledTimes(1);
    const finalState = await readBackupState(db);
    expect(finalState.dirty).toBe(false);
    expect(finalState.lastError).toBeNull();
    restartedScheduler.stop();
  });

  it('5. Retries after network_error when notifyNetworkAvailable() is triggered', async () => {
    const uploadSnapshot = vi
      .fn<DriveClient['uploadSnapshot']>()
      .mockResolvedValueOnce({ ok: false, errorCode: 'network_error' })
      .mockImplementationOnce(async (snapshot) => ({
        ok: true,
        folderId: 'folder-1',
        fileId: 'file-1',
        sha256: snapshot.checksum,
        modifiedTime: '2026-06-15T12:15:00.000Z',
      }));

    const scheduler = createBackupScheduler({
      runWithDatabase: (task) => task(db),
      driveClient: {
        uploadSnapshot,
        fetchRemoteBackupMetadata: vi.fn(),
        downloadRemoteBackup: vi.fn(),
        deleteRemoteBackup: vi.fn(),
      },
      authService: createMockAuthService(),
    });

    const failed = await scheduler.runBackupCycle();
    expect(failed.errorCode).toBe('network_error');

    await scheduler.notifyNetworkAvailable();
    expect(uploadSnapshot).toHaveBeenCalledTimes(2);
    expect((await readBackupState(db)).lastError).toBeNull();
    scheduler.stop();
  });

  it('6. Stops automatic timer loop when needs_reauth or drive_quota_exceeded occurs', async () => {
    const uploadSnapshot = vi
      .fn<DriveClient['uploadSnapshot']>()
      .mockResolvedValue({ ok: false, errorCode: 'needs_reauth' });

    const scheduler = createBackupScheduler({
      runWithDatabase: (task) => task(db),
      driveClient: {
        uploadSnapshot,
        fetchRemoteBackupMetadata: vi.fn(),
        downloadRemoteBackup: vi.fn(),
        deleteRemoteBackup: vi.fn(),
      },
      authService: createMockAuthService(),
      foregroundIntervalMs: 60_000,
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(uploadSnapshot).toHaveBeenCalledTimes(1);
    expect((await readBackupState(db)).lastError).toBe('needs_reauth');

    // Advance 5 minutes: timer should NOT trigger more calls while in needs_reauth
    await vi.advanceTimersByTimeAsync(300_000);
    await scheduler.notifyAppStateChange('background');
    await scheduler.notifyNetworkAvailable();
    expect(uploadSnapshot).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('7. Triggers backup on background transition and stops when disabled', async () => {
    const uploadSnapshot = vi.fn<DriveClient['uploadSnapshot']>(
      async (snapshot) => ({
        ok: true,
        folderId: 'folder-1',
        fileId: 'file-1',
        sha256: snapshot.checksum,
        modifiedTime: '2026-06-15T12:20:00.000Z',
      }),
    );

    const scheduler = createBackupScheduler({
      runWithDatabase: (task) => task(db),
      driveClient: {
        uploadSnapshot,
        fetchRemoteBackupMetadata: vi.fn(),
        downloadRemoteBackup: vi.fn(),
        deleteRemoteBackup: vi.fn(),
      },
      authService: createMockAuthService(),
    });

    await scheduler.notifyAppStateChange('background');
    expect(uploadSnapshot).toHaveBeenCalledTimes(1);

    // Disable backup -> subsequent background/timer calls do not run
    await updateBackupState(db, { enabled: false });
    await db.runAsync(
      `UPDATE wallets SET initial_balance = 750000 WHERE id = ?`,
      DEFAULT_WALLET_ID,
    );
    await scheduler.notifyAppStateChange('background');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(uploadSnapshot).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('8. Computes Settings indicator badge status accurately', async () => {
    const nowMs = Date.parse('2026-06-15T12:00:00.000Z');
    const state = await readBackupState(db);

    // Enabled but never backed up yet -> issue indicator true
    expect(hasBackupIndicatorIssue(state, nowMs)).toBe(true);

    // Recent backup with no error -> false
    expect(
      hasBackupIndicatorIssue(
        {
          ...state,
          lastSuccessAt: '2026-06-15T11:30:00.000Z',
          lastError: null,
        },
        nowMs,
      ),
    ).toBe(false);

    // Stale (> 24h) -> true
    expect(
      hasBackupIndicatorIssue(
        {
          ...state,
          lastSuccessAt: '2026-06-13T10:00:00.000Z',
          lastError: null,
        },
        nowMs,
      ),
    ).toBe(true);

    // Disabled -> false
    expect(
      hasBackupIndicatorIssue({ ...state, enabled: false }, nowMs),
    ).toBe(false);
  });
});
