import type { BackupSnapshot } from '@pfm/contracts';
import type { Database } from '@/data/migrate';
import {
  createDriveClient,
  type DriveClient,
  type DriveUploadResult,
} from './drive-client';
import {
  defaultGoogleAuthService,
  DEFAULT_BACKUP_STATE,
  readBackupState,
  updateBackupState,
  type BackupErrorCode,
  type BackupState,
  type GoogleAuthService,
} from './google-auth';
import { buildSnapshot, type HashPort } from './snapshot';

export const BACKUP_FOREGROUND_INTERVAL_MS = 60_000;
export const BACKUP_DEBOUNCE_MS = 3_000;
export const BACKUP_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface BackupRuntimeStatus {
  state: BackupState;
  isUploading: boolean;
  isSupportedRuntime: boolean;
}

export function isBackupErrorStoppingAutoLoop(
  error: BackupErrorCode,
): boolean {
  return (
    error === 'needs_reauth' ||
    error === 'drive_quota_exceeded' ||
    error === 'expo_go_unsupported' ||
    error === 'not_configured'
  );
}

export function hasBackupIndicatorIssue(
  state: BackupState,
  nowMs: number = Date.now(),
): boolean {
  if (!state.enabled) return false;
  if (state.lastError !== null) return true;
  if (!state.lastSuccessAt) return true;
  const lastMs = Date.parse(state.lastSuccessAt);
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs > BACKUP_STALE_THRESHOLD_MS;
}

export interface BackupSchedulerDependencies {
  runWithDatabase: <T>(task: (db: Database) => Promise<T>) => Promise<T>;
  driveClient?: DriveClient;
  authService?: GoogleAuthService;
  now?: () => string;
  hashPort?: HashPort;
  foregroundIntervalMs?: number;
  debounceMs?: number;
  /** Called during automatic sync when Drive has a newer snapshot from another device and local has no unsynced changes. */
  onRemoteNewerDetected?: (fileId: string, remoteSha256: string) => Promise<boolean>;
}

export interface BackupCycleOutcome {
  uploaded: boolean;
  restored?: boolean;
  skippedUnchanged: boolean;
  state: BackupState;
  errorCode: BackupErrorCode;
}

export interface BackupScheduler {
  start(): Promise<void>;
  stop(): void;
  notifyDataChanged(): void;
  notifyAppStateChange(nextAppState: string): Promise<void>;
  notifyNetworkAvailable(): Promise<void>;
  runBackupCycle(options?: { force?: boolean }): Promise<BackupCycleOutcome>;
  refreshState(): Promise<BackupState>;
  getStatus(): BackupRuntimeStatus;
  subscribe(listener: (status: BackupRuntimeStatus) => void): () => void;
}

