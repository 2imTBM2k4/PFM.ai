import { describe, expect, it, vi } from 'vitest';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_LATEST_SCHEMA_VERSION,
  type BackupSnapshot,
} from '@pfm/contracts';
import { createDriveClient } from './drive-client';
import type { GoogleAuthService } from './google-auth';

function createSampleSnapshot(): BackupSnapshot {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: BACKUP_LATEST_SCHEMA_VERSION,
    appVersion: '0.1.0',
    createdAt: '2026-06-15T12:00:00.000Z',
    counts: {
      wallets: 2,
      categories: 25,
      debts: 0,
      recurring_rules: 0,
      transactions: 42,
      recurring_skips: 0,
      budgets: 1,
      goals: 0,
      parse_learning: 0,
      settings: 1,
    },
    walletBalances: {
      'wallet-1': 500000,
      'wallet-2': 1200000,
    },
    checksum: 'a'.repeat(64),
    tables: {
      wallets: [],
      categories: [],
      debts: [],
      recurring_rules: [],
      transactions: [],
      recurring_skips: [],
      budgets: [],
      goals: [],
      parse_learning: [],
      settings: [{ key: 'onboarding_complete', value: 'true' }],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Google Drive Client (B4)', () => {
  it('1. 401 -> refreshes token once and succeeds', async () => {
    const snapshot = createSampleSnapshot();
    const getAccessToken = vi
      .fn<GoogleAuthService['getAccessToken']>()
      .mockResolvedValueOnce({ ok: true, accessToken: 'ya29.expired-token' })
      .mockResolvedValue({ ok: true, accessToken: 'ya29.refreshed-token' });

    const authService: GoogleAuthService = {
      isSupportedRuntime: () => true,
      signIn: vi.fn(),
      getAccessToken,
      signOut: vi.fn(),
    };

    const fetchImpl = vi
      .fn<typeof fetch>()
      // 1st call: check cached folder -> 401 with expired token
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      // Retried 1st call with refreshed token -> 200 folder exists
      .mockResolvedValueOnce(
        jsonResponse({ id: 'folder-1', name: 'PFM.ai', trashed: false }),
      )
      // 2nd call: check cached file -> 200 file exists
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'file-1',
          name: 'pfm-backup-v1.json',
          trashed: false,
        }),
      )
      // 3rd call: PATCH upload -> 200 with matching sha256
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'file-1',
          size: '512',
          modifiedTime: '2026-06-15T12:01:00.000Z',
          appProperties: { sha256: snapshot.checksum },
        }),
      );

    const client = createDriveClient({
      fetchImpl,
      authService,
      sleep: async () => {},
    });

    const res = await client.uploadSnapshot(snapshot, {
      cachedFolderId: 'folder-1',
      cachedFileId: 'file-1',
    });

    expect(res).toEqual({
      ok: true,
      folderId: 'folder-1',
      fileId: 'file-1',
      sha256: snapshot.checksum,
      modifiedTime: '2026-06-15T12:01:00.000Z',
    });
    expect(getAccessToken).toHaveBeenCalledWith({
      forceRefresh: true,
      previousToken: 'ya29.expired-token',
    });
  });

  it('2. Repeated 401 -> transitions to needs_reauth without infinite retries', async () => {
    const snapshot = createSampleSnapshot();
    const getAccessToken = vi
      .fn<GoogleAuthService['getAccessToken']>()
      .mockResolvedValueOnce({ ok: true, accessToken: 'ya29.token-1' })
      .mockResolvedValueOnce({ ok: true, accessToken: 'ya29.token-2' });

    const authService: GoogleAuthService = {
      isSupportedRuntime: () => true,
      signIn: vi.fn(),
      getAccessToken,
      signOut: vi.fn(),
    };

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: 'Still Unauthorized' }, 401));

    const client = createDriveClient({
      fetchImpl,
      authService,
      sleep: async () => {},
    });

    const res = await client.uploadSnapshot(snapshot, {
      cachedFolderId: 'folder-1',
    });

    expect(res).toEqual({ ok: false, errorCode: 'needs_reauth' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('3. 404 on cached folder/file -> searches by appProperties and creates new file cleanly', async () => {
    const snapshot = createSampleSnapshot();
    const authService: GoogleAuthService = {
      isSupportedRuntime: () => true,
      signIn: vi.fn(),
      getAccessToken: vi.fn(async () => ({
        ok: true as const,
        accessToken: 'ya29.valid',
      })),
      signOut: vi.fn(),
    };

    const fetchImpl = vi
      .fn<typeof fetch>()
      // 1. GET cachedFolderId -> 404
      .mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404))
      // 2. Search folder by appProperties -> none found
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      // 3. POST create folder -> new-folder-id
      .mockResolvedValueOnce(jsonResponse({ id: 'new-folder-id' }))
      // 4. GET cachedFileId -> 404
      .mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404))
      // 5. Search backup file by appProperties -> none found
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      // 6. POST multipart create backup file -> new-file-id
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'new-file-id',
          size: '1024',
          modifiedTime: '2026-06-15T12:05:00.000Z',
          appProperties: { sha256: snapshot.checksum },
        }),
      );

    const client = createDriveClient({
      fetchImpl,
      authService,
      sleep: async () => {},
    });

    const res = await client.uploadSnapshot(snapshot, {
      cachedFolderId: 'deleted-folder',
      cachedFileId: 'deleted-file',
    });

    expect(res).toEqual({
      ok: true,
      folderId: 'new-folder-id',
      fileId: 'new-file-id',
      sha256: snapshot.checksum,
      modifiedTime: '2026-06-15T12:05:00.000Z',
    });
  });

  it('4. 403 storageQuotaExceeded -> returns distinct drive_quota_exceeded error code', async () => {
    const snapshot = createSampleSnapshot();
    const authService: GoogleAuthService = {
      isSupportedRuntime: () => true,
      signIn: vi.fn(),
      getAccessToken: vi.fn(async () => ({
        ok: true as const,
        accessToken: 'ya29.valid',
      })),
      signOut: vi.fn(),
    };

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ id: 'folder-1', name: 'PFM.ai', trashed: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: 'file-1', name: 'pfm-backup-v1.json', trashed: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 403,
              message: 'The user has exceeded their Drive storage quota',
              errors: [{ domain: 'usageLimits', reason: 'storageQuotaExceeded' }],
            },
          },
          403,
        ),
      );

    const client = createDriveClient({
      fetchImpl,
      authService,
      sleep: async () => {},
    });

    const res = await client.uploadSnapshot(snapshot, {
      cachedFolderId: 'folder-1',
      cachedFileId: 'file-1',
    });

    expect(res).toEqual({ ok: false, errorCode: 'drive_quota_exceeded' });
  });

  it('5. 5xx / 429 -> retries with bounded backoff then gives up cleanly', async () => {
    const snapshot = createSampleSnapshot();
    const authService: GoogleAuthService = {
      isSupportedRuntime: () => true,
      signIn: vi.fn(),
      getAccessToken: vi.fn(async () => ({
        ok: true as const,
        accessToken: 'ya29.valid',
      })),
      signOut: vi.fn(),
    };

    const sleepDelays: number[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'Rate limit' }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: 'Server error' }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: 'Bad gateway' }, 502))
      .mockResolvedValueOnce(jsonResponse({ error: 'Still down' }, 500));

    const client = createDriveClient({
      fetchImpl,
      authService,
      maxRetries: 3,
      random: () => 0,
      sleep: async (ms) => {
        sleepDelays.push(ms);
      },
    });

    const res = await client.uploadSnapshot(snapshot, {
      cachedFolderId: 'folder-1',
    });

    expect(res).toEqual({ ok: false, errorCode: 'upload_failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(sleepDelays).toEqual([1000, 2000, 4000]);
  });

  it('6. Post-upload verification mismatch -> returns verify_failed so caller never updates lastSuccessAt', async () => {
    const snapshot = createSampleSnapshot();
    const authService: GoogleAuthService = {
      isSupportedRuntime: () => true,
      signIn: vi.fn(),
      getAccessToken: vi.fn(async () => ({
        ok: true as const,
        accessToken: 'ya29.valid',
      })),
      signOut: vi.fn(),
    };

    const logEntries: Record<string, unknown>[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ id: 'folder-1', name: 'PFM.ai', trashed: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: 'file-1', name: 'pfm-backup-v1.json', trashed: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'file-1',
          size: '512',
          modifiedTime: '2026-06-15T12:01:00.000Z',
          appProperties: { sha256: 'b'.repeat(64) }, // Wrong sha256!
        }),
      );

    const client = createDriveClient({
      fetchImpl,
      authService,
      sleep: async () => {},
      logger: (level, fields) => {
        logEntries.push({ level, ...fields });
      },
    });

    const res = await client.uploadSnapshot(snapshot, {
      cachedFolderId: 'folder-1',
      cachedFileId: 'file-1',
    });

    expect(res).toEqual({ ok: false, errorCode: 'verify_failed' });
    expect(logEntries).toEqual([
      {
        level: 'error',
        route: 'backup',
        status: 'failed',
        action: 'backup_upload_failed',
        errorCode: 'BACKUP_VERIFY_FAILED',
      },
    ]);
  });

  it('7. Multiple duplicate backup files on Drive -> picks newest modifiedTime, logs warning, and never logs token', async () => {
    const authService: GoogleAuthService = {
      isSupportedRuntime: () => true,
      signIn: vi.fn(),
      getAccessToken: vi.fn(async () => ({
        ok: true as const,
        accessToken: 'ya29.SECRET_ACCESS_TOKEN_DO_NOT_LOG',
      })),
      signOut: vi.fn(),
    };

    const logEntries: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            id: 'file-older',
            name: 'pfm-backup-v1.json',
            size: '800',
            modifiedTime: '2026-06-14T10:00:00.000Z',
            trashed: false,
            appProperties: {
              pfm_kind: 'backup',
              sha256: '1'.repeat(64),
              schemaVersion: '4',
              formatVersion: '1',
              createdAt: '2026-06-14T10:00:00.000Z',
              txCount: '10',
              walletCount: '1',
            },
          },
          {
            id: 'file-newer',
            name: 'pfm-backup-v1.json',
            size: '1600',
            modifiedTime: '2026-06-15T18:30:00.000Z',
            trashed: false,
            appProperties: {
              pfm_kind: 'backup',
              sha256: '2'.repeat(64),
              schemaVersion: '4',
              formatVersion: '1',
              createdAt: '2026-06-15T18:30:00.000Z',
              txCount: '42',
              walletCount: '3',
            },
          },
        ],
      }),
    );

    const client = createDriveClient({
      fetchImpl,
      authService,
      sleep: async () => {},
      logger: (level, fields) => {
        logEntries.push({ level, ...fields });
      },
    });

    const metaRes = await client.fetchRemoteBackupMetadata();
    expect(metaRes).toEqual({
      ok: true,
      found: true,
      metadata: {
        fileId: 'file-newer',
        modifiedTime: '2026-06-15T18:30:00.000Z',
        createdAt: '2026-06-15T18:30:00.000Z',
        sha256: '2'.repeat(64),
        schemaVersion: 4,
        formatVersion: 1,
        txCount: 42,
        walletCount: 3,
        sizeBytes: 1600,
      },
    });

    expect(logEntries).toEqual([
      {
        level: 'info',
        route: 'backup',
        status: 'ready',
        action: 'backup_duplicate_files',
      },
    ]);
    expect(JSON.stringify(logEntries)).not.toContain(
      'ya29.SECRET_ACCESS_TOKEN_DO_NOT_LOG',
    );
  });
});
