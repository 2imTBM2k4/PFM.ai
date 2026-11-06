import { isRunningInExpoGo } from 'expo';
import {
  backupDatabaseAsync,
  openDatabaseAsync,
  deleteDatabaseAsync,
} from 'expo-sqlite';

import { checkIntegrity, migrate, MIGRATIONS, type Database } from './migrate';
import { seed } from './seed';

const DATABASE_NAME = 'pfm-preview.db';
const SNAPSHOT_NAME = 'pfm-preview-migration.db';
let opening: ReturnType<typeof initialize> | undefined;
let operations: Promise<unknown> = Promise.resolve();

async function initialize() {
  // Prevent a later native build from silently shipping the unencrypted preview.
  if (!isRunningInExpoGo() && process.env.EXPO_OS !== 'web')
    throw new Error('PREVIEW_REQUIRES_EXPO_GO');
  const db = await openDatabaseAsync(DATABASE_NAME);
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
      const snapshot = await openDatabaseAsync(SNAPSHOT_NAME);
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
          throw error;
        }
      } finally {
        await snapshot.closeAsync();
      }
      await deleteDatabaseAsync(SNAPSHOT_NAME);
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
      const db = await opening;
      await db.closeAsync();
      opening = undefined;
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
