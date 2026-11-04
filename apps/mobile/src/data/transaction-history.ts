import type { TransactionFilters } from '@pfm/contracts';
import type { Queries } from './migrate';
import { listTransactions, type TransactionRow } from './transactions';

export interface TransactionHistoryRow extends TransactionRow {
  wallet_balance_after: number;
  to_wallet_balance_after: number | null;
}

// Calculate before filtering to page IDs so hidden and older entries still affect balances.
export async function listTransactionHistory(
  db: Queries,
  before?: TransactionRow,
  filters: TransactionFilters = {},
): Promise<TransactionHistoryRow[]> {
  const rows = await listTransactions(db, before, filters);
  if (!rows.length) return [];
  const walletIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.to_wallet_id ? [row.wallet_id, row.to_wallet_id] : [row.wallet_id],
      ),
    ),
  ];
  const balances = await db.getAllAsync<{
    id: string;
    wallet_id: string;
    balance: number;
  }>(
    `WITH movements AS (
      SELECT id, wallet_id, occurred_on, occurred_at,
        CASE WHEN kind IN ('income','debt_borrow','debt_repay_received')
          THEN amount ELSE -amount END AS delta
      FROM transactions
      UNION ALL
      SELECT id, to_wallet_id, occurred_on, occurred_at, amount
      FROM transactions WHERE kind='transfer'
    ), running AS (
      SELECT id, wallet_id,
        SUM(delta) OVER (PARTITION BY wallet_id
          ORDER BY occurred_on,occurred_at,id ROWS UNBOUNDED PRECEDING) AS total
      FROM movements WHERE wallet_id IN (${walletIds.map(() => '?').join(',')})
    )
    SELECT r.id,r.wallet_id,w.initial_balance+r.total AS balance
    FROM running r JOIN wallets w ON w.id=r.wallet_id
    WHERE r.id IN (${rows.map(() => '?').join(',')})`,
    ...walletIds,
    ...rows.map((row) => row.id),
  );
  const byEntryWallet = new Map(
    balances.map((row) => [`${row.id}:${row.wallet_id}`, row.balance]),
  );
  return rows.map((row) => {
    const source = byEntryWallet.get(`${row.id}:${row.wallet_id}`);
    const destination = row.to_wallet_id
      ? byEntryWallet.get(`${row.id}:${row.to_wallet_id}`)
      : null;
    if (
      source === undefined ||
      destination === undefined ||
      !Number.isSafeInteger(source) ||
      (destination !== null && !Number.isSafeInteger(destination))
    )
      throw new Error('TRANSACTION_BALANCE_INVALID');
    return {
      ...row,
      wallet_balance_after: source,
      to_wallet_balance_after: destination,
    };
  });
}
