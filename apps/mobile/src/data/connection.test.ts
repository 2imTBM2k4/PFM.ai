import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  expoGo: true,
  failMigration: false,
  failBackfill: false,
  calls: [] as string[],
  opened: [] as string[],
  files: new Set<string>(),
  keyed: new Set<string>(),
  sql: [] as string[],
  cipherAvailable: true,
  wrongKey: false,
  failDelete: false,
  failKey: false,
}));

vi.mock('expo', () => ({ isRunningInExpoGo: () => native.expoGo }));
vi.mock('./native-storage', () => ({
  ENCRYPTED_DATABASE_NAME: 'pfm-encrypted.db',
  ENCRYPTED_SNAPSHOT_NAME: 'pfm-encrypted-migration.db',
  databaseFileExists: (name: string) => native.files.has(name),
  getDatabaseKey: async () => {
    if (native.failKey) throw new Error('DATABASE_KEY_MISSING');
    return 'ab'.repeat(32);
  },
  deleteDatabaseKey: async () => {
    native.calls.push('delete-key');
  },
  deleteEncryptedDatabaseFiles: (name: string) => {
    if (native.failDelete) throw new Error('DELETE_FAILED');
    if (native.files.has(name)) {
      native.files.delete(name);
      native.calls.push(`delete:${name}`);
    }
  },
}));
vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: async (name: string) => {
    native.opened.push(name);
    native.files.add(name);
    const db = {
      name,
      execAsync: async (sql: string) => {
        native.sql.push(`${name}:${sql}`);
        if (sql.startsWith('PRAGMA key')) native.keyed.add(name);
        if (
          sql.includes('CREATE TABLE schema_migrations') &&
          native.failMigration
        )
          throw new Error('INJECTED_MIGRATION_FAILURE');
      },
      runAsync: async () => undefined,
      getFirstAsync: async (sql: string) => {
        native.sql.push(`${name}:${sql}`);
        if (sql.includes('cipher_version'))
          return native.cipherAvailable ? { cipher_version: '4.6.1' } : null;
        if (!native.expoGo && (!native.keyed.has(name) || native.wrongKey))
          throw new Error('file is not a database');
        return { user_version: 0 };
      },
      getAllAsync: async (sql: string) => {
        if (
          native.failBackfill &&
          sql.includes('SELECT id,note FROM transactions')
        )
          throw new Error('INJECTED_BACKFILL_FAILURE');
        return sql.includes('integrity_check')
          ? [{ integrity_check: 'ok' }]
          : [];
      },
      withTransactionAsync: async (task: () => Promise<void>) => task(),
      closeAsync: async () => {
        native.calls.push(`close:${name}`);
      },
    };
    return db;
  },
  backupDatabaseAsync: async ({
    sourceDatabase,
    destDatabase,
  }: {
    sourceDatabase: { name: string };
    destDatabase: { name: string };
  }) => {
    if (
      !native.expoGo &&
      (!native.keyed.has(sourceDatabase.name) ||
        !native.keyed.has(destDatabase.name))
    )
      throw new Error('BACKUP_NOT_ENCRYPTED');
    native.calls.push(`backup:${sourceDatabase.name}->${destDatabase.name}`);
  },
  deleteDatabaseAsync: async (name: string) => {
    if (native.failDelete) throw new Error('DELETE_FAILED');
    native.files.delete(name);
    native.calls.push(`delete:${name}`);
  },
}));

beforeEach(() => {
  vi.resetModules();
  native.expoGo = true;
  native.failMigration = false;
  native.failBackfill = false;
  native.calls = [];
  native.opened = [];
  native.files.clear();
  native.keyed.clear();
  native.sql = [];
  native.cipherAvailable = true;
  native.wrongKey = false;
  native.failDelete = false;
  native.failKey = false;
});

it('snapshots before upgrading and deletes the snapshot only after success', async () => {
  const { withDatabase } = await import('./connection');
  await withDatabase(async () => undefined);
  expect(native.calls).toEqual([
    'backup:pfm-preview.db->pfm-preview-migration.db',
    'close:pfm-preview-migration.db',
    'delete:pfm-preview-migration.db',
  ]);
});

it('restores the snapshot on migration failure, keeps it for recovery, and permits retry', async () => {
  native.failMigration = true;
  const { withDatabase } = await import('./connection');
  await expect(withDatabase(async () => undefined)).rejects.toThrow(
    'INJECTED_MIGRATION_FAILURE',
  );
  expect(native.calls).toEqual([
    'backup:pfm-preview.db->pfm-preview-migration.db',
    'backup:pfm-preview-migration.db->pfm-preview.db',
    'close:pfm-preview-migration.db',
    'close:pfm-preview.db',
  ]);
  native.failMigration = false;
  await expect(withDatabase(async () => 'retried')).resolves.toBe('retried');
});

it('restores the native snapshot and keeps it when the search backfill fails', async () => {
  native.failBackfill = true;
  const { withDatabase } = await import('./connection');
  await expect(withDatabase(async () => undefined)).rejects.toThrow(
    'INJECTED_BACKFILL_FAILURE',
  );
  expect(native.calls).toEqual([
    'backup:pfm-preview.db->pfm-preview-migration.db',
    'backup:pfm-preview-migration.db->pfm-preview.db',
    'close:pfm-preview-migration.db',
    'close:pfm-preview.db',
  ]);
});

