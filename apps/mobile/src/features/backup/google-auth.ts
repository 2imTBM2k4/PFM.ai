import type { Queries } from '@/data/migrate';

export const BACKUP_STATE_SETTING_KEY = 'backup_state_v1' as const;
export const GOOGLE_DRIVE_FILE_SCOPE =
  'https://www.googleapis.com/auth/drive.file' as const;

export type BackupErrorCode =
  | 'needs_reauth'
  | 'drive_quota_exceeded'
  | 'network_error'
  | 'verify_failed'
  | 'schema_newer_than_app'
  | 'upload_failed'
  | 'play_services_unavailable'
  | 'not_configured'
  | 'expo_go_unsupported'
  | null;

export type GoogleAuthErrorReason =
  | 'cancelled'
  | 'play_services_unavailable'
  | 'network_error'
  | 'needs_reauth'
  | 'not_configured'
  | 'expo_go_unsupported'
  | 'unknown';

export interface BackupState {
  enabled: boolean;
  accountEmail: string | null;
  lastSuccessAt: string | null;
  lastError: BackupErrorCode;
  remoteFolderId: string | null;
  remoteFileId: string | null;
  lastUploadedHash: string | null;
  dirty: boolean;
}

export const DEFAULT_BACKUP_STATE: BackupState = {
  enabled: false,
  accountEmail: null,
  lastSuccessAt: null,
  lastError: null,
  remoteFolderId: null,
  remoteFileId: null,
  lastUploadedHash: null,
  dirty: false,
};

const VALID_ERROR_CODES = new Set<BackupErrorCode>([
  'needs_reauth',
  'drive_quota_exceeded',
  'network_error',
  'verify_failed',
  'schema_newer_than_app',
  'upload_failed',
  'play_services_unavailable',
  'not_configured',
  'expo_go_unsupported',
  null,
]);

export function parseBackupState(raw: string | null | undefined): BackupState {
  if (!raw) return { ...DEFAULT_BACKUP_STATE };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_BACKUP_STATE };
    }
    const obj = parsed as Record<string, unknown>;
    const lastError = VALID_ERROR_CODES.has(obj.lastError as BackupErrorCode)
      ? (obj.lastError as BackupErrorCode)
      : null;

    return {
      enabled: obj.enabled === true,
      accountEmail:
        typeof obj.accountEmail === 'string' && obj.accountEmail.trim()
          ? obj.accountEmail.trim()
          : null,
      lastSuccessAt:
        typeof obj.lastSuccessAt === 'string' && obj.lastSuccessAt.trim()
          ? obj.lastSuccessAt.trim()
          : null,
      lastError,
      remoteFolderId:
        typeof obj.remoteFolderId === 'string' && obj.remoteFolderId.trim()
          ? obj.remoteFolderId.trim()
          : null,
      remoteFileId:
        typeof obj.remoteFileId === 'string' && obj.remoteFileId.trim()
          ? obj.remoteFileId.trim()
          : null,
      lastUploadedHash:
        typeof obj.lastUploadedHash === 'string' && obj.lastUploadedHash.trim()
          ? obj.lastUploadedHash.trim()
          : null,
      dirty: obj.dirty === true,
    };
  } catch {
    return { ...DEFAULT_BACKUP_STATE };
  }
}

export async function readBackupState(db: Queries): Promise<BackupState> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    BACKUP_STATE_SETTING_KEY,
  );
  return parseBackupState(row?.value);
}

export async function writeBackupState(
  db: Queries,
  state: BackupState,
): Promise<BackupState> {
  const normalized = parseBackupState(JSON.stringify(state));
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    BACKUP_STATE_SETTING_KEY,
    JSON.stringify(normalized),
  );
  return normalized;
}

export async function updateBackupState(
  db: Queries,
  patch: Partial<BackupState>,
): Promise<BackupState> {
  const current = await readBackupState(db);
  return writeBackupState(db, { ...current, ...patch });
}

export interface NativeGoogleSignInDriver {
  configure(options: {
    scopes?: string[];
    webClientId?: string;
    iosClientId?: string;
  }): void;
  hasPlayServices(options?: {
    showPlayServicesUpdateDialog?: boolean;
  }): Promise<boolean>;
  signIn(): Promise<unknown>;
  signInSilently?(): Promise<unknown>;
  getTokens(): Promise<{ accessToken: string; idToken?: string }>;
  clearCachedAccessToken?(accessToken: string): Promise<null | void>;
  signOut(): Promise<null | void>;
}

