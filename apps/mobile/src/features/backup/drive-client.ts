import type { BackupSnapshot } from '@pfm/contracts';
import { logAppEvent } from '@/services/logger';
import {
  defaultGoogleAuthService,
  type BackupErrorCode,
  type GoogleAuthService,
} from './google-auth';

export const DRIVE_FOLDER_NAME = 'PFM.ai' as const;
export const DRIVE_BACKUP_FILENAME = 'pfm-backup-v1.json' as const;
const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

export interface DriveFileResource {
  id: string;
  name?: string;
  size?: string | number;
  modifiedTime?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

export interface RemoteBackupMetadata {
  fileId: string;
  modifiedTime: string | null;
  createdAt: string | null;
  sha256: string | null;
  schemaVersion: number | null;
  formatVersion: number | null;
  txCount: number;
  walletCount: number;
  sizeBytes: number;
}

export type DriveUploadResult =
  | {
      ok: true;
      folderId: string;
      fileId: string;
      sha256: string;
      modifiedTime: string;
    }
  | {
      ok: false;
      errorCode: Exclude<BackupErrorCode, null>;
    };

export type DriveMetadataResult =
  | {
      ok: true;
      found: true;
      metadata: RemoteBackupMetadata;
    }
  | {
      ok: true;
      found: false;
    }
  | {
      ok: false;
      errorCode: Exclude<BackupErrorCode, null>;
    };

export type DriveDownloadResult =
  | {
      ok: true;
      rawSnapshot: unknown;
    }
  | {
      ok: false;
      errorCode: Exclude<BackupErrorCode, null>;
    };

export interface DriveClientDependencies {
  fetchImpl?: typeof fetch;
  authService?: GoogleAuthService;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
  logger?: typeof logAppEvent;
}

export interface DriveClient {
  uploadSnapshot(
    snapshot: BackupSnapshot,
    options?: {
      cachedFolderId?: string | null;
      cachedFileId?: string | null;
    },
  ): Promise<DriveUploadResult>;
  fetchRemoteBackupMetadata(options?: {
    cachedFileId?: string | null;
  }): Promise<DriveMetadataResult>;
  downloadRemoteBackup(fileId: string): Promise<DriveDownloadResult>;
  deleteRemoteBackup(fileId: string): Promise<{ ok: boolean }>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMultipartBody(
  metadata: Record<string, unknown>,
  jsonContent: string,
): { body: string; contentType: string } {
  const boundary = 'pfm_backup_multipart_boundary_v1';
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${jsonContent}\r\n` +
    `--${boundary}--`;
  return {
    body,
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

async function isStorageQuotaExceededResponse(
  response: Response,
): Promise<boolean> {
  try {
    const text = await response.clone().text();
    if (text.includes('storageQuotaExceeded')) {
      return true;
    }
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const errObj = (parsed as Record<string, unknown>).error;
      if (errObj && typeof errObj === 'object') {
        const errors = (errObj as Record<string, unknown>).errors;
        if (Array.isArray(errors)) {
          return errors.some(
            (e) =>
              e &&
              typeof e === 'object' &&
              (e as Record<string, unknown>).reason === 'storageQuotaExceeded',
          );
        }
      }
    }
  } catch {
    // Ignore parse errors
  }
  return false;
}

function selectNewestFile(files: DriveFileResource[]): DriveFileResource {
  return [...files].sort((a, b) => {
    const timeA = a.modifiedTime ? Date.parse(a.modifiedTime) : 0;
    const timeB = b.modifiedTime ? Date.parse(b.modifiedTime) : 0;
    return timeB - timeA;
  })[0]!;
}

export function createDriveClient(
  deps: DriveClientDependencies = {},
): DriveClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const authService = deps.authService ?? defaultGoogleAuthService;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const maxRetries = deps.maxRetries ?? 3;
  const logger = deps.logger ?? logAppEvent;

  type AuthedRequestResult =
    | { ok: true; response: Response }
    | {
        ok: false;
        errorCode: Exclude<BackupErrorCode, null>;
      };

  async function requestWithAuth(
    url: string,
    initFactory: () => RequestInit,
  ): Promise<AuthedRequestResult> {
    const tokenRes = await authService.getAccessToken();
    if (!tokenRes.ok) {
      return {
        ok: false,
        errorCode:
          tokenRes.reason === 'network_error'
            ? 'network_error'
            : tokenRes.reason === 'expo_go_unsupported'
              ? 'expo_go_unsupported'
              : 'needs_reauth',
      };
    }

    let currentToken = tokenRes.accessToken;
    let refreshedAfter401 = false;
    let retryAttempt = 0;

    while (true) {
      let response: Response;
      try {
        const baseInit = initFactory();
        const headers = new Headers(baseInit.headers);
        headers.set('Authorization', `Bearer ${currentToken}`);
        response = await fetchImpl(url, {
          ...baseInit,
          headers,
        });
      } catch {
        if (retryAttempt < maxRetries) {
          const delayMs =
            Math.min(1000 * 2 ** retryAttempt, 4000) +
            Math.floor(random() * 150);
          retryAttempt++;
          await sleep(delayMs);
          continue;
        }
        return { ok: false, errorCode: 'network_error' };
      }

      if (response.status === 401) {
        if (!refreshedAfter401) {
          refreshedAfter401 = true;
          const refreshed = await authService.getAccessToken({
            forceRefresh: true,
            previousToken: currentToken,
          });
          if (!refreshed.ok) {
            return {
              ok: false,
              errorCode:
                refreshed.reason === 'network_error'
                  ? 'network_error'
                  : 'needs_reauth',
            };
          }
          currentToken = refreshed.accessToken;
          continue;
        }
        return { ok: false, errorCode: 'needs_reauth' };
      }

      if (response.status === 403) {
        if (await isStorageQuotaExceededResponse(response)) {
          return { ok: false, errorCode: 'drive_quota_exceeded' };
        }
        return { ok: false, errorCode: 'upload_failed' };
      }

      if (
        response.status === 429 ||
        (response.status >= 500 && response.status <= 599)
      ) {
        if (retryAttempt < maxRetries) {
          const delayMs =
            Math.min(1000 * 2 ** retryAttempt, 4000) +
            Math.floor(random() * 150);
          retryAttempt++;
          await sleep(delayMs);
          continue;
        }
        return {
          ok: false,
          errorCode: 'upload_failed',
        };
      }

      return { ok: true, response };
    }
  }

  async function ensureFolder(
    cachedFolderId?: string | null,
  ): Promise<
    | { ok: true; folderId: string }
    | { ok: false; errorCode: Exclude<BackupErrorCode, null> }
  > {
    if (cachedFolderId) {
      const checkRes = await requestWithAuth(
        `${DRIVE_FILES_API}/${encodeURIComponent(cachedFolderId)}?fields=id,name,trashed`,
        () => ({ method: 'GET' }),
      );
      if (!checkRes.ok) {
        return checkRes;
      }
      if (checkRes.response.status === 200) {
        const folder = (await checkRes.response.json()) as DriveFileResource;
        if (folder?.id && !folder.trashed) {
          return { ok: true, folderId: folder.id };
        }
      }
      // If 404 or trashed, fall through to search by appProperties
    }

    const query =
      "mimeType='application/vnd.google-apps.folder' and appProperties has { key='pfm_kind' and value='backup_folder' } and trashed=false";
    const searchUrl = `${DRIVE_FILES_API}?q=${encodeURIComponent(query)}&orderBy=${encodeURIComponent('modifiedTime desc')}&fields=${encodeURIComponent('files(id,name,modifiedTime,trashed)')}`;
    const searchRes = await requestWithAuth(searchUrl, () => ({
      method: 'GET',
    }));
    if (!searchRes.ok) {
      return searchRes;
    }
    if (!searchRes.response.ok) {
      return { ok: false, errorCode: 'upload_failed' };
    }
    const searchData = (await searchRes.response.json()) as {
      files?: DriveFileResource[];
    };
    const activeFolders = (searchData.files ?? []).filter(
      (f) => f.id && !f.trashed,
    );
    if (activeFolders.length > 0) {
      return { ok: true, folderId: selectNewestFile(activeFolders).id };
    }

    const createRes = await requestWithAuth(
      `${DRIVE_FILES_API}?fields=id`,
      () => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
          name: DRIVE_FOLDER_NAME,
          mimeType: 'application/vnd.google-apps.folder',
          appProperties: { pfm_kind: 'backup_folder' },
        }),
      }),
    );
    if (!createRes.ok) {
      return createRes;
    }
    if (!createRes.response.ok) {
      return { ok: false, errorCode: 'upload_failed' };
    }
    const created = (await createRes.response.json()) as DriveFileResource;
    if (!created?.id) {
      return { ok: false, errorCode: 'upload_failed' };
    }
    return { ok: true, folderId: created.id };
  }

  async function findBackupFile(
    cachedFileId?: string | null,
  ): Promise<
    | { ok: true; file: DriveFileResource | null }
    | { ok: false; errorCode: Exclude<BackupErrorCode, null> }
  > {
    const fields = 'id,name,size,modifiedTime,trashed,appProperties';
    if (cachedFileId) {
      const checkRes = await requestWithAuth(
        `${DRIVE_FILES_API}/${encodeURIComponent(cachedFileId)}?fields=${encodeURIComponent(fields)}`,
        () => ({ method: 'GET' }),
      );
      if (!checkRes.ok) {
        return checkRes;
      }
      if (checkRes.response.status === 200) {
        const file = (await checkRes.response.json()) as DriveFileResource;
        if (file?.id && !file.trashed) {
          return { ok: true, file };
        }
      }
      // If 404 or trashed, fall through to search by appProperties
    }

    const query =
      "appProperties has { key='pfm_kind' and value='backup' } and trashed=false";
    const searchUrl = `${DRIVE_FILES_API}?q=${encodeURIComponent(query)}&orderBy=${encodeURIComponent('modifiedTime desc')}&fields=${encodeURIComponent(`files(${fields})`)}`;
    const searchRes = await requestWithAuth(searchUrl, () => ({
      method: 'GET',
    }));
    if (!searchRes.ok) {
      return searchRes;
    }
    if (!searchRes.response.ok) {
      return { ok: false, errorCode: 'upload_failed' };
    }
    const searchData = (await searchRes.response.json()) as {
      files?: DriveFileResource[];
    };
    const activeFiles = (searchData.files ?? []).filter(
      (f) => f.id && !f.trashed,
    );
    if (activeFiles.length === 0) {
      return { ok: true, file: null };
    }
    if (activeFiles.length > 1) {
      logger('info', {
        route: 'backup',
        status: 'ready',
        action: 'backup_duplicate_files',
      });
    }
    return { ok: true, file: selectNewestFile(activeFiles) };
  }

  function toRemoteBackupMetadata(
    file: DriveFileResource,
  ): RemoteBackupMetadata {
    const props = file.appProperties ?? {};
    const parsedSchema = Number(props.schemaVersion);
    const parsedFormat = Number(props.formatVersion);
    const parsedTx = Number(props.txCount);
    const parsedWallets = Number(props.walletCount);
    const parsedSize = Number(file.size ?? 0);

    return {
      fileId: file.id,
      modifiedTime: file.modifiedTime ?? null,
      createdAt: props.createdAt ?? file.modifiedTime ?? null,
      sha256: props.sha256 ?? null,
      schemaVersion:
        Number.isInteger(parsedSchema) && parsedSchema > 0
          ? parsedSchema
          : null,
      formatVersion:
        Number.isInteger(parsedFormat) && parsedFormat > 0
          ? parsedFormat
          : null,
      txCount: Number.isFinite(parsedTx) && parsedTx >= 0 ? parsedTx : 0,
      walletCount:
        Number.isFinite(parsedWallets) && parsedWallets >= 0
          ? parsedWallets
          : 0,
      sizeBytes: Number.isFinite(parsedSize) && parsedSize >= 0 ? parsedSize : 0,
    };
  }

  return {
    async uploadSnapshot(
      snapshot: BackupSnapshot,
      options?: {
        cachedFolderId?: string | null;
        cachedFileId?: string | null;
      },
    ): Promise<DriveUploadResult> {
      const folderRes = await ensureFolder(options?.cachedFolderId);
      if (!folderRes.ok) {
        return folderRes;
      }
      const folderId = folderRes.folderId;

      const foundRes = await findBackupFile(options?.cachedFileId);
      if (!foundRes.ok) {
        return foundRes;
      }

      const appProperties: Record<string, string> = {
        pfm_kind: 'backup',
        sha256: snapshot.checksum,
        schemaVersion: String(snapshot.schemaVersion),
        formatVersion: String(snapshot.formatVersion),
        createdAt: snapshot.createdAt,
        txCount: String(snapshot.counts.transactions),
        walletCount: String(snapshot.counts.wallets),
      };

      const jsonContent = JSON.stringify(snapshot);
      const uploadFields = 'id,size,modifiedTime,appProperties';

      let targetFileId = foundRes.file?.id ?? null;
      let uploadResponse: Response | null = null;

      if (targetFileId) {
        const multipart = buildMultipartBody(
          {
            name: DRIVE_BACKUP_FILENAME,
            appProperties,
          },
          jsonContent,
        );
        const patchRes = await requestWithAuth(
          `${DRIVE_UPLOAD_API}/${encodeURIComponent(targetFileId)}?uploadType=multipart&fields=${encodeURIComponent(uploadFields)}`,
          () => ({
            method: 'PATCH',
            headers: { 'Content-Type': multipart.contentType },
            body: multipart.body,
          }),
        );
        if (!patchRes.ok) {
          return patchRes;
        }
        if (patchRes.response.status === 404) {
          targetFileId = null;
        } else if (!patchRes.response.ok) {
          return { ok: false, errorCode: 'upload_failed' };
        } else {
          uploadResponse = patchRes.response;
        }
      }

      if (!targetFileId) {
        const multipart = buildMultipartBody(
          {
            name: DRIVE_BACKUP_FILENAME,
            parents: [folderId],
            appProperties,
          },
          jsonContent,
        );
        const postRes = await requestWithAuth(
          `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=${encodeURIComponent(uploadFields)}`,
          () => ({
            method: 'POST',
            headers: { 'Content-Type': multipart.contentType },
            body: multipart.body,
          }),
        );
        if (!postRes.ok) {
          return postRes;
        }
        if (!postRes.response.ok) {
          return { ok: false, errorCode: 'upload_failed' };
        }
        uploadResponse = postRes.response;
      }

      if (!uploadResponse) {
        return { ok: false, errorCode: 'upload_failed' };
      }

      const uploaded = (await uploadResponse.json()) as DriveFileResource;
      const returnedSha256 = uploaded?.appProperties?.sha256;
      const returnedSize = Number(uploaded?.size ?? jsonContent.length);

      // Post-upload verification: sha256 in appProperties and size must be valid before recording success
      if (
        !uploaded?.id ||
        !returnedSha256 ||
        returnedSha256.toLowerCase() !== snapshot.checksum.toLowerCase() ||
        !Number.isFinite(returnedSize) ||
        returnedSize <= 0
      ) {
        logger('error', {
          route: 'backup',
          status: 'failed',
          action: 'backup_upload_failed',
          errorCode: 'BACKUP_VERIFY_FAILED',
        });
        return { ok: false, errorCode: 'verify_failed' };
      }

      return {
        ok: true,
        folderId,
        fileId: uploaded.id,
        sha256: returnedSha256.toLowerCase(),
        modifiedTime: uploaded.modifiedTime ?? new Date().toISOString(),
      };
    },

    async fetchRemoteBackupMetadata(options?: {
      cachedFileId?: string | null;
    }): Promise<DriveMetadataResult> {
      const foundRes = await findBackupFile(options?.cachedFileId);
      if (!foundRes.ok) {
        return foundRes;
      }
      if (!foundRes.file) {
        return { ok: true, found: false };
      }
      return {
        ok: true,
        found: true,
        metadata: toRemoteBackupMetadata(foundRes.file),
      };
    },

    async downloadRemoteBackup(fileId: string): Promise<DriveDownloadResult> {
      const res = await requestWithAuth(
        `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?alt=media`,
        () => ({ method: 'GET' }),
      );
      if (!res.ok) {
        return res;
      }
      if (!res.response.ok) {
        return { ok: false, errorCode: 'upload_failed' };
      }
      try {
        const rawSnapshot: unknown = await res.response.json();
        return { ok: true, rawSnapshot };
      } catch {
        return { ok: false, errorCode: 'verify_failed' };
      }
    },

    async deleteRemoteBackup(fileId: string): Promise<{ ok: boolean }> {
      const res = await requestWithAuth(
        `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}`,
        () => ({ method: 'DELETE' }),
      );
      if (!res.ok) {
        return { ok: false };
      }
      return {
        ok: res.response.ok || res.response.status === 404,
      };
    },
  };
}
