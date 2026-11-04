import { DebtInputSchema, TransactionInputSchema } from '@pfm/contracts';
import { convertMoney, learningTokens, type EntryKind } from '@pfm/domain';
import type {
  ConfirmedEntry,
  EntryReferences,
} from '@/features/quick-entry/draft';
import type { Database, Queries } from './migrate';
import { listWallets, saveChatMessage, type ChatRow } from './repository';
import { listCategories } from './categories';
import { readDebtBalances, type DebtRow } from './debt-balances';
import { insertTransaction, type TransactionRow } from './transactions';
import {
  readClassifierContext,
  recordParseLearningQueries,
} from './parse-learning';

interface LearningKey {
  tokenKey: string;
  kind: EntryKind;
  categoryId: string | null;
}
interface LearningRow {
  token_key: string;
  kind: string;
  category_id: string | null;
  hit_count: number;
  updated_at: string;
}
export interface ParsedEntryReceipt {
  chatMessage: ChatRow | null;
  transactions: TransactionRow[];
  learning: {
    key: LearningKey;
    before: LearningRow | null;
    after: LearningRow | null;
  }[];
  debts: { before: DebtRow | null; after: DebtRow }[];
}

// Fetch local context once per focus/commit, never per keystroke.
export async function readQuickEntryContext(
  db: Queries,
): Promise<
  EntryReferences & Awaited<ReturnType<typeof readClassifierContext>>
> {
  const wallets = await listWallets(db);
  const last = await db.getFirstAsync<{
    wallet_id: string;
  }>(`SELECT t.wallet_id FROM transactions t
    JOIN wallets w ON w.id=t.wallet_id WHERE t.source IN ('manual','parsed') AND w.is_archived=0 ORDER BY t.rowid DESC LIMIT 1`);
  return {
    wallets,
    categories: await listCategories(db),
    debts: await readDebtBalances(db),
    lastWalletId: last?.wallet_id ?? wallets[0]?.id ?? null,
    ...(await readClassifierContext(db)),
  };
}

function readLearning(db: Queries, key: LearningKey) {
  return db.getFirstAsync<LearningRow>(
    'SELECT * FROM parse_learning WHERE token_key=? AND kind=? AND category_id IS ?',
    key.tokenKey,
    key.kind,
    key.categoryId,
  );
}

// Commit all selected entries and their confirmed learning as one financial operation.
export async function saveParsedEntries(
  db: Database,
  rawInput: string,
  entries: ConfirmedEntry[],
  timestamp: string,
  chatMessageId?: string,
  chatSessionId?: string,
): Promise<ParsedEntryReceipt> {
  if (!entries.length) throw new Error('ENTRY_SELECTION');
  if (!rawInput.trim()) throw new Error('ENTRY_INPUT');
  const receipt: ParsedEntryReceipt = {
    chatMessage: null,
    transactions: [],
    learning: [],
    debts: [],
  };
  await db.transaction(async (tx) => {
    const changes = new Map<
      string,
      { key: LearningKey; before: LearningRow | null }
    >();
    const debts = new Map<string, DebtRow | null>();
    for (const entry of entries) {
      const value = TransactionInputSchema.parse({
        ...entry.input,
        source: 'parsed',
        rawInput,
      });
      const newLoan =
        value.kind === 'debt_borrow' || value.kind === 'debt_lend';
      if (
        newLoan !== (entry.newDebt !== null) ||
        (entry.newDebt && value.debtId !== entry.newDebt.id)
      )
        throw new Error('ENTRY_NEW_DEBT');
      if (entry.newDebt) {
        const debt = DebtInputSchema.parse({
          direction: value.kind === 'debt_borrow' ? 'borrowed' : 'lent',
          counterpartyLabel: entry.newDebt.counterpartyLabel,
          amount: value.currency === 'USD'
            ? convertMoney(value.amount, 'USD', 'VND', value.vndPerUsd!)
            : value.amount,
          walletId: value.walletId,
          occurredOn: value.occurredOn,
          note: value.note,
        });
        await tx.runAsync(
          'INSERT INTO debts (id,counterparty_label,direction,due_on,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
          entry.newDebt.id,
          debt.counterpartyLabel,
          debt.direction,
          null,
          debt.note,
          timestamp,
          timestamp,
        );
        debts.set(entry.newDebt.id, null);
      } else if (value.debtId && !debts.has(value.debtId)) {
        debts.set(
          value.debtId,
          (await readDebtBalances(tx, value.debtId))[0] ?? null,
        );
      }
      for (const tokenKey of learningTokens(value.note ?? '')) {
        const key = {
          tokenKey,
          kind: value.kind,
          categoryId: value.categoryId,
        };
        const signature = JSON.stringify(key);
        if (!changes.has(signature))
          changes.set(signature, { key, before: await readLearning(tx, key) });
      }
      await insertTransaction(tx, entry.transactionId, value, timestamp);
      await recordParseLearningQueries(
        tx,
        {
          noteText: value.note ?? '',
          kind: value.kind,
          categoryId: value.categoryId,
        },
        timestamp,
      );
      const inserted = await tx.getFirstAsync<TransactionRow>(
        'SELECT * FROM transactions WHERE id=?',
        entry.transactionId,
      );
      if (!inserted) throw new Error('ENTRY_SAVE_NOT_VERIFIED');
      receipt.transactions.push(inserted);
    }
    for (const change of changes.values())
      receipt.learning.push({
        ...change,
        after: await readLearning(tx, change.key),
      });
    for (const [id, before] of debts)
      receipt.debts.push({
        before,
        after: (await readDebtBalances(tx, id))[0],
      });
    if (chatMessageId !== undefined) {
      await saveChatMessage(
        tx,
        chatMessageId,
        rawInput,
        timestamp,
        chatSessionId,
      );
      receipt.chatMessage = await tx.getFirstAsync<ChatRow>(
        'SELECT id,text,created_at FROM chat_messages WHERE id=?',
        chatMessageId,
      );
      if (!receipt.chatMessage) throw new Error('ENTRY_SAVE_NOT_VERIFIED');
    }
  });
  return receipt;
}

