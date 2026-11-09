import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  expoGo: false,
  value: null as string | null,
  probe: null as string | null,
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  random: vi.fn(),
  log: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock('../../data/native-storage', () => ({
  NATIVE_PIN_KEY: 'pfm.native.pin.v1',
  NATIVE_PIN_PROBE_KEY: 'pfm.native.pin.probe',
  nativeStorageOptions: {
    keychainService: 'pfm.native.storage',
    keychainAccessible: 13,
    requireAuthentication: false,
  },
  getDatabaseKey: native.prepare,
}));
vi.mock('expo', () => ({ isRunningInExpoGo: () => native.expoGo }));
vi.mock('../../services/logger', () => ({ logAppEvent: native.log }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 13,
  getItemAsync: native.get,
  setItemAsync: native.set,
  deleteItemAsync: native.remove,
}));
vi.mock('expo-crypto', () => ({ getRandomValues: native.random }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  native.value = null;
  native.expoGo = false;
  native.probe = null;
  native.get.mockImplementation(async (key: string) =>
    key === 'pfm.native.pin.v1' ? native.value : native.probe,
  );
  native.set.mockImplementation(async (_key, value: string) => {
    if (_key === 'pfm.native.pin.v1') native.value = value;
    else native.probe = value;
  });
  native.remove.mockImplementation(async (key: string) => {
    if (key === 'pfm.native.pin.v1') native.value = null;
    else native.probe = null;
  });
  native.random.mockImplementation((bytes: Uint8Array) => bytes.fill(7));
  native.prepare.mockResolvedValue('07'.repeat(32));
});

it('uses native secure random salt and device-only unlocked storage with no biometric requirement', async () => {
  const { pinLock, lockSession } = await import('./mobile');
  await pinLock.enable('001234');
  expect(native.random).toHaveBeenCalledOnce();
  expect(JSON.parse(native.value!).salt).toBe('07'.repeat(32));
  expect(native.value).not.toContain('001234');
  expect(native.set).toHaveBeenCalledWith(
    'pfm.native.pin.v1',
    expect.any(String),
    {
      keychainService: 'pfm.native.storage',
      keychainAccessible: 13,
      requireAuthentication: false,
    },
  );
  await lockSession.getState().initialize();
  expect(lockSession.getState().status).toBe('locked');
  expect(await lockSession.getState().unlock('001234')).toBe('unlocked');
  await pinLock.resetAfterDataDeletion();
  expect(native.remove).toHaveBeenCalledWith(
    'pfm.native.pin.v1',
    expect.objectContaining({ keychainService: 'pfm.native.storage' }),
  );
  await lockSession.getState().initialize();
  expect(lockSession.getState().status).toBe('unlocked');
}, 15000);

it('never falls back to insecure random values when native randomness fails', async () => {
  native.random.mockImplementationOnce(() => {
    throw new Error('RANDOM_UNAVAILABLE');
  });
  const { pinLock } = await import('./mobile');
  await expect(pinLock.enable('123456')).rejects.toThrow('RANDOM_UNAVAILABLE');
  expect(
    native.set.mock.calls.some(([key]) => key === 'pfm.native.pin.v1'),
  ).toBe(false);
});

it('reports a keychain write rejection safely before starting scrypt', async () => {
  native.set.mockRejectedValueOnce(
    new Error('User interaction is not allowed. SECRET_SENTINEL'),
  );
  const { pinLock } = await import('./mobile');
  await expect(pinLock.enable('123456')).rejects.toThrow(
    'LOCK_STORAGE_WRITE_FAILED',
  );
  expect(native.random).not.toHaveBeenCalled();
  expect(native.log).toHaveBeenCalledWith('error', {
    route: 'lock',
    status: 'failed',
    errorCode: 'LOCK_STORAGE_WRITE_FAILED',
    nativeReason: 'INTERACTION_NOT_ALLOWED',
  });
  expect(JSON.stringify(native.log.mock.calls)).not.toContain(
    'SECRET_SENTINEL',
  );
  expect(native.value).toBeNull();
});

it('does not enroll when write-readback cannot be confirmed and removes the probe', async () => {
  native.get.mockResolvedValue(null);
  const { pinLock } = await import('./mobile');
  await expect(pinLock.enable('123456')).rejects.toThrow(
    'LOCK_STORAGE_PROBE_FAILED',
  );
  expect(native.random).not.toHaveBeenCalled();
  expect(native.value).toBeNull();
  expect(native.probe).toBeNull();
});

it('the standalone storage diagnostic preserves the existing PIN record and never runs the KDF', async () => {
  native.value = 'EXISTING_PIN_RECORD_SENTINEL';
  const { checkPinStorage } = await import('./mobile');
  await checkPinStorage();
  expect(native.value).toBe('EXISTING_PIN_RECORD_SENTINEL');
  expect(native.probe).toBeNull();
  expect(native.random).not.toHaveBeenCalled();
  expect(native.log).not.toHaveBeenCalled();
});

it('Expo Go deferral leaves an existing PIN untouched and opens without secure-store calls or KDF', async () => {
  native.expoGo = true;
  native.value = 'EXISTING_PIN_RECORD_SENTINEL';
  const { lockSession, isPinDeferred } = await import('./mobile');
  expect(isPinDeferred).toBe(true);
  await lockSession.getState().initialize();
  expect(lockSession.getState().status).toBe('unlocked');
  expect(native.value).toBe('EXISTING_PIN_RECORD_SENTINEL');
  expect(native.get).not.toHaveBeenCalled();
  expect(native.set).not.toHaveBeenCalled();
  expect(native.remove).not.toHaveBeenCalled();
  expect(native.random).not.toHaveBeenCalled();
});

it('prepares fresh native storage before reading a surviving Keychain PIN', async () => {
  native.value = 'STALE_PIN_FROM_UNINSTALL';
  native.prepare.mockImplementationOnce(async () => {
    native.value = null;
  });
  const { lockSession } = await import('./mobile');
  await lockSession.getState().initialize();
  expect(native.prepare).toHaveBeenCalledOnce();
  expect(lockSession.getState().status).toBe('unlocked');
});

it('fails closed when native encryption storage cannot be prepared', async () => {
  native.prepare.mockRejectedValueOnce(new Error('DATABASE_KEY_MISSING'));
  const { lockSession } = await import('./mobile');
  await lockSession.getState().initialize();
  expect(lockSession.getState().status).toBe('error');
  expect(native.get).not.toHaveBeenCalled();
});
