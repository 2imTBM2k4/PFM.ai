import { bytesToHex } from '@noble/hashes/utils.js';
import { getRandomValues } from 'expo-crypto';
import { File } from 'expo-file-system';
import { defaultDatabaseDirectory } from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';

export const ENCRYPTED_DATABASE_NAME = 'pfm-encrypted.db';
export const ENCRYPTED_SNAPSHOT_NAME = 'pfm-encrypted-migration.db';
export const NATIVE_PIN_KEY = 'pfm.native.pin.v1';
export const NATIVE_PIN_PROBE_KEY = 'pfm.native.pin.probe';
const DATABASE_KEY = 'pfm.database.key.v1';
export const nativeStorageOptions: SecureStore.SecureStoreOptions = {
  keychainService: 'pfm.native.storage',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};

let preparing: Promise<string> | undefined;

/** Checks the SQLite directory without opening or creating a database. */
export function databaseFileExists(name: string) {
  return new File(defaultDatabaseDirectory, name).exists;
}

/** Deletes a closed encrypted database and its journals during an explicit reset or snapshot cleanup. */
export function deleteEncryptedDatabaseFiles(
  name: typeof ENCRYPTED_DATABASE_NAME | typeof ENCRYPTED_SNAPSHOT_NAME,
) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = new File(defaultDatabaseDirectory, name + suffix);
    if (file.exists) file.delete();
  }
}

/** Includes journal files so an incomplete deletion cannot be mistaken for a fresh install. */
function hasEncryptedFiles() {
  return [ENCRYPTED_DATABASE_NAME, ENCRYPTED_SNAPSHOT_NAME].some((name) =>
    ['', '-wal', '-shm', '-journal'].some((suffix) =>
      databaseFileExists(name + suffix),
    ),
  );
}

/** Creates a key only for a new installation and never replaces a key for existing data. */
async function prepareKey() {
  let stored: string | null;
  try {
    stored = await SecureStore.getItemAsync(DATABASE_KEY, nativeStorageOptions);
  } catch {
    throw new Error('DATABASE_KEY_UNAVAILABLE');
  }
  if (hasEncryptedFiles()) {
    if (stored === null) throw new Error('DATABASE_KEY_MISSING');
    if (!/^[a-f0-9]{64}$/.test(stored)) throw new Error('DATABASE_KEY_INVALID');
    return stored;
  }
  try {
    // Keychain can survive uninstall; an empty installation must not inherit its old key or PIN.
    const key = bytesToHex(getRandomValues(new Uint8Array(32)));
    await SecureStore.setItemAsync(DATABASE_KEY, key, nativeStorageOptions);
    if (
      (await SecureStore.getItemAsync(DATABASE_KEY, nativeStorageOptions)) !==
      key
    )
      throw new Error('KEY_READBACK_FAILED');
    await SecureStore.deleteItemAsync(NATIVE_PIN_KEY, nativeStorageOptions);
    await SecureStore.deleteItemAsync(
      NATIVE_PIN_PROBE_KEY,
      nativeStorageOptions,
    );
    return key;
  } catch {
    throw new Error('DATABASE_KEY_UNAVAILABLE');
  }
}

/** Shares key preparation between database initialization and the PIN gate. */
export function getDatabaseKey() {
  preparing ??= prepareKey().catch((error: unknown) => {
    preparing = undefined;
    throw error;
  });
  return preparing;
}

/** Removes the encryption key only after explicit deletion of every encrypted database file. */
export async function deleteDatabaseKey() {
  if (hasEncryptedFiles()) throw new Error('DATABASE_DELETE_INCOMPLETE');
  try {
    await SecureStore.deleteItemAsync(DATABASE_KEY, nativeStorageOptions);
    preparing = undefined;
  } catch {
    throw new Error('DATABASE_KEY_UNAVAILABLE');
  }
}
