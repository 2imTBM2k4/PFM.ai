import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import {
  runWithoutMutationNotification,
  subscribeDatabaseMutations,
  withDatabase,
} from '@/data/connection';
import { checkBudgetAlerts } from '@/features/budgets/mobile';
import { syncDailyExpenseReminder } from '@/features/notifications/notification-settings-service';
import { runRecurring } from '@/features/recurring/mobile';
import { logAppEvent } from '@/services/logger';
import { useApp } from '@/state/app';
import {
  createDriveClient,
  type RemoteBackupMetadata,
} from './drive-client';
import {
  defaultGoogleAuthService,
  DEFAULT_BACKUP_STATE,
  readBackupState,
  updateBackupState,
  writeBackupState,
  type BackupErrorCode,
  type GoogleAuthErrorReason,
} from './google-auth';
import { hasValidPersistedWebToken } from './google-auth-web';
import { applySnapshot, validateAndPrepareSnapshot } from './restore';
import { buildSnapshot } from './snapshot';
import { decideInitialConnectSync, hasMeaningfulLocalData } from './sync-decision';
import {
  createBackupScheduler,
  type BackupRuntimeStatus,
} from './scheduler';

export const defaultDriveClient = createDriveClient({
  authService: defaultGoogleAuthService,
});

export const backupScheduler = createBackupScheduler({
  runWithDatabase: withDatabase,
  driveClient: defaultDriveClient,
  authService: defaultGoogleAuthService,
  onRemoteNewerDetected: async (fileId) => {
    const res = await restoreFromGoogleDriveBackup({
      fileId,
      enableAutoBackupAfterRestore: true,
    });
    return res.ok;
  },
});

export function useBackupRuntimeStatus(): BackupRuntimeStatus {
  const [status, setStatus] = useState<BackupRuntimeStatus>(() =>
    backupScheduler.getStatus(),
  );

  useEffect(() => {
    const unsubscribe = backupScheduler.subscribe(setStatus);
    void backupScheduler.refreshState();
    return unsubscribe;
  }, []);

  return status;
}

export type BackupOperationError =
  | Exclude<BackupErrorCode, null>
  | GoogleAuthErrorReason
  | 'checksum_mismatch'
  | 'invalid_snapshot';

function mapRestoreExceptionToError(error: unknown): BackupOperationError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'BACKUP_SCHEMA_NEWER_THAN_APP') {
    return 'schema_newer_than_app';
  }
  if (message === 'BACKUP_CHECKSUM_MISMATCH') {
    return 'checksum_mismatch';
  }
  return 'invalid_snapshot';
}

export type ConnectGoogleDriveResult =
  | {
      ok: true;
      email: string;
      syncAction: 'uploaded' | 'restored' | 'already_synced';
    }
  | {
      ok: true;
      email: string;
      syncAction: 'conflict';
      remoteMetadata: RemoteBackupMetadata;
    }
  | { ok: false; error: BackupOperationError };

export async function connectGoogleDriveBackup(): Promise<ConnectGoogleDriveResult> {
  const signInRes = await defaultGoogleAuthService.signIn();
  if (!signInRes.ok) {
    return { ok: false, error: signInRes.reason };
  }

  const localPrep = await withDatabase(async (db) => {
    const previousState = await readBackupState(db);
    const snapshot = await buildSnapshot(db, {
      createdAt: new Date().toISOString(),
    });
    const hasLocalData = await hasMeaningfulLocalData(db);
    return {
      previousState,
      localChecksum: snapshot.checksum,
      hasLocalData,
    };
  });

  const metaRes = await defaultDriveClient.fetchRemoteBackupMetadata({
    cachedFileId: localPrep.previousState.remoteFileId,
  });
  if (!metaRes.ok) {
    await withDatabase((db) =>
      updateBackupState(db, {
        enabled: true,
        accountEmail: signInRes.email,
        lastError: metaRes.errorCode,
        dirty: false,
      }),
    );
    await backupScheduler.refreshState();
    return { ok: false, error: metaRes.errorCode };
  }

  const decision = decideInitialConnectSync({
    signedInEmail: signInRes.email,
    previousState: localPrep.previousState,
    localChecksum: localPrep.localChecksum,
    hasLocalData: localPrep.hasLocalData,
    remoteMetadata: metaRes.found ? metaRes.metadata : null,
  });

  if (decision.action === 'already_synced' && metaRes.found) {
    await withDatabase((db) =>
      updateBackupState(db, {
        enabled: true,
        accountEmail: signInRes.email,
        remoteFileId: metaRes.metadata.fileId,
        lastUploadedHash: metaRes.metadata.sha256 ?? localPrep.localChecksum,
        lastSuccessAt:
          metaRes.metadata.modifiedTime ??
          metaRes.metadata.createdAt ??
          new Date().toISOString(),
        lastError: null,
        dirty: false,
        lastLocalMutationAt: null,
      }),
    );
    await backupScheduler.refreshState();
    return { ok: true, email: signInRes.email, syncAction: 'already_synced' };
  }

  if (decision.action === 'auto_restore') {
    const restoreRes = await restoreFromGoogleDriveBackup({
      fileId: decision.fileId,
      enableAutoBackupAfterRestore: true,
      accountEmail: signInRes.email,
    });
    if (!restoreRes.ok) {
      await withDatabase((db) =>
        updateBackupState(db, {
          enabled: false,
          accountEmail: signInRes.email,
          remoteFileId: decision.fileId,
          lastError: null,
        }),
      );
      await backupScheduler.refreshState();
      return { ok: false, error: restoreRes.error };
    }
    return { ok: true, email: signInRes.email, syncAction: 'restored' };
  }

  if (decision.action === 'ask_conflict') {
    await withDatabase((db) =>
      updateBackupState(db, {
        enabled: false,
        accountEmail: signInRes.email,
        remoteFileId: decision.remoteMetadata.fileId,
        lastError: null,
        dirty: true,
      }),
    );
    await backupScheduler.refreshState();
    return {
      ok: true,
      email: signInRes.email,
      syncAction: 'conflict',
      remoteMetadata: decision.remoteMetadata,
    };
  }

  await withDatabase((db) =>
    updateBackupState(db, {
      enabled: true,
      accountEmail: signInRes.email,
      remoteFileId: metaRes.found ? metaRes.metadata.fileId : null,
      lastError: null,
      dirty: true,
      lastLocalMutationAt: new Date().toISOString(),
    }),
  );

  await backupScheduler.refreshState();
  void backupScheduler.runBackupCycle({ force: true });
  return { ok: true, email: signInRes.email, syncAction: 'uploaded' };
}

