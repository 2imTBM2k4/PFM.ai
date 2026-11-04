import {
  TransactionInputSchema,
  TransactionFiltersSchema,
  type TransactionInput,
  type TransactionFilters,
} from '@pfm/contracts';
import { foldSearchText } from './search-text';
import { convertMoney, today, MAX_AMOUNT_VND } from '@pfm/domain';
import type { Database, Queries } from './migrate';
import { requireActiveWallet } from './wallets';
import { requireActiveCategory } from './categories';
import { reconcileDebt, validateDebtReference } from './debt-balances';

export interface TransactionRow {
  id: string;
  kind: TransactionInput['kind'];
  amount: number;
  original_amount_minor: number | null;
  original_currency: 'VND' | 'USD';
  booking_rate: number | null;
  wallet_id: string;
  to_wallet_id: string | null;
  category_id: string | null;
  debt_id: string | null;
  occurred_on: string;
  occurred_at: string;
  note: string | null;
  note_search: string;
  source: string;
  recurring_rule_id: string | null;
  raw_input: string | null;
  created_at: string;
  updated_at: string;
}

export async function listTransactions(
  db: Queries,
  before?: TransactionRow,
  filters: TransactionFilters = {},
) {
  const value = TransactionFiltersSchema.parse(filters);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (value.debtId) {
    where.push('debt_id=?');
    params.push(value.debtId);
  }
  const text = foldSearchText(value.text);
  if (text) {
    where.push('instr(note_search,?)>0');
    params.push(text);
  }
  if (value.from) {
    where.push('occurred_on>=?');
    params.push(value.from);
  }
  if (value.to) {
    where.push('occurred_on<=?');
    params.push(value.to);
  }
  if (value.kind) {
    where.push('kind=?');
    params.push(value.kind);
  }
  if (value.walletId) {
    where.push('(wallet_id=? OR to_wallet_id=?)');
    params.push(value.walletId, value.walletId);
  }
  if (value.categoryId) {
    where.push(
      '(category_id=? OR category_id IN (SELECT id FROM categories WHERE parent_id=?))',
    );
    params.push(value.categoryId, value.categoryId);
  }
  if (value.minAmount !== undefined) {
    where.push('amount>=?');
    params.push(value.minAmount);
  }
  if (value.maxAmount !== undefined) {
    where.push('amount<=?');
    params.push(value.maxAmount);
  }
  if (before) {
    where.push('(occurred_on,occurred_at,id)<(?,?,?)');
    params.push(before.occurred_on, before.occurred_at, before.id);
  }
  return db.getAllAsync<TransactionRow>(
    `SELECT * FROM transactions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_on DESC,occurred_at DESC,id DESC LIMIT 50`,
    ...params,
  );
}

async function validateInput(
  db: Queries,
  input: TransactionInput,
  previous?: TransactionRow,
) {
  const value = TransactionInputSchema.parse(input);
  const bookedAmount = convertMoney(
    value.amount,
    value.currency,
    'VND',
    value.vndPerUsd,
  );
  if (bookedAmount <= 0 || bookedAmount > MAX_AMOUNT_VND)
    throw new RangeError('TRANSACTION_AMOUNT');
  if (value.debtId) await validateDebtReference(db, value.debtId, value.kind);
  if (
    previous &&
    (value.debtId !== previous.debt_id ||
      (previous.debt_id && value.kind !== previous.kind))
  )
    throw new Error('DEBT_TRANSACTION_KIND');
  if (
    today({
      now: () => new Date(value.occurredAt),
      timeZone: 'Asia/Ho_Chi_Minh',
    }) !== value.occurredOn
  )
    throw new Error('TRANSACTION_DATE_MISMATCH');
  if (value.walletId !== previous?.wallet_id)
    await requireActiveWallet(db, value.walletId);
  if (value.toWalletId && value.toWalletId !== previous?.to_wallet_id)
    await requireActiveWallet(db, value.toWalletId);
  // Historical edits can retain archived references; newly selected references must be active.
  if (
    value.categoryId &&
    (value.categoryId !== previous?.category_id || value.kind !== previous.kind)
  ) {
    if (value.kind !== 'income' && value.kind !== 'expense')
      throw new Error('CATEGORY_KIND');
    await requireActiveCategory(db, value.categoryId, value.kind);
  }
  return {
    ...value,
    amount: bookedAmount,
    originalAmountMinor: value.amount,
    originalCurrency: value.currency,
    bookingRate: value.currency === 'USD' ? value.vndPerUsd : null,
    occurredAt: new Date(value.occurredAt).toISOString(),
  };
}

async function requireTransaction(db: Queries, id: string) {
  const row = await db.getFirstAsync<TransactionRow>(
    'SELECT * FROM transactions WHERE id=?',
    id,
  );
  if (!row) throw new Error('TRANSACTION_NOT_FOUND');
  return row;
}

