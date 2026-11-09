import { isRunningInExpoGo } from 'expo';
import {
  backupDatabaseAsync,
  openDatabaseAsync,
  deleteDatabaseAsync,
} from 'expo-sqlite';

import { checkIntegrity, migrate, MIGRATIONS, type Database } from './migrate';
import { seed } from './seed';
import {
  ENCRYPTED_DATABASE_NAME,
  ENCRYPTED_SNAPSHOT_NAME,
  databaseFileExists,
  getDatabaseKey,
  deleteDatabaseKey,
  deleteEncryptedDatabaseFiles,
} from './native-storage';

const encrypted = !isRunningInExpoGo() && process.env.EXPO_OS !== 'web';
const DATABASE_NAME = encrypted ? ENCRYPTED_DATABASE_NAME : 'pfm-preview.db';
const SNAPSHOT_NAME = encrypted
  ? ENCRYPTED_SNAPSHOT_NAME
  : 'pfm-preview-migration.db';
let opening: ReturnType<typeof initialize> | undefined;
let operations: Promise<unknown> = Promise.resolve();

/** Opens a connection and rejects builds that cannot encrypt native storage. */
async function openDatabase(name: string, key?: string) {
  const db = await openDatabaseAsync(name);
  try {
    if (key) {
      const cipher = await db.getFirstAsync<{ cipher_version: string }>(
        'PRAGMA cipher_version',
      );
      if (!cipher?.cipher_version)
        throw new Error('DATABASE_CIPHER_UNAVAILABLE');
      await db.execAsync(`PRAGMA key = "x'${key}'"`);
      // Force authentication before any schema writes or migration backup.
      await db.getFirstAsync('SELECT count(*) FROM sqlite_master');
    }
    return db;
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}

/** Initializes the selected storage without importing the plaintext Expo Go preview. */
async function initialize() {
  const key = encrypted ? await getDatabaseKey() : undefined;
  // A process interruption may leave an incomplete snapshot. Never overwrite either file automatically.
  if (encrypted && databaseFileExists(SNAPSHOT_NAME))
    throw new Error('DATABASE_RECOVERY_REQUIRED');
  const db = await openDatabase(DATABASE_NAME, key);
  // The queue prevents interleaving; keep transactions on the FK-enabled connection.
  const connection: Database & { closeAsync(): Promise<void> } = {
    execAsync: db.execAsync.bind(db),
    runAsync: db.runAsync.bind(db),
    getFirstAsync: db.getFirstAsync.bind(db),
    getAllAsync: db.getAllAsync.bind(db),
    closeAsync: db.closeAsync.bind(db),
    transaction: (task) => db.withTransactionAsync(() => task(connection)),
  };
  try {
    await db.execAsync(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
    );
    const version =
      (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))
        ?.user_version ?? 0;
    if (version > MIGRATIONS.at(-1)!.version)
      throw new Error('SCHEMA_NEWER_THAN_APP');
    if (version < MIGRATIONS.at(-1)!.version) {
      const snapshot = await openDatabase(SNAPSHOT_NAME, key);
      let rolledBack = false;
      try {
        await backupDatabaseAsync({
          sourceDatabase: db,
          destDatabase: snapshot,
        });
        try {
          await migrate(connection);
        } catch (error) {
          await backupDatabaseAsync({
            sourceDatabase: snapshot,
            destDatabase: db,
          });
          await checkIntegrity(db);
          rolledBack = true;
          throw error;
        }
      } finally {
        await snapshot.closeAsync();
        if (encrypted && rolledBack)
          deleteEncryptedDatabaseFiles(ENCRYPTED_SNAPSHOT_NAME);
      }
      if (encrypted) deleteEncryptedDatabaseFiles(ENCRYPTED_SNAPSHOT_NAME);
      else await deleteDatabaseAsync(SNAPSHOT_NAME);
    } else {
      await checkIntegrity(db);
    }
    await seed(connection, new Date().toISOString());
    return connection;
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}

function getDatabase() {
  opening ??= initialize().catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

// Serialize application operations so deletion waits for in-flight writes.
export function withDatabase<T>(
  task: (db: Awaited<ReturnType<typeof getDatabase>>) => Promise<T>,
): Promise<T> {
  const operation = operations.then(async () => task(await getDatabase()));
  operations = operation.catch(() => undefined);
  return operation;
}

export function deletePreviewData(): Promise<void> {
  const operation = operations.then(async () => {
    if (opening) {
      const db = await opening.catch(() => undefined);
      await db?.closeAsync();
      opening = undefined;
    }
    if (encrypted) {
      // Deletion must also work when the key is lost or the file cannot be decrypted.
      deleteEncryptedDatabaseFiles(ENCRYPTED_SNAPSHOT_NAME);
      deleteEncryptedDatabaseFiles(ENCRYPTED_DATABASE_NAME);
      await deleteDatabaseKey();
      return;
    }
    for (const name of [SNAPSHOT_NAME, DATABASE_NAME]) {
      // Ensure an absent file is handled identically to an existing file.
      const db = await openDatabaseAsync(name);
      await db.closeAsync();
      await deleteDatabaseAsync(name);
    }
  });
  operations = operation.catch(() => undefined);
  return operation;
}