/** Resolves a one-time initial sign-in conflict by keeping local data and uploading it to Google Drive. */
export async function resolveInitialSyncByUploadingLocal(): Promise<{
  ok: boolean;
  error: BackupOperationError | null;
}> {
  await withDatabase((db) =>
    updateBackupState(db, {
      enabled: true,
      lastError: null,
      dirty: true,
      lastLocalMutationAt: new Date().toISOString(),
    }),
  );
  await backupScheduler.refreshState();
  return runManualGoogleDriveBackup();
}

export async function setGoogleDriveAutoBackupEnabled(
  enabled: boolean,
): Promise<void> {
  await withDatabase((db) =>
    updateBackupState(db, {
      enabled,
      ...(enabled ? { lastError: null } : {}),
    }),
  );
  await backupScheduler.refreshState();
  if (enabled) {
    void backupScheduler.runBackupCycle({ force: false });
  }
}

export async function runManualGoogleDriveBackup(): Promise<{
  ok: boolean;
  error: BackupOperationError | null;
}> {
  const outcome = await backupScheduler.runBackupCycle({ force: true });
  if (outcome.uploaded || outcome.skippedUnchanged) {
    return { ok: true, error: null };
  }
  return {
    ok: false,
    error: outcome.errorCode ?? 'upload_failed',
  };
}

export async function inspectRemoteGoogleDriveBackup(options?: {
  signInIfNeeded?: boolean;
}): Promise<
  | {
      ok: true;
      found: true;
      metadata: RemoteBackupMetadata;
      accountEmail: string | null;
    }
  | {
      ok: true;
      found: false;
      accountEmail: string | null;
    }
  | {
      ok: false;
      error: BackupOperationError;
    }
> {
  let prefetchedSignInEmail: string | null = null;
  if (
    options?.signInIfNeeded &&
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    !hasValidPersistedWebToken()
  ) {
    const signInRes = await defaultGoogleAuthService.signIn();
    if (!signInRes.ok) {
      return { ok: false, error: signInRes.reason };
    }
    prefetchedSignInEmail = signInRes.email;
  }

  const current = await withDatabase(readBackupState);
  let accountEmail = prefetchedSignInEmail ?? current.accountEmail;

  if (options?.signInIfNeeded && !accountEmail) {
    const signInRes = await defaultGoogleAuthService.signIn();
    if (!signInRes.ok) {
      return { ok: false, error: signInRes.reason };
    }
    accountEmail = signInRes.email;
  }

  const metaRes = await defaultDriveClient.fetchRemoteBackupMetadata({
    cachedFileId: current.remoteFileId,
  });
  if (!metaRes.ok) {
    if (metaRes.errorCode === 'needs_reauth' && options?.signInIfNeeded) {
      const signInRes = await defaultGoogleAuthService.signIn();
      if (!signInRes.ok) {
        return { ok: false, error: signInRes.reason };
      }
      accountEmail = signInRes.email;
      const retryMeta = await defaultDriveClient.fetchRemoteBackupMetadata({
        cachedFileId: null,
      });
      if (!retryMeta.ok) {
        return { ok: false, error: retryMeta.errorCode };
      }
      if (!retryMeta.found) {
        return { ok: true, found: false, accountEmail };
      }
      return {
        ok: true,
        found: true,
        metadata: retryMeta.metadata,
        accountEmail,
      };
    }
    return { ok: false, error: metaRes.errorCode };
  }

  if (!metaRes.found) {
    return { ok: true, found: false, accountEmail };
  }
  return {
    ok: true,
    found: true,
    metadata: metaRes.metadata,
    accountEmail,
  };
}

