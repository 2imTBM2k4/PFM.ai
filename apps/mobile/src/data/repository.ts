import { toMoney } from '@pfm/domain';
import type { WalletInput } from '@pfm/contracts';

import type { Database, Queries } from './migrate';
import { DEFAULT_WALLET_ID } from './seed';

export interface WalletRow {
  id: string;
  name: string;
  kind: WalletInput['kind'];
  balance: number;
  initial_balance: number;
  is_goal_funding: number;
  is_archived: number;
  sort_order: number;
}

export interface ChatRow {
  id: string;
  text: string;
  created_at: string;
}

export interface ChatSessionRow {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export const AI_REPLIES_SETTING_KEY = 'ai_chat_replies_v1';

export async function readOnboarding(db: Queries) {
  const result = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'onboarding_complete'",
  );
  return result?.value === 'true';
}

export async function finishOnboarding(
  db: Database,
  startingBalance: number,
  timestamp: string,
) {
  toMoney(startingBalance);
  await db.transaction(async (transaction) => {
    if (await readOnboarding(transaction)) return;
    await transaction.runAsync(
      'UPDATE wallets SET initial_balance = ?, updated_at = ? WHERE id = ?',
      startingBalance,
      timestamp,
      DEFAULT_WALLET_ID,
    );
    await transaction.runAsync(
      "INSERT INTO settings (key, value) VALUES ('onboarding_complete', 'true')",
    );
  });
}

export function listWallets(db: Queries, includeArchived = false) {
  return db.getAllAsync<WalletRow>(
    `SELECT w.id, w.name, w.kind, w.initial_balance, w.is_goal_funding, w.is_archived, w.sort_order, b.balance FROM wallets w
     JOIN v_wallet_balance b ON b.wallet_id = w.id
     WHERE (? = 1 OR w.is_archived = 0) ORDER BY w.sort_order, w.created_at, w.id`,
    includeArchived ? 1 : 0,
  );
}

export function listChatMessages(
  db: Queries,
  before?: ChatRow,
  sessionId?: string,
) {
  const scope = sessionId ? 'session_id=?' : '1=1';
  const scopeParams = sessionId ? [sessionId] : [];
  return before
    ? db.getAllAsync<ChatRow>(
        `SELECT id, text, created_at FROM chat_messages WHERE ${scope} AND (created_at, id) < (?, ?)
       ORDER BY created_at DESC, id DESC LIMIT 50`,
        ...scopeParams,
        before.created_at,
        before.id,
      )
    : db.getAllAsync<ChatRow>(
        `SELECT id, text, created_at FROM chat_messages WHERE ${scope} ORDER BY created_at DESC, id DESC LIMIT 50`,
        ...scopeParams,
      );
}

export function listChatSessions(db: Queries) {
  return db.getAllAsync<ChatSessionRow>(
    `SELECT m.session_id AS id,
       (SELECT substr(first.text, 1, 60) FROM chat_messages first WHERE first.session_id=m.session_id ORDER BY first.created_at, first.id LIMIT 1) AS title,
       MAX(m.created_at) AS updatedAt,
       COUNT(*) AS messageCount
     FROM chat_messages m GROUP BY m.session_id ORDER BY updatedAt DESC, id DESC`,
  );
}

export async function deleteChatSessions(db: Database, sessionIds: string[]) {
  if (!sessionIds.length) return;
  await db.transaction(async (tx) => {
    const messageIds: string[] = [];
    for (const sessionId of new Set(sessionIds)) {
      const rows = await tx.getAllAsync<{ id: string }>(
        'SELECT id FROM chat_messages WHERE session_id = ?',
        sessionId,
      );
      messageIds.push(...rows.map((row) => row.id));
      await tx.runAsync(
        'DELETE FROM chat_messages WHERE session_id = ?',
        sessionId,
      );
    }
    const row = await tx.getFirstAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      AI_REPLIES_SETTING_KEY,
    );
    if (!row?.value || !messageIds.length) return;
    let replies: Record<string, unknown>;
    try {
      replies = JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      replies = {};
    }
    for (const id of messageIds) delete replies[id];
    await tx.runAsync(
      'UPDATE settings SET value = ? WHERE key = ?',
      JSON.stringify(replies),
      AI_REPLIES_SETTING_KEY,
    );
  });
}

export async function saveChatMessage(
  db: Queries,
  id: string,
  text: string,
  timestamp: string,
  sessionId = 'legacy',
) {
  const value = text.trim();
  if (!value || value.length > 500) throw new RangeError('CHAT_TEXT_INVALID');
  if (!sessionId.trim() || sessionId.length > 64)
    throw new RangeError('CHAT_SESSION_INVALID');
  await db.runAsync(
    'INSERT INTO chat_messages (id, text, created_at, session_id) VALUES (?, ?, ?, ?)',
    id,
    value,
    timestamp,
    sessionId,
  );
}
