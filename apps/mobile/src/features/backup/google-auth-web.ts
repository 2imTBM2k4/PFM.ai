import type { NativeGoogleSignInDriver } from './google-auth';

const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const TOKEN_SAFETY_MARGIN_MS = 60_000;
const WEB_SESSION_STORAGE_KEY = 'pfm_google_drive_web_token_v1';

interface PersistedWebToken {
  accessToken: string;
  expiresAt: number;
  email: string | null;
}

function readPersistedWebToken(storage: Storage | null | undefined): PersistedWebToken | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(WEB_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedWebToken>;
    if (
      typeof parsed.accessToken === 'string' &&
      parsed.accessToken.length > 0 &&
      typeof parsed.expiresAt === 'number' &&
      Number.isFinite(parsed.expiresAt)
    ) {
      return {
        accessToken: parsed.accessToken,
        expiresAt: parsed.expiresAt,
        email: typeof parsed.email === 'string' ? parsed.email : null,
      };
    }
  } catch {
    // Ignore storage read errors
  }
  return null;
}

function writePersistedWebToken(
  storage: Storage | null | undefined,
  token: PersistedWebToken | null,
): void {
  if (!storage) return;
  try {
    if (!token) {
      storage.removeItem(WEB_SESSION_STORAGE_KEY);
    } else {
      storage.setItem(WEB_SESSION_STORAGE_KEY, JSON.stringify(token));
    }
  } catch {
    // Ignore storage quota/privacy errors
  }
}

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken(options?: { prompt?: string }): void;
}

interface GisOAuth2Namespace {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: GisTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): GisTokenClient;
  revoke?(token: string, done?: () => void): void;
}

interface GisWindow {
  google?: {
    accounts?: {
      oauth2?: GisOAuth2Namespace;
    };
  };
}

export interface WebGoogleSignInDeps {
  loadGisOAuth2?: () => Promise<GisOAuth2Namespace>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  storage?: Storage | null;
}

let gisLoadPromise: Promise<GisOAuth2Namespace> | null = null;

/** Loads Google Identity Services script once in browser environments. */
export function loadBrowserGisOAuth2(): Promise<GisOAuth2Namespace> {
  const win = globalThis as unknown as GisWindow;
  const existing = win.google?.accounts?.oauth2;
  if (existing) {
    return Promise.resolve(existing);
  }
  if (gisLoadPromise) {
    return gisLoadPromise;
  }
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('WEB_BROWSER_UNAVAILABLE'));
  }

  gisLoadPromise = new Promise<GisOAuth2Namespace>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const oauth2 = win.google?.accounts?.oauth2;
      if (oauth2) {
        resolve(oauth2);
      } else {
        gisLoadPromise = null;
        reject(new Error('GIS_OAUTH2_UNAVAILABLE'));
      }
    };
    script.onerror = () => {
      gisLoadPromise = null;
      reject(new Error('network_error'));
    };
    document.head.appendChild(script);
  });

  return gisLoadPromise;
}

/**
 * Browser implementation of NativeGoogleSignInDriver backed by Google Identity Services (GIS)
 * OAuth2 Token Client so Web shares the same Google Drive backup and sync pipeline as iOS/Android.
 */