export async function createTransaction(
  db: Database,
  id: string,
  input: TransactionInput,
  timestamp: string,
) {
  await db.transaction((transaction) =>
    insertTransaction(transaction, id, input, timestamp),
  );
}

// Insert and validate within the caller's SQL transaction, including debt creation.
export async function insertTransaction(
  transaction: Queries,
  id: string,
  input: TransactionInput,
  timestamp: string,
) {
  const value = await validateInput(transaction, input);
  if (value.recurringRuleId || value.source === 'recurring')
    throw new Error('TRANSACTION_FEATURE_PENDING');
  await transaction.runAsync(
    `INSERT INTO transactions (id,kind,amount,wallet_id,to_wallet_id,category_id,debt_id,occurred_on,occurred_at,note,source,recurring_rule_id,raw_input,created_at,updated_at,note_search,original_currency,original_amount_minor,booking_rate)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    value.kind,
    value.amount,
    value.walletId,
    value.toWalletId,
    value.categoryId,
    value.debtId,
    value.occurredOn,
    value.occurredAt,
    value.note,
    value.source,
    value.recurringRuleId,
    value.rawInput,
    timestamp,
    timestamp,
    foldSearchText(value.note ?? ''),
    value.originalCurrency,
    value.originalAmountMinor,
    value.bookingRate,
  );
  if (value.debtId) await reconcileDebt(transaction, value.debtId, timestamp);
}

export async function updateTransaction(
  db: Database,
  id: string,
  input: TransactionInput,
  timestamp: string,
  expectedUpdatedAt?: string,
) {
  await db.transaction(async (transaction) => {
    const previous = await requireTransaction(transaction, id);
    if (
      expectedUpdatedAt !== undefined &&
      previous.updated_at !== expectedUpdatedAt
    )
      throw new Error('TRANSACTION_CHANGED');
    const value = await validateInput(transaction, input, previous);
    if (
      previous.recurring_rule_id &&
      previous.occurred_on !== value.occurredOn
    ) {
      await transaction.runAsync(
        'INSERT OR IGNORE INTO recurring_skips (recurring_rule_id,occurred_on) VALUES (?,?)',
        previous.recurring_rule_id,
        previous.occurred_on,
      );
    }
    await transaction.runAsync(
      `UPDATE transactions SET kind=?,amount=?,wallet_id=?,to_wallet_id=?,category_id=?,occurred_on=?,occurred_at=?,note=?,updated_at=?,note_search=?,original_currency=?,original_amount_minor=?,booking_rate=? WHERE id=?`,
      value.kind,
      value.amount,
      value.walletId,
      value.toWalletId,
      value.categoryId,
      value.occurredOn,
      value.occurredAt,
      value.note,
      timestamp,
      foldSearchText(value.note ?? ''),
      value.originalCurrency,
      value.originalAmountMinor,
      value.bookingRate,
      id,
    );
    if (previous.debt_id)
      await reconcileDebt(transaction, previous.debt_id, timestamp);
  });
}

export async function deleteTransaction(
  db: Database,
  id: string,
  expectedUpdatedAt?: string,
) {
  let deleted!: TransactionRow;
  await db.transaction(async (transaction) => {
    deleted = await requireTransaction(transaction, id);
    if (
      expectedUpdatedAt !== undefined &&
      deleted.updated_at !== expectedUpdatedAt
    )
      throw new Error('TRANSACTION_CHANGED');
    if (deleted.recurring_rule_id)
      await transaction.runAsync(
        'INSERT OR IGNORE INTO recurring_skips (recurring_rule_id,occurred_on) VALUES (?,?)',
        deleted.recurring_rule_id,
        deleted.occurred_on,
      );
    await transaction.runAsync('DELETE FROM transactions WHERE id=?', id);
    if (deleted.debt_id)
      await reconcileDebt(
        transaction,
        deleted.debt_id,
        new Date().toISOString(),
      );
  });
  return deleted;
}

export async function undoDeleteTransaction(db: Database, row: TransactionRow) {
  // Restore the trusted local deletion snapshot exactly, including archived references.
  await db.transaction(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO transactions (id,kind,amount,wallet_id,to_wallet_id,category_id,debt_id,occurred_on,occurred_at,note,source,recurring_rule_id,raw_input,created_at,updated_at,note_search,original_currency,original_amount_minor,booking_rate)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id,
      row.kind,
      row.amount,
      row.wallet_id,
      row.to_wallet_id,
      row.category_id,
      row.debt_id,
      row.occurred_on,
      row.occurred_at,
      row.note,
      row.source,
      row.recurring_rule_id,
      row.raw_input,
      row.created_at,
      row.updated_at,
      foldSearchText(row.note ?? ''),
      row.original_currency,
      row.original_amount_minor,
      row.booking_rate,
    );
    if (row.debt_id)
      await reconcileDebt(transaction, row.debt_id, new Date().toISOString());
  });
}