export function createBackupScheduler(
  deps: BackupSchedulerDependencies,
): BackupScheduler {
  const authService = deps.authService ?? defaultGoogleAuthService;
  const driveClient =
    deps.driveClient ?? createDriveClient({ authService });
  const now = deps.now ?? (() => new Date().toISOString());
  const foregroundIntervalMs =
    deps.foregroundIntervalMs ?? BACKUP_FOREGROUND_INTERVAL_MS;
  const debounceMs = deps.debounceMs ?? BACKUP_DEBOUNCE_MS;

  let currentState: BackupState = { ...DEFAULT_BACKUP_STATE };
  let isUploading = false;
  let started = false;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  let inFlightPromise: Promise<BackupCycleOutcome> | null = null;
  let rerunRequested = false;
  let rerunForce = false;
  let pendingLocalMutationAt: string | null = null;

  const listeners = new Set<(status: BackupRuntimeStatus) => void>();

  function emit() {
    const snapshot: BackupRuntimeStatus = {
      state: currentState,
      isUploading,
      isSupportedRuntime: authService.isSupportedRuntime(),
    };
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function clearTimers() {
    if (intervalTimer !== null) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function canRunAutomatically(state: BackupState): boolean {
    if (!authService.isSupportedRuntime()) return false;
    if (!state.enabled) return false;
    if (isBackupErrorStoppingAutoLoop(state.lastError)) return false;
    return true;
  }

  function syncIntervalTimer() {
    if (!started || !canRunAutomatically(currentState)) {
      if (intervalTimer !== null) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
      return;
    }
    if (intervalTimer === null) {
      intervalTimer = setInterval(() => {
        void runBackupCycle({ force: false });
      }, foregroundIntervalMs);
    }
  }

  async function executeSingleCycle(options?: {
    force?: boolean;
  }): Promise<BackupCycleOutcome> {
    const force = options?.force === true;

    if (!authService.isSupportedRuntime()) {
      return {
        uploaded: false,
        skippedUnchanged: false,
        state: currentState,
        errorCode: 'expo_go_unsupported',
      };
    }

    // Step 1: Read state & build snapshot inside withDatabase (zero network I/O)
    const dbPrep = await deps.runWithDatabase(async (db) => {
      const state = await readBackupState(db);
      if (!state.enabled && !force) {
        return {
          shouldUpload: false as const,
          skippedUnchanged: false,
          state,
          snapshot: null as BackupSnapshot | null,
        };
      }
      if (!force && isBackupErrorStoppingAutoLoop(state.lastError)) {
        return {
          shouldUpload: false as const,
          skippedUnchanged: false,
          state,
          snapshot: null as BackupSnapshot | null,
        };
      }

      const snapshot = await buildSnapshot(db, {
        createdAt: now(),
        hashPort: deps.hashPort,
      });

      const isUnchanged =
        !force &&
        !state.dirty &&
        state.lastUploadedHash !== null &&
        state.lastUploadedHash.toLowerCase() ===
          snapshot.checksum.toLowerCase();

      if (isUnchanged) {
        return {
          shouldUpload: false as const,
          skippedUnchanged: true,
          checkRemoteForPull: true as const,
          state,
          snapshot: null as BackupSnapshot | null,
        };
      }

      // Persist dirty = true and local mutation timestamp before network I/O
      const localMutationAt =
        pendingLocalMutationAt ?? state.lastLocalMutationAt ?? now();
      const dirtyState = await updateBackupState(db, {
        dirty: true,
        lastLocalMutationAt: localMutationAt,
      });
      return {
        shouldUpload: true as const,
        skippedUnchanged: false,
        state: dirtyState,
        snapshot,
      };
    });

    currentState = dbPrep.state;
    syncIntervalTimer();
    emit();

    if (!dbPrep.shouldUpload || !dbPrep.snapshot) {
      let restored = false;
      if (
        'checkRemoteForPull' in dbPrep &&
        dbPrep.checkRemoteForPull &&
        deps.onRemoteNewerDetected
      ) {
        const remoteMeta = await driveClient.fetchRemoteBackupMetadata({
          cachedFileId: currentState.remoteFileId,
        });
        if (
          remoteMeta.ok &&
          remoteMeta.found &&
          remoteMeta.metadata.sha256 &&
          remoteMeta.metadata.sha256.toLowerCase() !==
            currentState.lastUploadedHash?.toLowerCase()
        ) {
          restored = await deps.onRemoteNewerDetected(
            remoteMeta.metadata.fileId,
            remoteMeta.metadata.sha256,
          );
          currentState = await deps.runWithDatabase((db) => readBackupState(db));
          emit();
        }
      }
      return {
        uploaded: false,
        restored,
        skippedUnchanged: dbPrep.skippedUnchanged,
        state: currentState,
        errorCode: currentState.lastError,
      };
    }

    // Step 1.5: Last-Write-Wins conflict check before automatic upload
    if (
      !force &&
      deps.onRemoteNewerDetected &&
      (currentState.lastUploadedHash !== null ||
        currentState.remoteFileId !== null)
    ) {
      const remoteMeta = await driveClient.fetchRemoteBackupMetadata({
        cachedFileId: currentState.remoteFileId,
      });
      if (!remoteMeta.ok) {
        currentState = await deps.runWithDatabase((db) =>
          updateBackupState(db, {
            lastError: remoteMeta.errorCode,
            dirty: true,
          }),
        );
        syncIntervalTimer();
        emit();
        return {
          uploaded: false,
          restored: false,
          skippedUnchanged: false,
          state: currentState,
          errorCode: remoteMeta.errorCode,
        };
      }
      if (remoteMeta.found && remoteMeta.metadata.sha256) {
        const remoteHash = remoteMeta.metadata.sha256.toLowerCase();
        const localHash = dbPrep.snapshot.checksum.toLowerCase();
        if (remoteHash === localHash) {
          pendingLocalMutationAt = null;
          currentState = await deps.runWithDatabase((db) =>
            updateBackupState(db, {
              remoteFileId: remoteMeta.metadata.fileId,
              lastUploadedHash: remoteMeta.metadata.sha256,
              lastSuccessAt:
                remoteMeta.metadata.modifiedTime ??
                remoteMeta.metadata.createdAt ??
                now(),
              lastError: null,
              dirty: false,
              lastLocalMutationAt: null,
            }),
          );
          syncIntervalTimer();
          emit();
          return {
            uploaded: false,
            restored: false,
            skippedUnchanged: true,
            state: currentState,
            errorCode: null,
          };
        }
        const remoteChangedSinceLastSync =
          currentState.lastUploadedHash !== null &&
          remoteHash !== currentState.lastUploadedHash.toLowerCase();
        if (remoteChangedSinceLastSync) {
          const remoteTimeMs = Date.parse(
            remoteMeta.metadata.modifiedTime ??
              remoteMeta.metadata.createdAt ??
              '',
          );
          const localTimeMs = Date.parse(
            currentState.lastLocalMutationAt ??
              currentState.lastSuccessAt ??
              '',
          );
          const remoteIsNewer =
            Number.isFinite(remoteTimeMs) &&
            (!Number.isFinite(localTimeMs) || remoteTimeMs > localTimeMs);
          if (remoteIsNewer) {
            const restored = await deps.onRemoteNewerDetected(
              remoteMeta.metadata.fileId,
              remoteMeta.metadata.sha256,
            );
            pendingLocalMutationAt = null;
            currentState = await deps.runWithDatabase((db) =>
              readBackupState(db),
            );
            syncIntervalTimer();
            emit();
            return {
              uploaded: false,
              restored,
              skippedUnchanged: false,
              state: currentState,
              errorCode: currentState.lastError,
            };
          }
        }
      }
    }

    // Step 2: Upload to Google Drive outside withDatabase
    isUploading = true;
    emit();

    let uploadRes: DriveUploadResult;
    try {
      uploadRes = await driveClient.uploadSnapshot(dbPrep.snapshot, {
        cachedFolderId: currentState.remoteFolderId,
        cachedFileId: currentState.remoteFileId,
      });
    } finally {
      isUploading = false;
    }

    // Step 3: Persist outcome in withDatabase
    if (uploadRes.ok) {
      pendingLocalMutationAt = null;
      const successAt = now();
      currentState = await deps.runWithDatabase((db) =>
        updateBackupState(db, {
          remoteFolderId: uploadRes.folderId,
          remoteFileId: uploadRes.fileId,
          lastUploadedHash: uploadRes.sha256,
          lastSuccessAt: successAt,
          lastError: null,
          dirty: false,
          lastLocalMutationAt: null,
        }),
      );
      syncIntervalTimer();
      emit();
      return {
        uploaded: true,
        skippedUnchanged: false,
        state: currentState,
        errorCode: null,
      };
    } else {
      currentState = await deps.runWithDatabase((db) =>
        updateBackupState(db, {
          lastError: uploadRes.errorCode,
          dirty: true,
        }),
      );
      syncIntervalTimer();
      emit();
      return {
        uploaded: false,
        skippedUnchanged: false,
        state: currentState,
        errorCode: uploadRes.errorCode,
      };
    }
  }

  async function runBackupCycle(options?: {
    force?: boolean;
  }): Promise<BackupCycleOutcome> {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (inFlightPromise) {
      rerunRequested = true;
      rerunForce = rerunForce || options?.force === true;
      return inFlightPromise;
    }

    const runLoop = async (): Promise<BackupCycleOutcome> => {
      let outcome = await executeSingleCycle(options);
      while (rerunRequested) {
        const nextForce = rerunForce;
        rerunRequested = false;
        rerunForce = false;
        if (!nextForce && !canRunAutomatically(currentState)) {
          break;
        }
        outcome = await executeSingleCycle({ force: nextForce });
      }
      return outcome;
    };

    inFlightPromise = runLoop().finally(() => {
      inFlightPromise = null;
    });

    return inFlightPromise;
  }

  async function refreshState(): Promise<BackupState> {
    currentState = await deps.runWithDatabase((db) => readBackupState(db));
    syncIntervalTimer();
    emit();
    return currentState;
  }

  return {
    async start(): Promise<void> {
      started = true;
      await refreshState();
      if (canRunAutomatically(currentState)) {
        void runBackupCycle({ force: false });
      }
    },

    stop(): void {
      started = false;
      rerunRequested = false;
      rerunForce = false;
      clearTimers();
    },

    notifyDataChanged(): void {
      pendingLocalMutationAt = now();
      if (!canRunAutomatically(currentState)) return;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void runBackupCycle({ force: false });
      }, debounceMs);
    },

    async notifyAppStateChange(nextAppState: string): Promise<void> {
      await refreshState();
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        if (canRunAutomatically(currentState)) {
          await runBackupCycle({ force: false });
        }
      } else if (nextAppState === 'active') {
        if (currentState.enabled && currentState.lastError === 'network_error') {
          currentState = await deps.runWithDatabase((db) =>
            updateBackupState(db, { lastError: null }),
          );
        }
        syncIntervalTimer();
        if (canRunAutomatically(currentState)) {
          await runBackupCycle({ force: false });
        }
      }
    },

    async notifyNetworkAvailable(): Promise<void> {
      await refreshState();
      if (!currentState.enabled) return;
      if (isBackupErrorStoppingAutoLoop(currentState.lastError)) return;
      if (currentState.lastError === 'network_error') {
        currentState = await deps.runWithDatabase((db) =>
          updateBackupState(db, { lastError: null }),
        );
      }
      if (canRunAutomatically(currentState)) {
        await runBackupCycle({ force: false });
      }
    },

    runBackupCycle,
    refreshState,

    getStatus(): BackupRuntimeStatus {
      return {
        state: currentState,
        isUploading,
        isSupportedRuntime: authService.isSupportedRuntime(),
      };
    },

    subscribe(listener: (status: BackupRuntimeStatus) => void): () => void {
      listeners.add(listener);
      listener({
        state: currentState,
        isUploading,
        isSupportedRuntime: authService.isSupportedRuntime(),
      });
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
