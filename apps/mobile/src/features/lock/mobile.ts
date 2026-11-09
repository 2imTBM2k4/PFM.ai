import { bytesToHex } from '@noble/hashes/utils.js';
import { getRandomValues } from 'expo-crypto';
import { isRunningInExpoGo } from 'expo';
import * as SecureStore from 'expo-secure-store';
import { useStore } from 'zustand';
import { derivePinVerifier } from './kdf';
import { PinLock } from './service';
import { createLockSession } from './session';
import { logAppEvent } from '../../services/logger';
import {
  getDatabaseKey,
  NATIVE_PIN_KEY,
  NATIVE_PIN_PROBE_KEY,
  nativeStorageOptions,
} from '../../data/native-storage';

const nativeStorage = !isRunningInExpoGo() && process.env.EXPO_OS !== 'web';
const PIN_KEY = nativeStorage ? NATIVE_PIN_KEY : 'pfm.preview.pin.v1';
const PROBE_KEY = nativeStorage
  ? NATIVE_PIN_PROBE_KEY
  : 'pfm.preview.pin.probe';
const options: SecureStore.SecureStoreOptions = nativeStorage
  ? nativeStorageOptions
  : {
      keychainService: 'pfm.preview.lock',
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      requireAuthentication: false,
    };

// Emit bounded diagnostic categories, never native errors or their arguments.
async function stored<T>(
  operation: 'READ' | 'WRITE' | 'DELETE',
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const nativeReason = /interaction is not allowed/i.test(message)
      ? 'INTERACTION_NOT_ALLOWED'
      : /parameters.*not valid|invalid.*parameter/i.test(message)
        ? 'INVALID_PARAMETERS'
        : /entitlement/i.test(message)
          ? 'MISSING_ENTITLEMENT'
          : /not a function|unavailable|not available|no keychain/i.test(
                message,
              )
            ? 'UNAVAILABLE'
            : 'UNKNOWN';
    const errorCode = `LOCK_STORAGE_${operation}_FAILED`;
    logAppEvent('error', {
      route: 'lock',
      status: 'failed',
      errorCode,
      nativeReason,
    });
    throw new Error(errorCode);
  }
}

export async function checkPinStorage() {
  if (nativeStorage) await getDatabaseKey();
  let failed = false;
  try {
    await stored('WRITE', () =>
      SecureStore.setItemAsync(PROBE_KEY, 'pfm-write-check', options),
    );
    const result = await stored('READ', () =>
      SecureStore.getItemAsync(PROBE_KEY, options),
    );
    if (result !== 'pfm-write-check') {
      logAppEvent('error', {
        route: 'lock',
        status: 'failed',
        errorCode: 'LOCK_STORAGE_PROBE_FAILED',
      });
      throw new Error('LOCK_STORAGE_PROBE_FAILED');
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await stored('DELETE', () =>
        SecureStore.deleteItemAsync(PROBE_KEY, options),
      );
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

export const pinLock = new PinLock(
  {
    get: async () => {
      if (nativeStorage) await getDatabaseKey();
      return stored('READ', () => SecureStore.getItemAsync(PIN_KEY, options));
    },
    set: (value) =>
      stored('WRITE', () => SecureStore.setItemAsync(PIN_KEY, value, options)),
    remove: async () => {
      await stored('DELETE', () =>
        SecureStore.deleteItemAsync(PROBE_KEY, options),
      );
      await stored('DELETE', () =>
        SecureStore.deleteItemAsync(PIN_KEY, options),
      );
    },
    checkWritable: checkPinStorage,
  },
  async (pin, salt) => {
    const start = performance.now();
    const verifier = await derivePinVerifier(pin, salt);
    logAppEvent('debug', {
      route: 'lock',
      status: 'ready',
      latency: Math.max(0, Math.round(performance.now() - start)),
    });
    return verifier;
  },
  // getRandomValues fails if unavailable; getRandomBytes has a development Math.random fallback.
  () => bytesToHex(getRandomValues(new Uint8Array(32))),
  Date.now,
);

// Owner deferred PIN only in Expo Go after measuring a 44-second derivation.
export const isPinDeferred = isRunningInExpoGo();
export const lockSession = createLockSession(pinLock, Date.now, !isPinDeferred);
export function useLockSession<T>(
  selector: (state: ReturnType<typeof lockSession.getState>) => T,
) {
  return useStore(lockSession, selector);
}
