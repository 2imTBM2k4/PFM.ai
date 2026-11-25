import { describe, expect, it, vi } from 'vitest';
import { createGoogleAuthService, GOOGLE_DRIVE_FILE_SCOPE } from './google-auth';
import { createWebGoogleSignInDriver } from './google-auth-web';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe('Web Google Sign-In Driver (GIS OAuth2)', () => {
  it('persists token across page reloads in sessionStorage and never opens a background popup on expiry', async () => {
    const revoke = vi.fn();
    const requestAccessToken = vi.fn();
    const storage = createMemoryStorage();
    let currentTime = 1_000_000;

    const loadGisOAuth2 = async () => ({
      initTokenClient: ({ callback }: { callback: (r: { access_token: string; expires_in: number; scope: string }) => void }) => ({
        requestAccessToken: () => {
          requestAccessToken();
          callback({
            access_token: 'ya29.web-drive-token',
            expires_in: 3600,
            scope: `email profile ${GOOGLE_DRIVE_FILE_SCOPE}`,
          });
        },
      }),
      revoke,
    });

    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ email: 'webuser@example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const driver1 = createWebGoogleSignInDriver({
      now: () => currentTime,
      storage,
      loadGisOAuth2,
      fetchImpl,
    });

    const auth1 = createGoogleAuthService({
      isExpoGo: () => false,
      getWebClientId: () => 'web-client-123.apps.googleusercontent.com',
      getIosClientId: () => undefined,
      loadDriver: () => driver1,
    });

    expect(await auth1.signIn()).toEqual({
      ok: true,
      email: 'webuser@example.com',
      accessToken: 'ya29.web-drive-token',
    });
    expect(requestAccessToken).toHaveBeenCalledTimes(1);

    // Simulate page reload: fresh driver instance reuses persisted sessionStorage token without opening popup
    const driver2 = createWebGoogleSignInDriver({
      now: () => currentTime + 10_000,
      storage,
      loadGisOAuth2,
      fetchImpl,
    });
    const auth2 = createGoogleAuthService({
      isExpoGo: () => false,
      getWebClientId: () => 'web-client-123.apps.googleusercontent.com',
      getIosClientId: () => undefined,
      loadDriver: () => driver2,
    });

    expect(await auth2.getAccessToken()).toEqual({
      ok: true,
      accessToken: 'ya29.web-drive-token',
    });
    expect(requestAccessToken).toHaveBeenCalledTimes(1);

    // After expiry -> returns needs_reauth without triggering an unexpected background popup
    currentTime += 3_700_000;
    expect(await auth2.getAccessToken()).toEqual({
      ok: false,
      reason: 'needs_reauth',
    });
    expect(requestAccessToken).toHaveBeenCalledTimes(1);

    await auth2.signOut();
    expect(revoke).toHaveBeenCalledWith('ya29.web-drive-token');
    expect(storage.length).toBe(0);
  });

  it('returns not_configured when webClientId is missing and cancelled when popup is closed', async () => {
    const missingClientDriver = createWebGoogleSignInDriver({
      storage: createMemoryStorage(),
      loadGisOAuth2: async () => {
        throw new Error('should not load GIS');
      },
    });
    const authMissing = createGoogleAuthService({
      isExpoGo: () => false,
      getWebClientId: () => undefined,
      getIosClientId: () => undefined,
      loadDriver: () => missingClientDriver,
    });
    expect(await authMissing.signIn()).toEqual({
      ok: false,
      reason: 'not_configured',
    });

    const cancelledDriver = createWebGoogleSignInDriver({
      storage: createMemoryStorage(),
      loadGisOAuth2: async () => ({
        initTokenClient: ({ error_callback }) => ({
          requestAccessToken: () => {
            error_callback?.({ type: 'popup_closed' });
          },
        }),
      }),
    });
    const authCancelled = createGoogleAuthService({
      isExpoGo: () => false,
      getWebClientId: () => 'web-client-123.apps.googleusercontent.com',
      getIosClientId: () => undefined,
      loadDriver: () => cancelledDriver,
    });
    expect(await authCancelled.signIn()).toEqual({
      ok: false,
      reason: 'cancelled',
    });
  });
});
