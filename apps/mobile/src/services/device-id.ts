import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

export const DEVICE_ID_STORAGE_KEY = 'pfm_device_id_v1';

let inMemoryDeviceId: string | null = null;

/**
 * Retrieves the persistent unique device ID from SecureStore (iOS Keychain / Android Keystore),
 * or generates and persists a new UUID v4 if not already set.
 * Falls back to an in-memory UUID if SecureStore is unavailable so the app never crashes.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  if (inMemoryDeviceId) {
    return inMemoryDeviceId;
  }

  try {
    const existing = await SecureStore.getItemAsync(DEVICE_ID_STORAGE_KEY);
    if (existing && existing.trim().length > 0) {
      inMemoryDeviceId = existing.trim();
      return inMemoryDeviceId;
    }

    const newId = Crypto.randomUUID();
    try {
      await SecureStore.setItemAsync(DEVICE_ID_STORAGE_KEY, newId);
    } catch {
      // Non-fatal if setting fails; still keep in memory
    }
    inMemoryDeviceId = newId;
    return inMemoryDeviceId;
  } catch {
    // If SecureStore throws (e.g. web, unsupported platform, keychain locked)
    if (!inMemoryDeviceId) {
      inMemoryDeviceId = Crypto.randomUUID();
    }
    return inMemoryDeviceId;
  }
}

/**
 * Resets the in-memory cache for unit testing.
 */
export function resetDeviceIdForTesting(): void {
  inMemoryDeviceId = null;
}
