import { RecurringInputSchema, type RecurringInput } from '@pfm/contracts';
import {
  addDays,
  nextOccurrence,
  validateDate,
  type RecurringSchedule,
} from '@pfm/domain';
import type { Database, Queries } from './migrate';
import { requireActiveWallet } from './wallets';
import { requireActiveCategory } from './categories';
import { foldSearchText } from './search-text';

export interface RecurringRow {
  id: string;
  kind: 'expense' | 'income' | 'transfer';
  amount: number;
  wallet_id: string;
  to_wallet_id: string | null;
  category_id: string | null;
  note: string | null;
  frequency: RecurringSchedule['frequency'];
  interval_count: number;
  start_on: string;
  end_on: string | null;
  last_generated_on: string | null;
  is_active: number;
  remind_before_days: number;
  blocked: number;
}

export function scheduleOf(row: RecurringRow): RecurringSchedule {
  return {
    startOn: row.start_on,
    endOn: row.end_on,
    frequency: row.frequency,
    intervalCount: row.interval_count,
  };
}

export function listRecurringRules(db: Queries) {
  return db.getAllAsync<RecurringRow>(`SELECT r.*,
    CASE WHEN w.is_archived=1 OR dest.is_archived=1 OR c.is_archived=1 OR p.is_archived=1 THEN 1 ELSE 0 END blocked
    FROM recurring_rules r JOIN wallets w ON w.id=r.wallet_id
    LEFT JOIN wallets dest ON dest.id=r.to_wallet_id
    LEFT JOIN categories c ON c.id=r.category_id LEFT JOIN categories p ON p.id=c.parent_id
    ORDER BY COALESCE(r.last_generated_on,r.start_on),r.id`);
}

export async function saveRecurringRule(
  db: Database,
  id: string,
  input: RecurringInput,
  timestamp: string,
  editing: boolean,
) {
  const value = RecurringInputSchema.parse(input);
  await db.transaction(async (tx) => {
    const old = editing
      ? await tx.getFirstAsync<RecurringRow>(
          'SELECT * FROM recurring_rules WHERE id=?',
          id,
        )
      : null;
    if (editing && !old) throw new Error('RECURRING_NOT_FOUND');
    if (value.walletId !== old?.wallet_id)
      await requireActiveWallet(tx, value.walletId);
    if (value.toWalletId && value.toWalletId !== old?.to_wallet_id)
      await requireActiveWallet(tx, value.toWalletId);
    if (
      value.categoryId &&
      (value.categoryId !== old?.category_id || value.kind !== old?.kind)
    ) {
      if (value.kind === 'transfer') throw new Error('CATEGORY_KIND');
      await requireActiveCategory(tx, value.categoryId, value.kind);
    }
    const params = [
      value.kind,
      value.amount,
      value.walletId,
      value.toWalletId,
      value.categoryId,
      value.note,
      value.frequency,
      value.intervalCount,
      value.startOn,
      value.endOn,
    ];
    if (editing)
      await tx.runAsync(
        'UPDATE recurring_rules SET kind=?,amount=?,wallet_id=?,to_wallet_id=?,category_id=?,note=?,frequency=?,interval_count=?,start_on=?,end_on=?,remind_before_days=1,updated_at=? WHERE id=?',
        ...params,
        timestamp,
        id,
      );
    else
      await tx.runAsync(
        'INSERT INTO recurring_rules (kind,amount,wallet_id,to_wallet_id,category_id,note,frequency,interval_count,start_on,end_on,remind_before_days,created_at,updated_at,id) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)',
        ...params,
        timestamp,
        timestamp,
        id,
      );
  });
}

export async function setRecurringActive(
  db: Database,
  id: string,
  active: boolean,
  date: string,
  timestamp: string,
) {
  validateDate(date);
  await db.transaction(async (tx) => {
    const row = await tx.getFirstAsync<RecurringRow>(
      'SELECT * FROM recurring_rules WHERE id=?',
      id,
    );
    if (!row) throw new Error('RECURRING_NOT_FOUND');
    // Explicit resume skips paused dates; reference archival never advances this cursor.
    const cursor =
      active && !row.is_active
        ? [row.last_generated_on ?? '', addDays(date, -1)].sort().at(-1)!
        : row.last_generated_on;
    await tx.runAsync(
      'UPDATE recurring_rules SET is_active=?,last_generated_on=?,updated_at=? WHERE id=?',
      active ? 1 : 0,
      cursor,
      timestamp,
      id,
    );
  });
}

/** Deletes a recurring rule while preserving previously generated transactions. */
export async function deleteRecurringRule(db: Database, id: string) {
  await db.transaction(async (tx) => {
    const row = await tx.getFirstAsync<{ id: string }>(
      'SELECT id FROM recurring_rules WHERE id=?',
      id,
    );
    if (!row) throw new Error('RECURRING_NOT_FOUND');
    await tx.runAsync(
      'UPDATE transactions SET recurring_rule_id=NULL WHERE recurring_rule_id=?',
      id,
    );
    await tx.runAsync(
      'DELETE FROM recurring_skips WHERE recurring_rule_id=?',
      id,
    );
    await tx.runAsync('DELETE FROM recurring_rules WHERE id=?', id);
  });
}

export async function generateRecurring(
  db: Database,
  date: string,
  timestamp: string,
  makeId: () => string,
  limit = 366,
) {
  validateDate(date);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError('Invalid catch-up limit.');
  let created = 0,
    processed = 0,
    hasMore = false;
  await db.transaction(async (tx) => {
    const rules = await listRecurringRules(tx);
    for (const rule of rules) {
      if (!rule.is_active || rule.blocked) continue;
      let next = rule.last_generated_on
        ? nextOccurrence(scheduleOf(rule), rule.last_generated_on)
        : rule.start_on;
      while (next && next <= date && (!rule.end_on || next <= rule.end_on)) {
        if (processed >= limit) {
          hasMore = true;
          break;
        }
        const exists = await tx.getFirstAsync(
          'SELECT 1 FROM transactions WHERE recurring_rule_id=? AND occurred_on=? UNION ALL SELECT 1 FROM recurring_skips WHERE recurring_rule_id=? AND occurred_on=? LIMIT 1',
          rule.id,
          next,
          rule.id,
          next,
        );
        if (!exists) {
          await tx.runAsync(
            `INSERT INTO transactions (id,kind,amount,wallet_id,to_wallet_id,category_id,occurred_on,occurred_at,note,note_search,source,recurring_rule_id,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,'recurring',?,?,?)`,
            makeId(),
            rule.kind,
            rule.amount,
            rule.wallet_id,
            rule.to_wallet_id,
            rule.category_id,
            next,
            new Date(`${next}T12:00:00+07:00`).toISOString(),
            rule.note,
            foldSearchText(rule.note ?? ''),
            rule.id,
            timestamp,
            timestamp,
          );
          created++;
        }
        processed++;
        await tx.runAsync(
          'UPDATE recurring_rules SET last_generated_on=? WHERE id=?',
          next,
          rule.id,
        );
        next = nextOccurrence(scheduleOf(rule), next);
      }
    }
  });
  return { created, processed, hasMore };
}
