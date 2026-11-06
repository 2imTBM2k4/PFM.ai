import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {
  DEVICE_ID_STORAGE_KEY,
  getOrCreateDeviceId,
  resetDeviceIdForTesting,
} from './device-id';

vi.mock('expo-secure-store', () => {
  let store = new Map<string, string>();
  return {
    getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    __clearStore: () => store.clear(),
  };
});

vi.mock('expo-crypto', () => ({
  randomUUID: vi.fn(() => '11111111-2222-3333-4444-555555555555'),
}));

describe('getOrCreateDeviceId', () => {
  beforeEach(() => {
    resetDeviceIdForTesting();
    (SecureStore as unknown as { __clearStore(): void }).__clearStore();
    vi.clearAllMocks();
  });

  it('generates, saves and returns a new UUID on first launch', async () => {
    const id = await getOrCreateDeviceId();
    expect(id).toBe('11111111-2222-3333-4444-555555555555');
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(DEVICE_ID_STORAGE_KEY);
    expect(Crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      DEVICE_ID_STORAGE_KEY,
      '11111111-2222-3333-4444-555555555555',
    );
  });

  it('reuses existing device UUID from SecureStore when present', async () => {
    await SecureStore.setItemAsync(DEVICE_ID_STORAGE_KEY, 'existing-uuid-1234');
    vi.clearAllMocks();

    const id = await getOrCreateDeviceId();
    expect(id).toBe('existing-uuid-1234');
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(DEVICE_ID_STORAGE_KEY);
    expect(Crypto.randomUUID).not.toHaveBeenCalled();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('falls back safely to in-memory ID if SecureStore fails', async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(
      new Error('KeyStore failure'),
    );

    const id = await getOrCreateDeviceId();
    expect(id).toBe('11111111-2222-3333-4444-555555555555');
    // Calling again returns the cached in-memory ID without crashing
    const secondCallId = await getOrCreateDeviceId();
    expect(secondCallId).toBe('11111111-2222-3333-4444-555555555555');
  });
});
