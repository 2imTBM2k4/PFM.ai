import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { withDatabase } from '@/data/connection';
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
import { applySnapshot, validateAndPrepareSnapshot } from './restore';
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

export async function connectGoogleDriveBackup(): Promise<
  | { ok: true; email: string }
  | { ok: false; error: BackupOperationError }
> {
  const signInRes = await defaultGoogleAuthService.signIn();
  if (!signInRes.ok) {
    return { ok: false, error: signInRes.reason };
  }

  await withDatabase((db) =>
    updateBackupState(db, {
      enabled: true,
      accountEmail: signInRes.email,
      lastError: null,
      dirty: true,
    }),
  );

  await backupScheduler.refreshState();
  void backupScheduler.runBackupCycle({ force: true });
  return { ok: true, email: signInRes.email };
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
  const current = await withDatabase(readBackupState);
  let accountEmail = current.accountEmail;

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

  // 3. Apply snapshot atomically inside a single SQLite transaction
  try {
    await withDatabase(async (db) => {
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
      });
    });
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
  const wallets = useApp((state) => state.wallets);
  const recurringVersion = useApp((state) => state.recurringVersion);

  useEffect(() => {
    if (status !== 'ready' || !onboarded) {
      backupScheduler.stop();
      return;
    }
    void backupScheduler.start();
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      void backupScheduler.notifyAppStateChange(nextState);
    });
    return () => {
      appStateSub.remove();
      backupScheduler.stop();
    };
  }, [status, onboarded]);

  useEffect(() => {
    if (status === 'ready' && onboarded) {
      backupScheduler.notifyDataChanged();
    }
  }, [status, onboarded, wallets, recurringVersion]);

  return null;
}
