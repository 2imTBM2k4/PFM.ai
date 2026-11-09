import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  files: new Set<string>(),
  values: new Map<string, string>(),
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  random: vi.fn(),
}));
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(
      _directory: string,
      readonly name: string,
    ) {}
    get exists() {
      return native.files.has(this.name);
    }
    delete() {
      native.files.delete(this.name);
    }
  },
}));
vi.mock('expo-sqlite', () => ({ defaultDatabaseDirectory: 'file:///SQLite' }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 13,
  getItemAsync: native.get,
  setItemAsync: native.set,
  deleteItemAsync: native.remove,
}));
vi.mock('expo-crypto', () => ({ getRandomValues: native.random }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  native.files.clear();
  native.values.clear();
  native.get.mockImplementation(
    async (key: string) => native.values.get(key) ?? null,
  );
  native.set.mockImplementation(async (key: string, value: string) => {
    native.values.set(key, value);
  });
  native.remove.mockImplementation(async (key: string) => {
    native.values.delete(key);
  });
  native.random.mockImplementation((bytes: Uint8Array) => bytes.fill(7));
});

it('creates and verifies one device-only key for simultaneous fresh-install callers', async () => {
  const storage = await import('./native-storage');
  const keys = await Promise.all([
    storage.getDatabaseKey(),
    storage.getDatabaseKey(),
  ]);
  expect(keys).toEqual(['07'.repeat(32), '07'.repeat(32)]);
  expect(native.random).toHaveBeenCalledOnce();
  expect(native.set).toHaveBeenCalledOnce();
  expect(native.set).toHaveBeenCalledWith('pfm.database.key.v1', keys[0], {
    keychainService: 'pfm.native.storage',
    keychainAccessible: 13,
    requireAuthentication: false,
  });
  expect(native.get).toHaveBeenCalledTimes(2);
});

it('starts fresh despite leftover Keychain values but preserves Expo Go data and PIN', async () => {
  native.values.set('pfm.database.key.v1', 'ab'.repeat(32));
  native.values.set('pfm.native.pin.v1', 'old-native-pin');
  native.values.set('pfm.preview.pin.v1', 'expo-go-pin');
  native.files.add('pfm-preview.db');
  const { getDatabaseKey } = await import('./native-storage');
  expect(await getDatabaseKey()).toBe('07'.repeat(32));
  expect(native.values.has('pfm.native.pin.v1')).toBe(false);
  expect(native.values.get('pfm.preview.pin.v1')).toBe('expo-go-pin');
  expect(native.files.has('pfm-preview.db')).toBe(true);
});

it('reuses the key and PIN when encrypted data exists after an update', async () => {
  native.files.add('pfm-encrypted.db');
  native.values.set('pfm.database.key.v1', 'ab'.repeat(32));
  native.values.set('pfm.native.pin.v1', 'existing-pin');
  const { getDatabaseKey } = await import('./native-storage');
  expect(await getDatabaseKey()).toBe('ab'.repeat(32));
  expect(native.random).not.toHaveBeenCalled();
  expect(native.set).not.toHaveBeenCalled();
  expect(native.remove).not.toHaveBeenCalled();
});

it.each([
  'pfm-encrypted.db',
  'pfm-encrypted-migration.db',
  'pfm-encrypted.db-wal',
])(
  'does not generate a replacement key when %s exists but its key is missing',
  async (file) => {
    native.files.add(file);
    const { getDatabaseKey } = await import('./native-storage');
    await expect(getDatabaseKey()).rejects.toThrow('DATABASE_KEY_MISSING');
    expect(native.random).not.toHaveBeenCalled();
    expect(native.set).not.toHaveBeenCalled();
    expect(native.remove).not.toHaveBeenCalled();
  },
);

it('rejects malformed stored keys without changing existing files or PIN', async () => {
  native.files.add('pfm-encrypted.db');
  native.values.set('pfm.database.key.v1', "invalid'; SELECT secret;");
  const { getDatabaseKey } = await import('./native-storage');
  await expect(getDatabaseKey()).rejects.toThrow('DATABASE_KEY_INVALID');
  expect(native.set).not.toHaveBeenCalled();
  expect(native.remove).not.toHaveBeenCalled();
});

it('fails closed on unavailable key storage and permits a retry', async () => {
  native.get.mockRejectedValueOnce(new Error('native secret detail'));
  const { getDatabaseKey } = await import('./native-storage');
  await expect(getDatabaseKey()).rejects.toThrow('DATABASE_KEY_UNAVAILABLE');
  expect(native.random).not.toHaveBeenCalled();
  await expect(getDatabaseKey()).resolves.toBe('07'.repeat(32));
});

it('does not return a key until persistence has been read back', async () => {
  native.get.mockResolvedValue(null);
  const { getDatabaseKey } = await import('./native-storage');
  await expect(getDatabaseKey()).rejects.toThrow('DATABASE_KEY_UNAVAILABLE');
  expect(native.remove).not.toHaveBeenCalled();
});

it('does not fall back to insecure randomness or ignore a failed key write', async () => {
  native.random.mockImplementationOnce(() => {
    throw new Error('NO_ENTROPY');
  });
  const { getDatabaseKey } = await import('./native-storage');
  await expect(getDatabaseKey()).rejects.toThrow('DATABASE_KEY_UNAVAILABLE');
  expect(native.set).not.toHaveBeenCalled();
  native.set.mockRejectedValueOnce(new Error('WRITE_FAILED'));
  await expect(getDatabaseKey()).rejects.toThrow('DATABASE_KEY_UNAVAILABLE');
});

it('does not clear a key while any encrypted database or sidecar still exists', async () => {
  const { deleteDatabaseKey } = await import('./native-storage');
  native.files.add('pfm-encrypted.db-wal');
  await expect(deleteDatabaseKey()).rejects.toThrow(
    'DATABASE_DELETE_INCOMPLETE',
  );
  expect(native.remove).not.toHaveBeenCalled();
});

it('explicit file deletion removes journals too, keeps the preview, and rotates the key on the next start', async () => {
  const storage = await import('./native-storage');
  await storage.getDatabaseKey();
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    native.files.add('pfm-encrypted.db' + suffix);
  native.files.add('pfm-preview.db');
  await storage.deleteEncryptedDatabaseFiles('pfm-encrypted.db');
  await storage.deleteDatabaseKey();
  expect([...native.files]).toEqual(['pfm-preview.db']);
  expect(native.values.has('pfm.database.key.v1')).toBe(false);
  native.random.mockImplementation((bytes: Uint8Array) => bytes.fill(9));
  expect(await storage.getDatabaseKey()).toBe('09'.repeat(32));
});
