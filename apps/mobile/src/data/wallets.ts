import { WalletInputSchema, type WalletInput } from '@pfm/contracts';
import type { Database, Queries } from './migrate';
import type { WalletRow } from './repository';

export const PINNED_WALLETS_SETTING_KEY = 'pinned_wallet_ids_v1';

/** Prioritizes pins while preserving the existing order within both groups. */
export function prioritizePinnedWallets<T extends { id: string }>(
  wallets: readonly T[],
  ids: readonly string[],
): T[] {
  const pinned = new Set(ids);
  return [...wallets].sort(
    (a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)),
  );
}

/** Reads persisted wallet pins while ignoring malformed settings. */
export async function readPinnedWalletIds(db: Queries): Promise<string[]> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    PINNED_WALLETS_SETTING_KEY,
  );
  try {
    const value: unknown = JSON.parse(row?.value ?? '[]');
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (id): id is string => typeof id === 'string' && id.length > 0,
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

/** Pins or unpins an active wallet without changing its transaction order. */
export async function setWalletPinned(
  db: Database,
  id: string,
  pinned: boolean,
) {
  await db.transaction(async (tx) => {
    await requireActiveWallet(tx, id);
    const ids = new Set(await readPinnedWalletIds(tx));
    if (pinned) ids.add(id);
    else ids.delete(id);
    await tx.runAsync(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      PINNED_WALLETS_SETTING_KEY,
      JSON.stringify([...ids]),
    );
  });
}

export async function requireActiveWallet(
  db: Queries,
  id: string,
): Promise<WalletRow> {
  const wallet = await db.getFirstAsync<WalletRow>(
    `SELECT w.id, w.name, w.kind, w.initial_balance, w.is_goal_funding, w.is_archived, w.sort_order, b.balance
     FROM wallets w JOIN v_wallet_balance b ON b.wallet_id = w.id WHERE w.id = ?`,
    id,
  );
  if (!wallet) throw new Error('WALLET_NOT_FOUND');
  if (wallet.is_archived) throw new Error('WALLET_ARCHIVED');
  return wallet;
}

export async function createWallet(
  db: Database,
  id: string,
  input: WalletInput,
  timestamp: string,
) {
  const wallet = WalletInputSchema.parse(input);
  await db.transaction(async (transaction) => {
    const last = await transaction.getFirstAsync<{ position: number | null }>(
      'SELECT MAX(sort_order) position FROM wallets',
    );
    await transaction.runAsync(
      `INSERT INTO wallets (id, name, kind, initial_balance, is_goal_funding, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      wallet.name,
      wallet.kind,
      wallet.initialBalance,
      wallet.isGoalFunding ? 1 : 0,
      input.sortOrder === undefined
        ? (last?.position ?? -1) + 1
        : wallet.sortOrder,
      timestamp,
      timestamp,
    );
  });
}

export async function updateWallet(
  db: Database,
  id: string,
  input: WalletInput,
  timestamp: string,
) {
  const wallet = WalletInputSchema.parse(input);
  await db.transaction(async (transaction) => {
    await requireActiveWallet(transaction, id);
    await transaction.runAsync(
      `UPDATE wallets SET name = ?, kind = ?, initial_balance = ?, is_goal_funding = ?, sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ?`,
      wallet.name,
      wallet.kind,
      wallet.initialBalance,
      wallet.isGoalFunding ? 1 : 0,
      input.sortOrder === undefined ? null : wallet.sortOrder,
      timestamp,
      id,
    );
  });
}

export async function setWalletArchived(
  db: Database,
  id: string,
  archived: boolean,
  timestamp: string,
) {
  await db.transaction(async (transaction) => {
    if (
      !(await transaction.getFirstAsync(
        'SELECT id FROM wallets WHERE id = ?',
        id,
      ))
    )
      throw new Error('WALLET_NOT_FOUND');
    await transaction.runAsync(
      'UPDATE wallets SET is_archived = ?, updated_at = ? WHERE id = ?',
      archived ? 1 : 0,
      timestamp,
      id,
    );
  });
}

export async function reorderWallets(
  db: Database,
  ids: string[],
  timestamp: string,
) {
  await db.transaction(async (transaction) => {
    const active = await transaction.getAllAsync<{ id: string }>(
      'SELECT id FROM wallets WHERE is_archived = 0',
    );
    const allowed = new Set(active.map(({ id }) => id));
    if (
      ids.length !== active.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !allowed.has(id))
    )
      throw new Error('WALLET_ORDER_INVALID');
    for (const [position, id] of ids.entries()) {
      await transaction.runAsync(
        'UPDATE wallets SET sort_order = ?, updated_at = ? WHERE id = ?',
        position,
        timestamp,
        id,
      );
    }
  });
}
