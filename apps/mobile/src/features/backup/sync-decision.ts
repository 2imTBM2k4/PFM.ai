import type { Queries } from '@/data/migrate';
import { DEFAULT_WALLET_ID } from '@/data/seed';
import type { RemoteBackupMetadata } from './drive-client';
import type { BackupState } from './google-auth';

export type InitialSyncDecision =
  | { action: 'upload_initial' }
  | { action: 'already_synced' }
  | { action: 'auto_restore'; fileId: string }
  | { action: 'upload_local' }
  | { action: 'ask_conflict'; remoteMetadata: RemoteBackupMetadata };

/** Returns true when local SQLite contains user-created financial data beyond the untouched seeded defaults. */
export async function hasMeaningfulLocalData(db: Queries): Promise<boolean> {
  const txRow = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM transactions',
  );
  if ((txRow?.count ?? 0) > 0) return true;

  const debtRow = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM debts',
  );
  if ((debtRow?.count ?? 0) > 0) return true;

  const recurringRow = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM recurring_rules',
  );
  if ((recurringRow?.count ?? 0) > 0) return true;

  const budgetRow = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM budgets',
  );
  if ((budgetRow?.count ?? 0) > 0) return true;

  const customCategoryRow = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM categories WHERE system_key IS NULL',
  );
  if ((customCategoryRow?.count ?? 0) > 0) return true;

  const wallets = await db.getAllAsync<{ id: string; initial_balance: number }>(
    'SELECT id, initial_balance FROM wallets',
  );
  if (wallets.length > 1) return true;
  if (
    wallets.length === 1 &&
    (wallets[0].id !== DEFAULT_WALLET_ID || wallets[0].initial_balance !== 0)
  ) {
    return true;
  }

  return false;
}

/** Decides whether sign-in should auto-upload, auto-restore, keep in sync, or ask once on conflict (A2). */
export function decideInitialConnectSync(input: {
  signedInEmail: string;
  previousState: BackupState;
  localChecksum: string;
  hasLocalData: boolean;
  remoteMetadata: RemoteBackupMetadata | null;
}): InitialSyncDecision {
  const {
    signedInEmail,
    previousState,
    localChecksum,
    hasLocalData,
    remoteMetadata,
  } = input;

  if (!remoteMetadata) {
    return { action: 'upload_initial' };
  }

  const remoteHash = remoteMetadata.sha256?.toLowerCase() ?? null;
  const localHash = localChecksum.toLowerCase();

  if (remoteHash && remoteHash === localHash) {
    return { action: 'already_synced' };
  }

  const isSameAccountReauth =
    previousState.accountEmail !== null &&
    previousState.accountEmail.toLowerCase() === signedInEmail.toLowerCase() &&
    previousState.lastUploadedHash !== null;

  if (isSameAccountReauth && previousState.lastUploadedHash) {
    const baseHash = previousState.lastUploadedHash.toLowerCase();
    const remoteChanged = remoteHash !== null && remoteHash !== baseHash;
    const localChanged = localHash !== baseHash;

    if (!remoteChanged && localChanged) {
      return { action: 'upload_local' };
    }
    if (remoteChanged && !localChanged) {
      return { action: 'auto_restore', fileId: remoteMetadata.fileId };
    }
  }

  if (!hasLocalData) {
    return { action: 'auto_restore', fileId: remoteMetadata.fileId };
  }

  return { action: 'ask_conflict', remoteMetadata };
}