export function createWebGoogleSignInDriver(
  deps: WebGoogleSignInDeps = {},
): NativeGoogleSignInDriver {
  const loadGisOAuth2 = deps.loadGisOAuth2 ?? loadBrowserGisOAuth2;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const storage =
    deps.storage !== undefined
      ? deps.storage
      : typeof sessionStorage !== 'undefined'
        ? sessionStorage
        : null;

  let webClientId: string | undefined;
  let configuredScopes: string[] = [];
  const restored = readPersistedWebToken(storage);
  let cachedToken: string | null = restored?.accessToken ?? null;
  let cachedTokenExpiresAt = restored?.expiresAt ?? 0;
  let cachedEmail: string | null = restored?.email ?? null;

  async function requestToken(
    scopes: string[],
    prompt: string,
  ): Promise<{ accessToken: string; grantedScopes: string[] }> {
    if (!webClientId) {
      throw { code: 'configure', message: 'webClientId was not provided' };
    }
    const oauth2 = await loadGisOAuth2();
    const mergedScopes = Array.from(
      new Set(['email', 'profile', ...configuredScopes, ...scopes]),
    );

    const response = await new Promise<GisTokenResponse>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: webClientId!,
        scope: mergedScopes.join(' '),
        callback: (res) => resolve(res),
        error_callback: (err) => {
          if (err?.type === 'popup_closed') {
            reject({ code: 'SIGN_IN_CANCELLED', message: 'popup_closed' });
            return;
          }
          reject({
            code: err?.type ?? 'unknown',
            message: err?.message ?? 'GIS token request failed',
          });
        },
      });
      client.requestAccessToken({ prompt });
    });

    if (response.error) {
      if (response.error === 'access_denied') {
        throw { code: 'SIGN_IN_CANCELLED', message: response.error };
      }
      throw {
        code: response.error,
        message: response.error_description ?? response.error,
      };
    }

    if (!response.access_token) {
      throw { code: 'SIGN_IN_REQUIRED', message: 'Missing access_token' };
    }

    const expiresSec = Number(response.expires_in ?? 3600);
    cachedToken = response.access_token;
    cachedTokenExpiresAt =
      now() + (Number.isFinite(expiresSec) && expiresSec > 0 ? expiresSec : 3600) * 1000;
    writePersistedWebToken(storage, {
      accessToken: cachedToken,
      expiresAt: cachedTokenExpiresAt,
      email: cachedEmail,
    });

    const grantedScopes =
      typeof response.scope === 'string' && response.scope.trim()
        ? response.scope.trim().split(/\s+/)
        : mergedScopes;

    return { accessToken: response.access_token, grantedScopes };
  }

  async function fetchEmail(accessToken: string): Promise<string | null> {
    try {
      const res = await fetchImpl(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return cachedEmail;
      const body = (await res.json()) as { email?: unknown };
      if (typeof body.email === 'string' && body.email.trim()) {
        cachedEmail = body.email.trim();
        if (cachedToken) {
          writePersistedWebToken(storage, {
            accessToken: cachedToken,
            expiresAt: cachedTokenExpiresAt,
            email: cachedEmail,
          });
        }
        return cachedEmail;
      }
    } catch {
      // Best-effort profile lookup
    }
    return cachedEmail;
  }

  return {
    configure(options) {
      webClientId = options.webClientId?.trim() || undefined;
      configuredScopes = options.scopes ?? [];
    },

    async hasPlayServices() {
      return true;
    },

    async signIn() {
      const { accessToken, grantedScopes } = await requestToken(
        configuredScopes,
        'select_account',
      );
      const email = await fetchEmail(accessToken);
      return {
        type: 'success',
        data: {
          user: { email: email ?? '' },
          scopes: grantedScopes,
        },
      };
    },

    async addScopes(options) {
      const { accessToken, grantedScopes } = await requestToken(
        options.scopes,
        'consent',
      );
      const email = cachedEmail ?? (await fetchEmail(accessToken));
      return {
        type: 'success',
        data: {
          user: { email: email ?? '' },
          scopes: grantedScopes,
        },
      };
    },

    // Never trigger an unexpected GIS OAuth popup in the background on Web.
    async signInSilently() {
      const stored = readPersistedWebToken(storage);
      if (
        stored &&
        now() + TOKEN_SAFETY_MARGIN_MS < stored.expiresAt
      ) {
        cachedToken = stored.accessToken;
        cachedTokenExpiresAt = stored.expiresAt;
        cachedEmail = stored.email;
        return {
          type: 'success',
          data: {
            user: { email: stored.email ?? '' },
            scopes: configuredScopes,
          },
        };
      }
      throw { code: 'SIGN_IN_REQUIRED', message: 'Interactive web sign-in required' };
    },

    async getTokens() {
      if (cachedToken && now() + TOKEN_SAFETY_MARGIN_MS < cachedTokenExpiresAt) {
        return { accessToken: cachedToken };
      }
      throw { code: 'SIGN_IN_REQUIRED', message: 'Web access token expired' };
    },

    async clearCachedAccessToken() {
      cachedToken = null;
      cachedTokenExpiresAt = 0;
      writePersistedWebToken(storage, null);
    },

    async signOut() {
      const tokenToRevoke = cachedToken;
      cachedToken = null;
      cachedTokenExpiresAt = 0;
      cachedEmail = null;
      writePersistedWebToken(storage, null);
      if (!tokenToRevoke) return;
      try {
        const oauth2 = await loadGisOAuth2();
        oauth2.revoke?.(tokenToRevoke);
      } catch {
        // Best-effort revoke
      }
    },
  };
}