it('waits for in-flight operations before closing and deleting both database files', async () => {
  const { withDatabase, deletePreviewData } = await import('./connection');
  await withDatabase(async () => undefined);
  native.calls = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = withDatabase(async () => {
    await pending;
    native.calls.push('write-finished');
  });
  const deletion = deletePreviewData();
  await Promise.resolve();
  expect(native.calls).toEqual([]);
  release();
  await write;
  await deletion;
  expect(native.calls).toEqual([
    'write-finished',
    'close:pfm-preview.db',
    'close:pfm-preview-migration.db',
    'delete:pfm-preview-migration.db',
    'close:pfm-preview.db',
    'delete:pfm-preview.db',
  ]);
  await expect(withDatabase(async () => 'new database')).resolves.toBe(
    'new database',
  );
});

it('opens fresh native data with SQLCipher and keys both databases before schema reads or backup', async () => {
  native.expoGo = false;
  const { withDatabase } = await import('./connection');
  await expect(withDatabase(async () => 'ready')).resolves.toBe('ready');
  expect(native.opened).toEqual([
    'pfm-encrypted.db',
    'pfm-encrypted-migration.db',
  ]);
  expect([...native.keyed]).toEqual([
    'pfm-encrypted.db',
    'pfm-encrypted-migration.db',
  ]);
  expect(native.sql[0]).toBe('pfm-encrypted.db:PRAGMA cipher_version');
  expect(native.sql[1]).toBe(
    `pfm-encrypted.db:PRAGMA key = "x'${'ab'.repeat(32)}'"`,
  );
  expect(native.calls).toContain(
    'backup:pfm-encrypted.db->pfm-encrypted-migration.db',
  );
});

it('refuses a native build without SQLCipher before reading schema or creating plaintext tables', async () => {
  native.expoGo = false;
  native.cipherAvailable = false;
  const { withDatabase } = await import('./connection');
  await expect(withDatabase(async () => undefined)).rejects.toThrow(
    'DATABASE_CIPHER_UNAVAILABLE',
  );
  expect(native.sql).toEqual(['pfm-encrypted.db:PRAGMA cipher_version']);
  expect(native.calls).toEqual(['close:pfm-encrypted.db']);
});

it('does not open any file when the encryption key is missing', async () => {
  native.expoGo = false;
  native.failKey = true;
  const { withDatabase } = await import('./connection');
  await expect(withDatabase(async () => undefined)).rejects.toThrow(
    'DATABASE_KEY_MISSING',
  );
  expect(native.opened).toEqual([]);
});

it('preserves existing encrypted data when the stored key cannot decrypt it', async () => {
  native.expoGo = false;
  native.wrongKey = true;
  native.files.add('pfm-encrypted.db');
  const { withDatabase } = await import('./connection');
  await expect(withDatabase(async () => undefined)).rejects.toThrow();
  expect(native.files.has('pfm-encrypted.db')).toBe(true);
  expect(native.calls).toEqual(['close:pfm-encrypted.db']);
});

it('restores an encrypted snapshot after migration failure and permits retry', async () => {
  native.expoGo = false;
  native.failMigration = true;
  const { withDatabase } = await import('./connection');
  await expect(withDatabase(async () => undefined)).rejects.toThrow(
    'INJECTED_MIGRATION_FAILURE',
  );
  expect(native.calls).toContain(
    'backup:pfm-encrypted-migration.db->pfm-encrypted.db',
  );
  expect(native.files.has('pfm-encrypted-migration.db')).toBe(false);
  native.failMigration = false;
  await expect(withDatabase(async () => 'ready')).resolves.toBe('ready');
});

it('refuses to overwrite an orphaned encrypted snapshot with an empty database', async () => {
  native.expoGo = false;
  native.files.add('pfm-encrypted-migration.db');
  const { withDatabase } = await import('./connection');
  await expect(withDatabase(async () => undefined)).rejects.toThrow(
    'DATABASE_RECOVERY_REQUIRED',
  );
  expect(native.opened).toEqual([]);
  expect(native.files.has('pfm-encrypted-migration.db')).toBe(true);
});

it('explicit reset can delete inaccessible encrypted data without opening it and removes the key last', async () => {
  native.expoGo = false;
  native.failKey = true;
  native.files.add('pfm-encrypted.db');
  native.files.add('pfm-encrypted-migration.db');
  const { deletePreviewData } = await import('./connection');
  await deletePreviewData();
  expect(native.opened).toEqual([]);
  expect(native.calls).toEqual([
    'delete:pfm-encrypted-migration.db',
    'delete:pfm-encrypted.db',
    'delete-key',
  ]);
});

it('preserves the encryption key if deleting encrypted data fails', async () => {
  native.expoGo = false;
  native.failDelete = true;
  native.files.add('pfm-encrypted.db');
  const { deletePreviewData } = await import('./connection');
  await expect(deletePreviewData()).rejects.toThrow('DELETE_FAILED');
  expect(native.calls).not.toContain('delete-key');
});
