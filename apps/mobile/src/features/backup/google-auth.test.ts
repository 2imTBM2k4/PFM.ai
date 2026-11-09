import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, type Database, type Queries } from '@/data/migrate';
import {
  BACKUP_STATE_SETTING_KEY,
  classifyGoogleAuthError,
  createGoogleAuthService,
  DEFAULT_BACKUP_STATE,
  GOOGLE_DRIVE_FILE_SCOPE,
  parseBackupState,
  readBackupState,
  updateBackupState,
  writeBackupState,
  type NativeGoogleSignInDriver,
} from './google-auth';

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

describe('Google Auth & Backup State Persistence (B3)', () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    db = wrapSqlite(sqlite);
    await migrate(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('persists and updates backup_state_v1 in SQLite settings with safe defaults', async () => {
    const initial = await readBackupState(db);
    expect(initial).toEqual(DEFAULT_BACKUP_STATE);

    const updated = await updateBackupState(db, {
      enabled: true,
      accountEmail: 'minh@example.com',
      remoteFolderId: 'folder-123',
      remoteFileId: 'file-456',
      lastUploadedHash: 'abc123hash',
      lastSuccessAt: '2026-06-15T12:00:00.000Z',
      dirty: true,
    });
    expect(updated).toEqual({
      enabled: true,
      accountEmail: 'minh@example.com',
      lastSuccessAt: '2026-06-15T12:00:00.000Z',
      lastError: null,
      remoteFolderId: 'folder-123',
      remoteFileId: 'file-456',
      lastUploadedHash: 'abc123hash',
      dirty: true,
    });

    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      BACKUP_STATE_SETTING_KEY,
    );
    expect(row?.value).toBeTruthy();

    await writeBackupState(db, DEFAULT_BACKUP_STATE);
    expect(await readBackupState(db)).toEqual(DEFAULT_BACKUP_STATE);

    // Invalid JSON or unknown error code falls back cleanly
    expect(parseBackupState('{corrupt')).toEqual(DEFAULT_BACKUP_STATE);
    expect(
      parseBackupState(JSON.stringify({ enabled: true, lastError: 'bogus' })),
    ).toEqual({
      ...DEFAULT_BACKUP_STATE,
      enabled: true,
      lastError: null,
    });
  });

  it('classifies user cancel, missing Play Services, network error, revoked auth, and config errors', () => {
    expect(classifyGoogleAuthError({ code: 'SIGN_IN_CANCELLED' })).toBe(
      'cancelled',
    );
    expect(
      classifyGoogleAuthError({ code: 'PLAY_SERVICES_NOT_AVAILABLE' }),
    ).toBe('play_services_unavailable');
    expect(classifyGoogleAuthError({ code: 'NETWORK_ERROR' })).toBe(
      'network_error',
    );
    expect(classifyGoogleAuthError({ code: 'SIGN_IN_REQUIRED' })).toBe(
      'needs_reauth',
    );
    expect(
      classifyGoogleAuthError({ message: 'Token has been expired or revoked' }),
    ).toBe('needs_reauth');
    expect(classifyGoogleAuthError({ code: 'DEVELOPER_ERROR' })).toBe(
      'not_configured',
    );
  });

  it('blocks sign-in and token access cleanly in Expo Go without loading the native module', async () => {
    const loadDriver = vi.fn<() => NativeGoogleSignInDriver | null>(() => {
      throw new Error('Should not load native module in Expo Go');
    });
    const auth = createGoogleAuthService({
      isExpoGo: () => true,
      getWebClientId: () => undefined,
      getIosClientId: () => undefined,
      loadDriver,
    });

    expect(auth.isSupportedRuntime()).toBe(false);
    expect(await auth.signIn()).toEqual({
      ok: false,
      reason: 'expo_go_unsupported',
    });
    expect(await auth.getAccessToken()).toEqual({
      ok: false,
      reason: 'expo_go_unsupported',
    });
    expect(loadDriver).not.toHaveBeenCalled();
  });

  it('configures drive.file scope, signs in, refreshes tokens via clearCachedAccessToken, and transitions to needs_reauth when revoked', async () => {
    const driver: NativeGoogleSignInDriver = {
      configure: vi.fn(),
      hasPlayServices: vi.fn(async () => true),
      signIn: vi.fn(async () => ({
        type: 'success',
        data: { user: { email: 'minh@example.com' } },
      })),
      signInSilently: vi.fn(async () => ({
        type: 'success',
        data: { user: { email: 'minh@example.com' } },
      })),
      getTokens: vi.fn(async () => ({ accessToken: 'ya29.fresh-token' })),
      clearCachedAccessToken: vi.fn(async () => null),
      signOut: vi.fn(async () => null),
    };

    const auth = createGoogleAuthService({
      isExpoGo: () => false,
      getWebClientId: () => 'web-client.apps.googleusercontent.com',
      getIosClientId: () => 'ios-client.apps.googleusercontent.com',
      loadDriver: () => driver,
    });

    expect(auth.isSupportedRuntime()).toBe(true);
    const signInRes = await auth.signIn();
    expect(signInRes).toEqual({
      ok: true,
      email: 'minh@example.com',
      accessToken: 'ya29.fresh-token',
    });
    expect(driver.configure).toHaveBeenCalledWith({
      scopes: [GOOGLE_DRIVE_FILE_SCOPE],
      webClientId: 'web-client.apps.googleusercontent.com',
      iosClientId: 'ios-client.apps.googleusercontent.com',
    });

    // Force refresh clears cached token first
    const refreshed = await auth.getAccessToken({
      forceRefresh: true,
      previousToken: 'ya29.stale-token',
    });
    expect(driver.clearCachedAccessToken).toHaveBeenCalledWith(
      'ya29.stale-token',
    );
    expect(refreshed).toEqual({ ok: true, accessToken: 'ya29.fresh-token' });

    // Revoked token -> getTokens throws SIGN_IN_REQUIRED and signInSilently fails -> needs_reauth
    vi.mocked(driver.getTokens).mockRejectedValueOnce({
      code: 'SIGN_IN_REQUIRED',
    });
    vi.mocked(driver.signInSilently!).mockRejectedValueOnce({
      code: 'SIGN_IN_REQUIRED',
    });
    const revokedRes = await auth.getAccessToken();
    expect(revokedRes).toEqual({ ok: false, reason: 'needs_reauth' });

    await auth.signOut();
    expect(driver.signOut).toHaveBeenCalledTimes(1);
  });
});