// Refuse stale undo receipts before any write; later edits and learning are never overwritten.
export async function undoParsedEntries(
  db: Database,
  receipt: ParsedEntryReceipt,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (receipt.chatMessage) {
      const message = await tx.getFirstAsync<ChatRow>(
        'SELECT id,text,created_at FROM chat_messages WHERE id=?',
        receipt.chatMessage.id,
      );
      if (JSON.stringify(message) !== JSON.stringify(receipt.chatMessage))
        throw new Error('ENTRY_CHANGED');
    }
    for (const row of receipt.transactions) {
      const current = await tx.getFirstAsync<TransactionRow>(
        'SELECT * FROM transactions WHERE id=?',
        row.id,
      );
      if (JSON.stringify(current) !== JSON.stringify(row))
        throw new Error('ENTRY_CHANGED');
    }
    for (const change of receipt.learning) {
      if (
        JSON.stringify(await readLearning(tx, change.key)) !==
        JSON.stringify(change.after)
      )
        throw new Error('ENTRY_CHANGED');
    }
    for (const debt of receipt.debts) {
      if (
        JSON.stringify((await readDebtBalances(tx, debt.after.id))[0]) !==
        JSON.stringify(debt.after)
      )
        throw new Error('ENTRY_CHANGED');
    }
    for (const row of receipt.transactions)
      await tx.runAsync('DELETE FROM transactions WHERE id=?', row.id);
    for (const { key, before } of receipt.learning) {
      if (before)
        await tx.runAsync(
          'UPDATE parse_learning SET hit_count=?,updated_at=? WHERE token_key=? AND kind=? AND category_id IS ?',
          before.hit_count,
          before.updated_at,
          key.tokenKey,
          key.kind,
          key.categoryId,
        );
      else
        await tx.runAsync(
          'DELETE FROM parse_learning WHERE token_key=? AND kind=? AND category_id IS ?',
          key.tokenKey,
          key.kind,
          key.categoryId,
        );
    }
    for (const { before, after } of receipt.debts) {
      if (before)
        await tx.runAsync(
          'UPDATE debts SET status=?,updated_at=? WHERE id=?',
          before.status,
          before.updated_at,
          before.id,
        );
      else await tx.runAsync('DELETE FROM debts WHERE id=?', after.id);
    }
    if (receipt.chatMessage)
      await tx.runAsync(
        'DELETE FROM chat_messages WHERE id=?',
        receipt.chatMessage.id,
      );
  });
}