export interface GoogleAuthEnvironment {
  isExpoGo(): boolean;
  getWebClientId(): string | undefined;
  getIosClientId(): string | undefined;
  loadDriver(): NativeGoogleSignInDriver | null;
}

function detectExpoGoRuntime(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const expoMod = require('expo') as { isRunningInExpoGo?: () => boolean };
    if (typeof expoMod?.isRunningInExpoGo === 'function') {
      return Boolean(expoMod.isRunningInExpoGo());
    }
  } catch {
    // Fall through to Constants check
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const constantsMod = require('expo-constants') as {
      default?: { appOwnership?: string; executionEnvironment?: string };
      appOwnership?: string;
      executionEnvironment?: string;
    };
    const c = constantsMod?.default ?? constantsMod;
    if (
      c?.appOwnership === 'expo' ||
      c?.executionEnvironment === 'storeClient'
    ) {
      return true;
    }
  } catch {
    // Not in Expo Go
  }
  return false;
}

function loadNativeGoogleSigninDriverSafely(): NativeGoogleSignInDriver | null {
  try {
    // Lazy require so Expo Go never evaluates TurboModuleRegistry.getEnforcing('RNGoogleSignin') at startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('@react-native-google-signin/google-signin') as {
      GoogleSignin?: NativeGoogleSignInDriver;
    };
    return pkg?.GoogleSignin ?? null;
  } catch {
    return null;
  }
}

export const defaultGoogleAuthEnvironment: GoogleAuthEnvironment = {
  isExpoGo: detectExpoGoRuntime,
  getWebClientId: () => {
    const v = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim();
    return v ? v : undefined;
  },
  getIosClientId: () => {
    const v = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim();
    return v ? v : undefined;
  },
  loadDriver: loadNativeGoogleSigninDriverSafely,
};

/**
 * Classifies errors thrown or returned by `@react-native-google-signin/google-signin`.
 */
export function classifyGoogleAuthError(error: unknown): GoogleAuthErrorReason {
  if (!error || typeof error !== 'object') {
    return 'unknown';
  }
  const err = error as { code?: string | number; message?: string };
  const code = String(err.code ?? '').toUpperCase();
  const message = String(err.message ?? '').toLowerCase();

  if (
    code === 'SIGN_IN_CANCELLED' ||
    code === '12501' ||
    code === '-5' ||
    message.includes('cancel')
  ) {
    return 'cancelled';
  }
  if (
    code === 'PLAY_SERVICES_NOT_AVAILABLE' ||
    code.includes('PLAY_SERVICES') ||
    message.includes('play services')
  ) {
    return 'play_services_unavailable';
  }
  if (
    code === 'NETWORK_ERROR' ||
    code === '7' ||
    message.includes('network') ||
    message.includes('internet') ||
    message.includes('offline')
  ) {
    return 'network_error';
  }
  if (
    code === 'SIGN_IN_REQUIRED' ||
    code === '4' ||
    message.includes('sign_in_required') ||
    message.includes('revoked') ||
    message.includes('invalid_grant') ||
    message.includes('token') ||
    message.includes('current user')
  ) {
    return 'needs_reauth';
  }
  if (
    code.includes('DEVELOPER_ERROR') ||
    code === '10' ||
    message.includes('developer_error') ||
    message.includes('not configured')
  ) {
    return 'not_configured';
  }
  return 'unknown';
}

function extractEmailFromSignInResult(result: unknown): {
  cancelled: boolean;
  email: string | null;
} {
  if (!result || typeof result !== 'object') {
    return { cancelled: false, email: null };
  }
  const obj = result as Record<string, unknown>;
  if (obj.type === 'cancelled') {
    return { cancelled: true, email: null };
  }
  // v13+/v16/v17 shape: { type: 'success', data: { user: { email } } }
  if (obj.data && typeof obj.data === 'object') {
    const data = obj.data as Record<string, unknown>;
    if (data.user && typeof data.user === 'object') {
      const user = data.user as Record<string, unknown>;
      if (typeof user.email === 'string' && user.email.trim()) {
        return { cancelled: false, email: user.email.trim() };
      }
    }
  }
  // Legacy shape: { user: { email } }
  if (obj.user && typeof obj.user === 'object') {
    const user = obj.user as Record<string, unknown>;
    if (typeof user.email === 'string' && user.email.trim()) {
      return { cancelled: false, email: user.email.trim() };
    }
  }
  return { cancelled: false, email: null };
}

export type GoogleSignInResult =
  | {
      ok: true;
      email: string;
      accessToken: string;
    }
  | {
      ok: false;
      reason: GoogleAuthErrorReason;
    };

