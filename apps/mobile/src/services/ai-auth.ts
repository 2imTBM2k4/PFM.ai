import {
  defaultGoogleAuthEnvironment,
  GOOGLE_DRIVE_FILE_SCOPE,
  type NativeGoogleSignInDriver,
} from '@/features/backup/google-auth';
import { getOrCreateDeviceId } from './device-id';

export type AIAuth =
  | { mode: 'authenticated'; sub: string; idToken: string }
  | { mode: 'guest'; deviceId: string };
let failedGoogleRefresh: { session: string; account: string } | null = null;

/** Read native Google credentials without persisting tokens or starting an interactive sign-in. */
export async function readAIAuth(
  session: string,
  guestDeviceId?: string,
): Promise<AIAuth> {
  const env = defaultGoogleAuthEnvironment;
  const guest = async (): Promise<AIAuth> => ({
    mode: 'guest',
    deviceId: guestDeviceId ?? (await getOrCreateDeviceId()),
  });
  try {
    if (env.isExpoGo()) return guest();
    const driver = env.loadDriver() as
      | (NativeGoogleSignInDriver & {
          getCurrentUser?: () => { user?: { id?: string } } | null;
        })
      | null;
    const current = driver?.getCurrentUser?.();
    if (!driver || !current) {
      failedGoogleRefresh = null;
      return guest();
    }
    const account = current.user?.id ?? '';
    if (
      failedGoogleRefresh?.session === session &&
      failedGoogleRefresh.account === account
    )
      return guest();
    driver.configure({
      scopes: [GOOGLE_DRIVE_FILE_SCOPE],
      webClientId: env.getWebClientId(),
      iosClientId: env.getIosClientId(),
    });
    const read = async () => {
      const idToken = (await driver.getTokens()).idToken;
      if (!idToken) return null;
      const payload = idToken.split('.')[1];
      const encoded = payload.replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(
        atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')),
      );
      if (
        typeof claims.sub !== 'string' ||
        !claims.sub ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= Date.now() / 1000
      )
        return null;
      return { mode: 'authenticated' as const, sub: claims.sub, idToken };
    };
    let credentials: Awaited<ReturnType<typeof read>> = null;
    try {
      credentials = await read();
    } catch {
      /* Expired native credentials may need silent renewal. */
    }
    if (credentials) return credentials;
    try {
      const renewed = (await driver.signInSilently?.()) as
        { type?: string } | undefined;
      if (
        renewed &&
        renewed.type !== 'noSavedCredentialFound' &&
        renewed.type !== 'cancelled'
      )
        credentials = await read();
      if (credentials) return credentials;
    } catch {
      /* Keep this conversation as guest when renewal is unavailable. */
    }
    failedGoogleRefresh = { session, account };
  } catch {
    /* Unsupported native runtimes keep the existing guest behavior. */
  }
  return guest();
}

export function aiAuthHeaders(auth: AIAuth): Record<string, string> {
  return auth.mode === 'authenticated'
    ? { Authorization: `Bearer ${auth.idToken}` }
    : { 'x-device-id': auth.deviceId };
}