export async function restoreFromGoogleDriveBackup(options: {
  fileId: string;
  enableAutoBackupAfterRestore?: boolean;
  accountEmail?: string | null;
}): Promise<
  | { ok: true }
  | { ok: false; error: BackupOperationError }
> {
  // 1. Download snapshot outside withDatabase
  const downloadRes = await defaultDriveClient.downloadRemoteBackup(
    options.fileId,
  );
  if (!downloadRes.ok) {
    return { ok: false, error: downloadRes.errorCode };
  }

  // 2. Pre-validate format, schemaVersion, counts, and SHA-256 checksum before touching SQLite
  try {
    await validateAndPrepareSnapshot(downloadRes.rawSnapshot);
  } catch (error) {
    logAppEvent('error', {
      route: 'backup',
      status: 'failed',
      action: 'backup_restore_failed',
    });
    return { ok: false, error: mapRestoreExceptionToError(error) };
  }

  // 3. Apply snapshot atomically inside a single SQLite transaction without firing local mutation hooks
  try {
    await runWithoutMutationNotification(() =>
      withDatabase(async (db) => {
        const restored = await applySnapshot(db, downloadRes.rawSnapshot);
        await db.runAsync(
          `INSERT INTO settings (key, value) VALUES ('onboarding_complete', 'true')
           ON CONFLICT(key) DO UPDATE SET value = 'true'`,
        );
        const current = await readBackupState(db);
        await updateBackupState(db, {
          enabled: options.enableAutoBackupAfterRestore ?? current.enabled,
          accountEmail: options.accountEmail ?? current.accountEmail,
          remoteFileId: options.fileId,
          lastUploadedHash: restored.checksum,
          lastSuccessAt: restored.createdAt,
          lastError: null,
          dirty: false,
          lastLocalMutationAt: null,
        });
      }),
    );
  } catch (error) {
    logAppEvent('error', {
      route: 'backup',
      status: 'failed',
      action: 'backup_restore_failed',
    });
    return { ok: false, error: mapRestoreExceptionToError(error) };
  }

  // 4. Refresh app state & reschedule local notifications after restore
  await useApp.getState().initialize();
  await useApp.getState().refreshWallets();
  await runRecurring(true).catch(() => undefined);
  await checkBudgetAlerts().catch(() => undefined);
  await syncDailyExpenseReminder().catch(() => undefined);
  await backupScheduler.refreshState();

  logAppEvent('info', {
    route: 'backup',
    status: 'ready',
    action: 'backup_restore_succeeded',
  });
  return { ok: true };
}

export async function disconnectGoogleDriveBackup(options?: {
  deleteRemoteFile?: boolean;
}): Promise<void> {
  const current = await withDatabase(readBackupState);
  if (options?.deleteRemoteFile && current.remoteFileId) {
    await defaultDriveClient
      .deleteRemoteBackup(current.remoteFileId)
      .catch(() => undefined);
  }
  await defaultGoogleAuthService.signOut();
  await withDatabase((db) => writeBackupState(db, DEFAULT_BACKUP_STATE));
  await backupScheduler.refreshState();
}

export function BackupWatcher() {
  const status = useApp((state) => state.status);
  const onboarded = useApp((state) => state.onboarded);

  useEffect(() => {
    if (status !== 'ready' || !onboarded) {
      backupScheduler.stop();
      return;
    }
    void backupScheduler.start();
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      void backupScheduler.notifyAppStateChange(nextState);
    });
    const unsubscribeMutations = subscribeDatabaseMutations(() => {
      backupScheduler.notifyDataChanged();
    });

    const cleanupWebListeners: (() => void)[] = [];
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const handleFocus = () => {
        void backupScheduler.notifyAppStateChange('active');
      };
      const handleOnline = () => {
        void backupScheduler.notifyNetworkAvailable();
      };
      window.addEventListener('focus', handleFocus);
      window.addEventListener('online', handleOnline);
      cleanupWebListeners.push(() => {
        window.removeEventListener('focus', handleFocus);
        window.removeEventListener('online', handleOnline);
      });
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      const handleVisibility = () => {
        if (document.visibilityState === 'visible') {
          void backupScheduler.notifyAppStateChange('active');
        }
      };
      document.addEventListener('visibilitychange', handleVisibility);
      cleanupWebListeners.push(() => {
        document.removeEventListener('visibilitychange', handleVisibility);
      });
    }

    return () => {
      appStateSub.remove();
      unsubscribeMutations();
      for (const cleanup of cleanupWebListeners) {
        cleanup();
      }
      backupScheduler.stop();
    };
  }, [status, onboarded]);

  return null;
}