export type GoogleAccessTokenResult =
  | {
      ok: true;
      accessToken: string;
    }
  | {
      ok: false;
      reason: GoogleAuthErrorReason;
    };

export interface GoogleAuthService {
  isSupportedRuntime(): boolean;
  signIn(): Promise<GoogleSignInResult>;
  getAccessToken(options?: {
    forceRefresh?: boolean;
    previousToken?: string;
  }): Promise<GoogleAccessTokenResult>;
  signOut(): Promise<void>;
}

export function createGoogleAuthService(
  env: GoogleAuthEnvironment = defaultGoogleAuthEnvironment,
): GoogleAuthService {
  let configuredDriver: NativeGoogleSignInDriver | null = null;

  function ensureConfiguredDriver():
    | { ok: true; driver: NativeGoogleSignInDriver }
    | { ok: false; reason: GoogleAuthErrorReason } {
    if (env.isExpoGo()) {
      return { ok: false, reason: 'expo_go_unsupported' };
    }
    if (configuredDriver) {
      return { ok: true, driver: configuredDriver };
    }
    const driver = env.loadDriver();
    if (!driver) {
      return { ok: false, reason: 'expo_go_unsupported' };
    }
    try {
      driver.configure({
        scopes: [GOOGLE_DRIVE_FILE_SCOPE],
        webClientId: env.getWebClientId(),
        iosClientId: env.getIosClientId(),
      });
      configuredDriver = driver;
      return { ok: true, driver };
    } catch (error) {
      return { ok: false, reason: classifyGoogleAuthError(error) };
    }
  }

  return {
    isSupportedRuntime(): boolean {
      if (env.isExpoGo()) return false;
      return env.loadDriver() !== null;
    },

    async signIn(): Promise<GoogleSignInResult> {
      const configured = ensureConfiguredDriver();
      if (!configured.ok) {
        return { ok: false, reason: configured.reason };
      }
      const { driver } = configured;
      try {
        await driver.hasPlayServices({ showPlayServicesUpdateDialog: true });
        const signInResponse = await driver.signIn();
        const { cancelled, email } =
          extractEmailFromSignInResult(signInResponse);
        if (cancelled) {
          return { ok: false, reason: 'cancelled' };
        }
        if (!email) {
          return { ok: false, reason: 'unknown' };
        }
        const tokens = await driver.getTokens();
        if (!tokens?.accessToken) {
          return { ok: false, reason: 'needs_reauth' };
        }
        return {
          ok: true,
          email,
          accessToken: tokens.accessToken,
        };
      } catch (error) {
        return { ok: false, reason: classifyGoogleAuthError(error) };
      }
    },

    async getAccessToken(options?: {
      forceRefresh?: boolean;
      previousToken?: string;
    }): Promise<GoogleAccessTokenResult> {
      const configured = ensureConfiguredDriver();
      if (!configured.ok) {
        return { ok: false, reason: configured.reason };
      }
      const { driver } = configured;
      try {
        if (
          options?.forceRefresh &&
          options.previousToken &&
          typeof driver.clearCachedAccessToken === 'function'
        ) {
          await driver.clearCachedAccessToken(options.previousToken);
        }
        try {
          const tokens = await driver.getTokens();
          if (tokens?.accessToken) {
            return { ok: true, accessToken: tokens.accessToken };
          }
        } catch (firstError) {
          const firstReason = classifyGoogleAuthError(firstError);
          if (firstReason === 'network_error') {
            return { ok: false, reason: 'network_error' };
          }
          if (typeof driver.signInSilently === 'function') {
            const silentResponse = await driver.signInSilently();
            const { cancelled } = extractEmailFromSignInResult(silentResponse);
            if (!cancelled) {
              const refreshedTokens = await driver.getTokens();
              if (refreshedTokens?.accessToken) {
                return { ok: true, accessToken: refreshedTokens.accessToken };
              }
            }
          }
          return { ok: false, reason: 'needs_reauth' };
        }
        return { ok: false, reason: 'needs_reauth' };
      } catch (error) {
        const reason = classifyGoogleAuthError(error);
        return {
          ok: false,
          reason: reason === 'network_error' ? 'network_error' : 'needs_reauth',
        };
      }
    },

    async signOut(): Promise<void> {
      const configured = ensureConfiguredDriver();
      if (!configured.ok) return;
      try {
        await configured.driver.signOut();
      } catch {
        // Best-effort local sign-out
      }
    },
  };
}

export const defaultGoogleAuthService = createGoogleAuthService();
