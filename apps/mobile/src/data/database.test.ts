import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { migrate, MIGRATIONS, type Database } from './migrate';
import { seed, DEFAULT_WALLET_ID } from './seed';
import { archiveGoal, restoreGoal, listGoals, saveGoal } from './goals';
import { readDashboard, readDailyTotals } from './dashboard';
import { createDebt, repayDebt, listDebts, updateDebt } from './debts';
import {
  saveRecurringRule,
  setRecurringActive,
  generateRecurring,
  listRecurringRules,
} from './recurring';
import { processBudgetAlerts } from '@/features/budgets/alerts';
import {
  createBudget,
  updateBudget,
  setBudgetActive,
  readBudgetMonth,
  claimBudgetAlert,
  releaseBudgetAlert,
} from './budgets';
import {
  createTransaction,
  insertTransaction,
  updateTransaction,
  deleteTransaction,
  undoDeleteTransaction,
  listTransactions,
} from './transactions';
import {
  createCategory,
  updateCategory,
  archiveCategory,
  restoreCategory,
  listCategories,
  requireActiveCategory,
} from './categories';
import {
  finishOnboarding,
  readOnboarding,
  saveChatMessage,
  listChatMessages,
  listChatSessions,
  deleteChatSessions,
  listWallets,
} from './repository';
import {
  createWallet,
  updateWallet,
  setWalletArchived,
  reorderWallets,
  requireActiveWallet,
} from './wallets';
import {
  recordParseLearning,
  recordParseLearningQueries,
  readClassifierContext,
} from './parse-learning';
import { parseEntry } from '@pfm/domain';
import { routeChatInput } from '@/features/chat/intent';
import {
  applyDevSeedData,
  removeDevSeedData,
  DEV_BANK_WALLET_ID,
  DEV_SEED_PREFIX,
} from './seed-data';
import { listTransactionHistory } from './transaction-history';
import {
  readQuickEntryContext,
  saveParsedEntries,
  undoParsedEntries,
} from './quick-entry';
import {
  makeEntryDrafts,
  confirmSelectedEntries,
} from '@/features/quick-entry/draft';

let sqlite: DatabaseSync;
let db: Database;
let temporaryFile: string | undefined;

const entryNow = new Date('2026-10-23T09:00:00+07:00');

it('toggles samples off and on without losing a real Chat transaction in the sample wallet', async () => {
  await migrate(db);
  await applyDevSeedData(db, '2026-10-23');
  const session = await entrySession('ăn sáng 30k');
  session.drafts[0].walletId = DEV_BANK_WALLET_ID;
  const receipt = await saveParsedEntries(
    db,
    session.result.raw,
    confirmSelectedEntries(session.result, session.drafts, entryNow),
    'now',
    randomUUID(),
  );
  await removeDevSeedData(db);
  expect((await listTransactions(db)).map((row) => row.id)).toEqual([
    receipt.transactions[0].id,
  ]);
  expect((await listChatMessages(db)).map((row) => row.id)).toEqual([
    receipt.chatMessage!.id,
  ]);
  expect(
    (await listWallets(db)).find((row) => row.id === DEV_BANK_WALLET_ID),
  ).toMatchObject({ initial_balance: 5000000, balance: 4970000 });
  expect(await listGoals(db)).toEqual([]);
  expect(
    sqlite
      .prepare('SELECT value FROM settings WHERE key=?')
      .get('pref_seed_enabled')?.value,
  ).toBe('false');
  await removeDevSeedData(db);
  await applyDevSeedData(db, '2026-10-23');
  await applyDevSeedData(db, '2026-10-23');
  const restored = await listTransactions(db);
  expect(
    restored.filter((row) => row.id === receipt.transactions[0].id),
  ).toHaveLength(1);
  expect(restored.some((row) => row.id.startsWith(DEV_SEED_PREFIX))).toBe(true);
  expect(
    sqlite
      .prepare('SELECT value FROM settings WHERE key=?')
      .get('pref_seed_enabled')?.value,
  ).toBe('true');
});

it.each([
  'receiving_transfer',
  'goal',
  'recurring_source',
  'recurring_destination',
] as const)(
  'retains a sample wallet referenced by a real %s',
  async (reference) => {
    await migrate(db);
    await applyDevSeedData(db, '2026-10-23');
    if (reference === 'receiving_transfer') {
      await createTransaction(
        db,
        randomUUID(),
        {
          kind: 'transfer',
          amount: 100,
          walletId: DEFAULT_WALLET_ID,
          toWalletId: DEV_BANK_WALLET_ID,
          occurredOn: '2026-10-23',
          occurredAt: entryNow.toISOString(),
        },
        'now',
      );
    } else if (reference === 'goal') {
      await saveGoal(
        db,
        randomUUID(),
        {
          name: 'Real goal',
          targetAmount: 10000000,
          fundingWalletId: DEV_BANK_WALLET_ID,
        },
        'now',
        false,
      );
    } else {
      await saveRecurringRule(
        db,
        randomUUID(),
        {
          kind: 'transfer',
          amount: 100,
          walletId:
            reference === 'recurring_source'
              ? DEV_BANK_WALLET_ID
              : DEFAULT_WALLET_ID,
          toWalletId:
            reference === 'recurring_source'
              ? DEFAULT_WALLET_ID
              : DEV_BANK_WALLET_ID,
          frequency: 'monthly',
          startOn: '2026-10-23',
        },
        'now',
        false,
      );
    }
    await removeDevSeedData(db);
    expect(
      (await listWallets(db, true)).some(
        (row) => row.id === DEV_BANK_WALLET_ID,
      ),
    ).toBe(true);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  },
);

it('removes unused sample wallets and rolls back all sample changes when the flag write fails', async () => {
  await migrate(db);
  await applyDevSeedData(db, '2026-10-23');
  const before = await listTransactions(db);
  await db.execAsync(
    `CREATE TRIGGER fail_sample_flag BEFORE UPDATE ON settings WHEN OLD.key='pref_seed_enabled' BEGIN SELECT RAISE(ABORT,'FLAG_FAILED'); END;`,
  );
  await expect(removeDevSeedData(db)).rejects.toThrow('FLAG_FAILED');
  expect(await listTransactions(db)).toEqual(before);
  expect(
    sqlite
      .prepare('SELECT value FROM settings WHERE key=?')
      .get('pref_seed_enabled')?.value,
  ).toBe('true');
  await db.execAsync('DROP TRIGGER fail_sample_flag');
  await removeDevSeedData(db);
  expect(
    (await listWallets(db, true)).some((row) => row.id === DEV_BANK_WALLET_ID),
  ).toBe(false);
  expect(await listTransactions(db)).toEqual([]);
});

it('rolls back sample enablement when persisting the enabled flag fails', async () => {
  await migrate(db);
  await applyDevSeedData(db, '2026-10-23');
  await removeDevSeedData(db);
  await db.execAsync(
    `CREATE TRIGGER fail_enable_flag BEFORE UPDATE ON settings WHEN OLD.key='pref_seed_enabled' BEGIN SELECT RAISE(ABORT,'FLAG_FAILED'); END;`,
  );
  await expect(applyDevSeedData(db, '2026-10-23')).rejects.toThrow(
    'FLAG_FAILED',
  );
  expect(await listTransactions(db)).toEqual([]);
  expect(await listChatMessages(db)).toEqual([]);
  expect(await listGoals(db)).toEqual([]);
  expect(
    (await listWallets(db, true)).some((row) => row.id === DEV_BANK_WALLET_ID),
  ).toBe(false);
  expect(
    sqlite
      .prepare('SELECT value FROM settings WHERE key=?')
      .get('pref_seed_enabled')?.value,
  ).toBe('false');
});

it('shows full-history wallet balances after transfers even when history is filtered', async () => {
  await migrate(db);
  await seed(db, 'old');
  sqlite
    .prepare('UPDATE wallets SET initial_balance=1000000 WHERE id=?')
    .run(DEFAULT_WALLET_ID);
  const bank = randomUUID();
  await createWallet(
    db,
    bank,
    { name: 'Bank', kind: 'bank', initialBalance: 200000 },
    'old',
  );
  const ids: string[] = [];
  for (const [kind, amount, hour, toWalletId] of [
    ['income', 300000, '09', null],
    ['expense', 30000, '10', null],
    ['transfer', 200000, '11', bank],
  ] as const) {
    const id = randomUUID();
    ids.push(id);
    await createTransaction(
      db,
      id,
      {
        kind,
        amount,
        walletId: DEFAULT_WALLET_ID,
        toWalletId,
        occurredOn: '2026-10-23',
        occurredAt: `2026-10-23T${hour}:00:00+07:00`,
        note: 'target',
      },
      'now',
    );
  }
  const history = await listTransactionHistory(db);
  expect(
    history.map((row) => [
      row.id,
      row.wallet_balance_after,
      row.to_wallet_balance_after,
    ]),
  ).toEqual([
    [ids[2], 1070000, 400000],
    [ids[1], 1270000, null],
    [ids[0], 1300000, null],
  ]);
  const filtered = await listTransactionHistory(db, undefined, {
    kind: 'expense',
    text: 'target',
    from: '2026-10-23',
    walletId: DEFAULT_WALLET_ID,
  });
  expect(filtered.map((row) => row.wallet_balance_after)).toEqual([1270000]);
  const incoming = await listTransactionHistory(db, undefined, {
    walletId: bank,
  });
  expect(incoming[0].to_wallet_balance_after).toBe(400000);
  await setWalletArchived(db, bank, true, 'archived');
  expect((await listTransactionHistory(db))[0].to_wallet_balance_after).toBe(
    400000,
  );
});

it('recomputes historical balances for backdated insert, edit, deletion and undo', async () => {
  await migrate(db);
  await seed(db, 'old');
  sqlite
    .prepare('UPDATE wallets SET initial_balance=1000 WHERE id=?')
    .run(DEFAULT_WALLET_ID);
  const income = randomUUID(),
    expense = randomUUID();
  await createTransaction(
    db,
    income,
    {
      kind: 'income',
      amount: 50,
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-10-23',
      occurredAt: '2026-10-23T12:00:00+07:00',
    },
    'one',
  );
  const input = {
    kind: 'expense',
    amount: 30,
    walletId: DEFAULT_WALLET_ID,
    occurredOn: '2026-10-22',
    occurredAt: '2026-10-22T12:00:00+07:00',
  } as const;
  await createTransaction(db, expense, input, 'backdated');
  expect(
    (await listTransactionHistory(db)).map((row) => row.wallet_balance_after),
  ).toEqual([1020, 970]);
  await updateTransaction(db, expense, { ...input, amount: 40 }, 'edit');
  expect(
    (await listTransactionHistory(db)).map((row) => row.wallet_balance_after),
  ).toEqual([1010, 960]);
  const deleted = await deleteTransaction(db, expense);
  expect((await listTransactionHistory(db))[0].wallet_balance_after).toBe(1050);
  await undoDeleteTransaction(db, deleted);
  expect(
    (await listTransactionHistory(db)).map((row) => row.wallet_balance_after),
  ).toEqual([1010, 960]);
});

it('keeps tied-time running balances stable across history pages', async () => {
  await migrate(db);
  await seed(db, 'old');
  sqlite
    .prepare('UPDATE wallets SET initial_balance=1000 WHERE id=?')
    .run(DEFAULT_WALLET_ID);
  for (let i = 0; i < 55; i++)
    await createTransaction(
      db,
      `00000000-0000-4000-8777-${String(i).padStart(12, '0')}`,
      {
        kind: 'expense',
        amount: 10,
        walletId: DEFAULT_WALLET_ID,
        occurredOn: '2026-10-23',
        occurredAt: entryNow.toISOString(),
      },
      'now',
    );
  const first = await listTransactionHistory(db);
  const second = await listTransactionHistory(db, first.at(-1));
  expect(first).toHaveLength(50);
  expect(second).toHaveLength(5);
  expect([...first, ...second].map((row) => row.wallet_balance_after)).toEqual(
    Array.from({ length: 55 }, (_, i) => 450 + i * 10),
  );
  expect(
    await listTransactionHistory(db, undefined, { text: 'not present' }),
  ).toEqual([]);
});

it('includes borrowed, lent and repaid principal in historical cash balances', async () => {
  await migrate(db);
  await seed(db, 'old');
  const borrowed = randomUUID(),
    lent = randomUUID();
  await createDebt(
    db,
    borrowed,
    randomUUID(),
    {
      direction: 'borrowed',
      counterpartyLabel: 'Borrower',
      amount: 500,
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-10-20',
    },
    'one',
  );
  await createDebt(
    db,
    lent,
    randomUUID(),
    {
      direction: 'lent',
      counterpartyLabel: 'Lender',
      amount: 200,
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-10-21',
    },
    'two',
  );
  await repayDebt(
    db,
    borrowed,
    randomUUID(),
    { amount: 100, walletId: DEFAULT_WALLET_ID, occurredOn: '2026-10-22' },
    'three',
  );
  await repayDebt(
    db,
    lent,
    randomUUID(),
    { amount: 50, walletId: DEFAULT_WALLET_ID, occurredOn: '2026-10-23' },
    'four',
  );
  expect(
    (await listTransactionHistory(db)).map((row) => row.wallet_balance_after),
  ).toEqual([250, 200, 300, 500]);
});

it('keeps zero, negative and large historical balances exact', async () => {
  await migrate(db);
  await seed(db, 'old');
  sqlite
    .prepare('UPDATE wallets SET initial_balance=-100000000000 WHERE id=?')
    .run(DEFAULT_WALLET_ID);
  await createTransaction(
    db,
    randomUUID(),
    {
      kind: 'income',
      amount: 100000000000,
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-10-22',
      occurredAt: '2026-10-22T12:00:00+07:00',
    },
    'one',
  );
  await createTransaction(
    db,
    randomUUID(),
    {
      kind: 'expense',
      amount: 100000000000,
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-10-23',
      occurredAt: '2026-10-23T12:00:00+07:00',
    },
    'two',
  );
  expect(
    (await listTransactionHistory(db)).map((row) => row.wallet_balance_after),
  ).toEqual([-100000000000, 0]);
});

it('lists a Chat expense alongside enabled sample data', async () => {
  await migrate(db);
  await applyDevSeedData(db, '2026-10-23');
  const session = await entrySession('ăn sáng 30k');
  const receipt = await saveParsedEntries(
    db,
    session.result.raw,
    confirmSelectedEntries(session.result, session.drafts, entryNow),
    entryNow.toISOString(),
    randomUUID(),
  );
  expect(
    (await listTransactions(db)).some(
      (row) => row.id === receipt.transactions[0].id,
    ),
  ).toBe(true);
});

it.each(['transactions', 'chat_messages'] as const)(
  'refuses a successful-looking save when SQLite did not insert into %s',
  async (table) => {
    await migrate(db);
    await seed(db, 'old');
    await db.execAsync(
      `CREATE TRIGGER ignore_entry BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END;`,
    );
    const session = await entrySession('ăn sáng 30k');
    await expect(
      saveParsedEntries(
        db,
        session.result.raw,
        confirmSelectedEntries(session.result, session.drafts, entryNow),
        entryNow.toISOString(),
        randomUUID(),
      ),
    ).rejects.toThrow('ENTRY_SAVE_NOT_VERIFIED');
    expect(await listTransactions(db)).toEqual([]);
    expect(await listChatMessages(db)).toEqual([]);
    expect((await listWallets(db))[0].balance).toBe(0);
    expect(
      sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n,
    ).toBe(0);
  },
);

it.each([
  ['ăn sáng 30k', [30000], -30000, false],
  ['khách trả tiền hàng 50k', [50000], 50000, false],
  ['cf 30k bánh 20k', [20000, 30000], -50000, false],
  ['ăn sáng 30', [30000], -30000, true],
] as const)(
  'routes, confirms, saves and undoes the complete Chat financial flow: %s',
  async (raw, amounts, balance, needsConsent) => {
    await migrate(db);
    await seed(db, 'old');
    const context = await readQuickEntryContext(db);
    const { route, parsed } = routeChatInput(raw, {
      ...context,
      clock: { now: () => entryNow, timeZone: 'Asia/Ho_Chi_Minh' },
    });
    expect(route).toBe('transaction');
    const drafts = makeEntryDrafts(parsed, context, randomUUID);
    if (needsConsent) {
      expect(() => confirmSelectedEntries(parsed, drafts, entryNow)).toThrow(
        'ENTRY_AMOUNT_CONFIRMATION',
      );
      drafts.forEach((draft) => {
        draft.amountConfirmed = true;
      });
    }
    // Routing and opening confirmation must leave cancellation safe.
    expect(await listTransactions(db)).toEqual([]);
    expect(await listChatMessages(db)).toEqual([]);
    expect(
      sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n,
    ).toBe(0);
    const receipt = await saveParsedEntries(
      db,
      raw,
      confirmSelectedEntries(parsed, drafts, entryNow),
      entryNow.toISOString(),
      randomUUID(),
    );
    expect(
      (await listTransactions(db))
        .map((row) => row.amount)
        .sort((a, b) => a - b),
    ).toEqual([...amounts]);
    expect((await listWallets(db))[0].balance).toBe(balance);
    expect((await listChatMessages(db)).map((row) => row.text)).toEqual([raw]);
    expect(
      sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n,
    ).toBeGreaterThan(0);
    await undoParsedEntries(db, receipt);
    expect(await listTransactions(db)).toEqual([]);
    expect(await listChatMessages(db)).toEqual([]);
    expect((await listWallets(db))[0].balance).toBe(0);
    expect(
      sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n,
    ).toBe(0);
  },
);

it.each([
  ['có nên mua điện thoại 15tr?', 'advice'],
  ['500k', 'ambiguous'],
  ['chưa trả nợ Hùng 500k', 'ambiguous'],
] as const)(
  'does not turn a routed non-transaction into financial data: %s',
  async (raw, expectedRoute) => {
    await migrate(db);
    await seed(db, 'old');
    const context = await readQuickEntryContext(db);
    const { route } = routeChatInput(raw, {
      ...context,
      clock: { now: () => entryNow, timeZone: 'Asia/Ho_Chi_Minh' },
    });
    expect(route).toBe(expectedRoute);
    if (route === 'advice')
      await saveChatMessage(db, randomUUID(), raw, entryNow.toISOString());
    expect(await listTransactions(db)).toEqual([]);
    expect((await listWallets(db))[0].balance).toBe(0);
    expect(
      sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n,
    ).toBe(0);
    expect((await listChatMessages(db)).length).toBe(
      route === 'advice' ? 1 : 0,
    );
  },
);

async function entrySession(raw: string) {
  const context = await readQuickEntryContext(db);
  const result = parseEntry(raw, {
    clock: { now: () => entryNow, timeZone: 'Asia/Ho_Chi_Minh' },
    ...context,
  });
  return {
    context,
    result,
    drafts: makeEntryDrafts(result, context, randomUUID),
  };
}

it('commits confirmed chat text with financial entries and learning, and undoes all three', async () => {
  await migrate(db);
  await seed(db, 'old');
  const session = await entrySession('ăn sáng 30k');
  expect(await listChatMessages(db)).toEqual([]);
  const messageId = randomUUID();
  const receipt = await saveParsedEntries(
    db,
    session.result.raw,
    confirmSelectedEntries(session.result, session.drafts, entryNow),
    'now',
    messageId,
  );
  expect(await listChatMessages(db)).toEqual([
    { id: messageId, text: 'ăn sáng 30k', created_at: 'now' },
  ]);
  expect((await listWallets(db))[0].balance).toBe(-30000);
  await undoParsedEntries(db, receipt);
  expect(await listChatMessages(db)).toEqual([]);
  expect((await listWallets(db))[0].balance).toBe(0);
  expect(sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n).toBe(
    0,
  );
});

it('books a USD expense in a VND wallet and restores its original amount after undo', async () => {
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID();
  const input = {
    kind: 'expense' as const,
    amount: 1000,
    currency: 'USD' as const,
    vndPerUsd: 25_500,
    walletId: DEFAULT_WALLET_ID,
    occurredOn: '2026-10-23',
    occurredAt: entryNow.toISOString(),
  };
  await createTransaction(db, id, input, 'now');
  expect((await listTransactions(db))[0]).toMatchObject({
    amount: 255_000,
    original_amount_minor: 1000,
    original_currency: 'USD',
    booking_rate: 25_500,
  });
  expect((await listWallets(db))[0].balance).toBe(-255_000);
  const deleted = await deleteTransaction(db, id);
  await undoDeleteTransaction(db, deleted);
  expect((await listTransactions(db))[0]).toMatchObject({
    amount: 255_000,
    original_amount_minor: 1000,
    original_currency: 'USD',
  });
  expect((await listWallets(db))[0].balance).toBe(-255_000);
});

it('groups only income and expenses by local transaction day for the selected month', async () => {
  await migrate(db);
  await seed(db, 'old');
  const base = {
    walletId: DEFAULT_WALLET_ID,
    occurredOn: '2026-11-02',
    occurredAt: '2026-11-02T12:00:00+07:00',
  };
  await createTransaction(
    db,
    randomUUID(),
    { ...base, kind: 'income', amount: 50_000 },
    'now',
  );
  await createTransaction(
    db,
    randomUUID(),
    { ...base, kind: 'expense', amount: 20_000 },
    'now',
  );
  await createTransaction(
    db,
    randomUUID(),
    { ...base, kind: 'expense', amount: 10_000 },
    'now',
  );
  const destination = randomUUID();
  await createWallet(
    db,
    destination,
    { name: 'Second wallet', kind: 'bank' },
    'now',
  );
  await createTransaction(
    db,
    randomUUID(),
    { ...base, kind: 'transfer', amount: 100_000, toWalletId: destination },
    'now',
  );
  await createTransaction(
    db,
    randomUUID(),
    {
      ...base,
      occurredOn: '2026-10-31',
      occurredAt: '2026-10-31T12:00:00+07:00',
      kind: 'expense',
      amount: 5_000,
    },
    'now',
  );
  expect(await readDailyTotals(db, '2026-11')).toEqual([
    { date: '2026-11-02', income: 50_000, expense: 30_000 },
  ]);
  expect(await readDailyTotals(db, '2026-12')).toEqual([]);
});

it.each(['duplicate', 'oversize'])(
  'rolls back finance and learning when chat text fails: %s',
  async (mode) => {
    await migrate(db);
    await seed(db, 'old');
    const session = await entrySession('ăn sáng 30k');
    const messageId = randomUUID();
    if (mode === 'duplicate')
      await saveChatMessage(db, messageId, 'existing question', 'old');
    await expect(
      saveParsedEntries(
        db,
        mode === 'oversize' ? 'a'.repeat(501) : session.result.raw,
        confirmSelectedEntries(session.result, session.drafts, entryNow),
        'now',
        messageId,
      ),
    ).rejects.toThrow();
    expect((await listTransactions(db)).length).toBe(0);
    expect((await listWallets(db))[0].balance).toBe(0);
    expect(
      sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n,
    ).toBe(0);
    expect((await listChatMessages(db)).length).toBe(
      mode === 'duplicate' ? 1 : 0,
    );
  },
);

it('refuses chat-linked undo if its saved message changed, leaving money and learning intact', async () => {
  await migrate(db);
  await seed(db, 'old');
  const session = await entrySession('cf 30k');
  const messageId = randomUUID();
  const receipt = await saveParsedEntries(
    db,
    session.result.raw,
    confirmSelectedEntries(session.result, session.drafts, entryNow),
    'now',
    messageId,
  );
  sqlite
    .prepare('UPDATE chat_messages SET text=? WHERE id=?')
    .run('edited', messageId);
  await expect(undoParsedEntries(db, receipt)).rejects.toThrow('ENTRY_CHANGED');
  expect((await listWallets(db))[0].balance).toBe(-30000);
  expect((await listChatMessages(db))[0].text).toBe('edited');
});

it('saves only explicitly confirmed quick entries with source/raw metadata and exact batch undo', async () => {
  await migrate(db);
  await seed(db, 'old');
  const expense = await entrySession('ăn sáng 30k');
  expect((await listTransactions(db)).length).toBe(0);
  expect(sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n).toBe(
    0,
  );
  const saved = await saveParsedEntries(
    db,
    expense.result.raw,
    confirmSelectedEntries(expense.result, expense.drafts, entryNow),
    'one',
  );
  expect((await listTransactions(db))[0]).toMatchObject({
    kind: 'expense',
    amount: 30000,
    source: 'parsed',
    raw_input: 'ăn sáng 30k',
  });
  expect((await listWallets(db))[0].balance).toBe(-30000);
  await undoParsedEntries(db, saved);
  expect((await listWallets(db))[0].balance).toBe(0);
  expect((await listTransactions(db)).length).toBe(0);
  expect(sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n).toBe(
    0,
  );
  const income = await entrySession('khách trả tiền hàng 50k');
  await saveParsedEntries(
    db,
    income.result.raw,
    confirmSelectedEntries(income.result, income.drafts, entryNow),
    'income',
  );
  expect((await listTransactions(db))[0]).toMatchObject({
    kind: 'income',
    amount: 50000,
  });
  expect((await listWallets(db))[0].balance).toBe(50000);
});

it('can confirm just one or both candidates, never sums them and prevents duplicate saves', async () => {
  await migrate(db);
  await seed(db, 'old');
  const session = await entrySession('cf 30k bánh 20k');
  const one = session.drafts.map((draft, i) => ({
    ...draft,
    selected: i === 0,
  }));
  const prepared = confirmSelectedEntries(session.result, one, entryNow);
  const receipt = await saveParsedEntries(
    db,
    session.result.raw,
    prepared,
    'one',
  );
  expect((await listTransactions(db)).map((row) => row.amount)).toEqual([
    30000,
  ]);
  await expect(
    saveParsedEntries(db, session.result.raw, prepared, 'again'),
  ).rejects.toThrow();
  expect((await listWallets(db))[0].balance).toBe(-30000);
  await undoParsedEntries(db, receipt);
  const both = await entrySession('cf 30k bánh 20k');
  const batch = await saveParsedEntries(
    db,
    both.result.raw,
    confirmSelectedEntries(both.result, both.drafts, entryNow),
    'both',
  );
  expect(
    (await listTransactions(db)).map((row) => row.amount).sort((a, b) => a - b),
  ).toEqual([20000, 30000]);
  expect((await listWallets(db))[0].balance).toBe(-50000);
  await undoParsedEntries(db, batch);
  expect((await listTransactions(db)).length).toBe(0);
});

it('requires amount acknowledgement and an explicit kind, and cancellation changes nothing', async () => {
  await migrate(db);
  await seed(db, 'old');
  const assumed = await entrySession('ăn sáng 30');
  expect(() =>
    confirmSelectedEntries(assumed.result, assumed.drafts, entryNow),
  ).toThrow('ENTRY_AMOUNT_CONFIRMATION');
  expect(() =>
    confirmSelectedEntries(
      assumed.result,
      assumed.drafts.map((d) => ({ ...d, selected: false })),
      entryNow,
    ),
  ).toThrow('ENTRY_SELECTION');
  const unknown = await entrySession('bạn trả tiền ăn 100k');
  expect(() =>
    confirmSelectedEntries(unknown.result, unknown.drafts, entryNow),
  ).toThrow('ENTRY_KIND');
  expect((await listTransactions(db)).length).toBe(0);
  expect(sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n).toBe(
    0,
  );
  const receipt = await saveParsedEntries(
    db,
    assumed.result.raw,
    confirmSelectedEntries(
      assumed.result,
      assumed.drafts.map((d) => ({ ...d, amountConfirmed: true })),
      entryNow,
    ),
    'confirmed',
  );
  expect((await listWallets(db))[0].balance).toBe(-30000);
  await undoParsedEntries(db, receipt);
});

it('learns edited final categories after actual saves and rolls back learning on undo', async () => {
  await migrate(db);
  await seed(db, 'old');
  const custom = randomUUID();
  await createCategory(
    db,
    custom,
    { name: 'Breakfast', kind: 'expense' },
    'old',
  );
  for (let i = 0; i < 2; i++) {
    const session = await entrySession('ăn sáng 30k');
    const drafts = session.drafts.map((d) => ({ ...d, categoryId: custom }));
    const receipt = await saveParsedEntries(
      db,
      session.result.raw,
      confirmSelectedEntries(session.result, drafts, entryNow),
      `save-${i}`,
    );
    if (i === 1) {
      expect((await entrySession('ăn sáng 30k')).drafts[0].categoryId).toBe(
        custom,
      );
      await undoParsedEntries(db, receipt);
      expect((await entrySession('ăn sáng 30k')).drafts[0].categoryId).not.toBe(
        custom,
      );
    }
  }
  expect((await listWallets(db))[0].balance).toBe(-30000);
});

it('rolls back all candidates and learning if a later reference becomes inactive', async () => {
  await migrate(db);
  await seed(db, 'old');
  const other = randomUUID();
  await createWallet(db, other, { name: 'Other', kind: 'bank' }, 'old');
  const session = await entrySession('cf 30k bánh 20k');
  const drafts = session.drafts.map((d, i) => ({
    ...d,
    walletId: i === 1 ? other : d.walletId,
  }));
  const prepared = confirmSelectedEntries(session.result, drafts, entryNow);
  await setWalletArchived(db, other, true, 'archived');
  await expect(
    saveParsedEntries(db, session.result.raw, prepared, 'save'),
  ).rejects.toThrow('WALLET_ARCHIVED');
  expect((await listTransactions(db)).length).toBe(0);
  expect(sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n).toBe(
    0,
  );
});

it('creates new parsed debts, validates repayments and undoes both without orphan debt rows', async () => {
  await migrate(db);
  await seed(db, 'old');
  const loan = await entrySession('mượn Hùng 500k');
  const loanReceipt = await saveParsedEntries(
    db,
    loan.result.raw,
    confirmSelectedEntries(
      loan.result,
      loan.drafts.map((d) => ({ ...d, counterpartyLabel: 'Hùng' })),
      entryNow,
    ),
    'loan',
  );
  expect((await listDebts(db))[0]).toMatchObject({
    counterparty_label: 'Hùng',
    principal: 500000,
    outstanding: 500000,
  });
  const paid = await entrySession('trả nợ Hùng 100k');
  expect(paid.drafts[0].debtId).toBe((await listDebts(db))[0].id);
  const repayReceipt = await saveParsedEntries(
    db,
    paid.result.raw,
    confirmSelectedEntries(paid.result, paid.drafts, entryNow),
    'repay',
  );
  expect((await listDebts(db))[0].outstanding).toBe(400000);
  const tooMuch = await entrySession('trả nợ Hùng 500k');
  await expect(
    saveParsedEntries(
      db,
      tooMuch.result.raw,
      confirmSelectedEntries(tooMuch.result, tooMuch.drafts, entryNow),
      'overpay',
    ),
  ).rejects.toThrow('DEBT_OVERPAY');
  await undoParsedEntries(db, repayReceipt);
  expect((await listDebts(db))[0].outstanding).toBe(500000);
  await undoParsedEntries(db, loanReceipt);
  expect((await listDebts(db)).length).toBe(0);
  expect((await listWallets(db))[0].balance).toBe(0);
});

it.each(['transaction', 'learning'])(
  'refuses undo after %s changed instead of erasing later work',
  async (changed) => {
    await migrate(db);
    await seed(db, 'old');
    const session = await entrySession('ăn sáng 30k');
    const receipt = await saveParsedEntries(
      db,
      session.result.raw,
      confirmSelectedEntries(session.result, session.drafts, entryNow),
      'save',
    );
    if (changed === 'transaction')
      sqlite
        .prepare('UPDATE transactions SET note=? WHERE id=?')
        .run('edited', session.drafts[0].transactionId);
    else
      await recordParseLearning(
        db,
        {
          noteText: 'ăn sáng',
          kind: 'expense',
          categoryId: receipt.transactions[0].category_id,
        },
        'later',
      );
    await expect(undoParsedEntries(db, receipt)).rejects.toThrow(
      'ENTRY_CHANGED',
    );
    expect((await listTransactions(db))[0].note).toBe(
      changed === 'transaction' ? 'edited' : 'ăn sáng',
    );
    expect((await listWallets(db))[0].balance).toBe(-30000);
  },
);

it('saves a confirmed transfer with two active wallets and reverses both balances on undo', async () => {
  await migrate(db);
  await seed(db, 'old');
  const destination = randomUUID();
  await createWallet(db, destination, { name: 'Bank', kind: 'bank' }, 'old');
  const session = await entrySession('chuyển ví 200k');
  const drafts = session.drafts.map((d) => ({ ...d, toWalletId: destination }));
  const receipt = await saveParsedEntries(
    db,
    session.result.raw,
    confirmSelectedEntries(session.result, drafts, entryNow),
    'transfer',
  );
  expect((await listTransactions(db))[0]).toMatchObject({
    kind: 'transfer',
    category_id: null,
    to_wallet_id: destination,
  });
  expect(
    (await listWallets(db)).find((w) => w.id === destination)?.balance,
  ).toBe(200000);
  expect(
    (await listWallets(db)).find((w) => w.id === DEFAULT_WALLET_ID)?.balance,
  ).toBe(-200000);
  await undoParsedEntries(db, receipt);
  expect((await listWallets(db)).map((w) => w.balance)).toEqual([0, 0]);
});

it('creates a lent debt, receives payment, and removes a failed new-debt batch completely', async () => {
  await migrate(db);
  await seed(db, 'old');
  const lent = await entrySession('cho Lan mượn 1tr');
  await saveParsedEntries(
    db,
    lent.result.raw,
    confirmSelectedEntries(
      lent.result,
      lent.drafts.map((d) => ({ ...d, counterpartyLabel: 'Lan' })),
      entryNow,
    ),
    'lend',
  );
  const received = await entrySession('Lan trả nợ 1tr');
  const payment = await saveParsedEntries(
    db,
    received.result.raw,
    confirmSelectedEntries(received.result, received.drafts, entryNow),
    'received',
  );
  expect((await listDebts(db))[0]).toMatchObject({
    status: 'closed',
    outstanding: 0,
  });
  expect((await listWallets(db))[0].balance).toBe(0);
  await undoParsedEntries(db, payment);
  expect((await listDebts(db))[0]).toMatchObject({
    status: 'open',
    outstanding: 1000000,
  });
  const batch = await entrySession('mượn Hùng 500k cf 30k');
  const prepared = confirmSelectedEntries(
    batch.result,
    batch.drafts.map((d) => ({ ...d, counterpartyLabel: 'Hùng' })),
    entryNow,
  );
  prepared[1].input.walletId = randomUUID();
  await expect(
    saveParsedEntries(db, batch.result.raw, prepared, 'failed'),
  ).rejects.toThrow('WALLET_NOT_FOUND');
  expect((await listDebts(db)).map((d) => d.counterparty_label)).toEqual([
    'Lan',
  ]);
  expect((await listWallets(db))[0].balance).toBe(-1000000);
});

it('uses the last manual/parsed active source wallet and falls back after archival', async () => {
  await migrate(db);
  await seed(db, 'old');
  const other = randomUUID();
  await createWallet(db, other, { name: 'Other', kind: 'bank' }, 'old');
  const session = await entrySession('cf 30k');
  await saveParsedEntries(
    db,
    session.result.raw,
    confirmSelectedEntries(
      session.result,
      session.drafts.map((d) => ({ ...d, walletId: other })),
      entryNow,
    ),
    'save',
  );
  expect((await entrySession('cf 25k')).drafts[0].walletId).toBe(other);
  await setWalletArchived(db, other, true, 'archived');
  expect((await entrySession('cf 25k')).drafts[0].walletId).toBe(
    DEFAULT_WALLET_ID,
  );
});

it('learns a custom category only after two confirmed choices, not on preview reads', async () => {
  sqlite.close();
  temporaryFile = join(tmpdir(), `pfm-learning-${randomUUID()}.db`);
  sqlite = new DatabaseSync(temporaryFile);
  sqlite.exec('PRAGMA foreign_keys=ON');
  await migrate(db);
  await seed(db, 'old');
  const categoryId = randomUUID();
  await createCategory(
    db,
    categoryId,
    { name: 'Custom', kind: 'expense' },
    'old',
  );
  const clock = {
    now: () => new Date('2026-10-23T09:00:00+07:00'),
    timeZone: 'Asia/Ho_Chi_Minh',
  };
  const preview = async () =>
    parseEntry('ăn sáng 30k', { clock, ...(await readClassifierContext(db)) })
      .candidates[0];
  expect((await preview()).categoryKey).toBe('expense.food.eating_out');
  expect(sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n).toBe(
    0,
  );
  await recordParseLearning(
    db,
    { noteText: 'ăn sáng', kind: 'expense', categoryId },
    'one',
  );
  expect((await preview()).categoryKey).toBe('expense.food.eating_out');
  await recordParseLearning(
    db,
    { noteText: 'ăn sáng', kind: 'expense', categoryId },
    'two',
  );
  expect(await preview()).toMatchObject({
    categoryKey: null,
    categoryIdHint: categoryId,
  });
  expect(
    sqlite
      .prepare(
        'SELECT token_key,hit_count,updated_at FROM parse_learning ORDER BY token_key',
      )
      .all(),
  ).toEqual([
    { token_key: 'an', hit_count: 2, updated_at: 'two' },
    { token_key: 'sang', hit_count: 2, updated_at: 'two' },
  ]);
  sqlite.close();
  sqlite = new DatabaseSync(temporaryFile);
  sqlite.exec('PRAGMA foreign_keys=ON');
  await migrate(db);
  expect((await preview()).categoryIdHint).toBe(categoryId);
  await archiveCategory(db, categoryId, null, 'archived');
  expect((await preview()).categoryKey).toBe('expense.food.eating_out');
  await restoreCategory(db, categoryId, 'restored');
  expect((await preview()).categoryIdHint).toBe(categoryId);
});

it('upserts nullable learned categories once per token and validates final kind/category choices', async () => {
  await migrate(db);
  await seed(db, 'old');
  const noteText = 'Xe xe hôm nay 30k';
  await recordParseLearning(db, { noteText, kind: 'expense' }, 'one');
  await recordParseLearning(db, { noteText, kind: 'expense' }, 'two');
  expect(
    sqlite
      .prepare('SELECT token_key,category_id,hit_count FROM parse_learning')
      .all(),
  ).toEqual([{ token_key: 'xe', category_id: null, hit_count: 2 }]);
  const categories = await listCategories(db);
  const income = categories.find((c) => c.kind === 'income')!;
  await expect(
    // @ts-expect-error Runtime input validation must reject an unknown kind.
    recordParseLearning(db, { noteText, kind: 'unknown' }, 'bad'),
  ).rejects.toThrow();
  for (const input of [
    { noteText, kind: 'expense', categoryId: randomUUID() },
    { noteText, kind: 'expense', categoryId: income.id },
    { noteText, kind: 'transfer', categoryId: income.id },
  ] as const)
    await expect(recordParseLearning(db, input, 'bad')).rejects.toThrow();
  expect(
    sqlite.prepare('SELECT SUM(hit_count) n FROM parse_learning').get()?.n,
  ).toBe(2);
});

it('rolls learning back with its enclosing confirmation and rejects unsafe hit counts', async () => {
  await migrate(db);
  await seed(db, 'old');
  await expect(
    db.transaction(async (queries) => {
      await insertTransaction(
        queries,
        randomUUID(),
        {
          kind: 'expense',
          amount: 30000,
          walletId: DEFAULT_WALLET_ID,
          occurredOn: '2026-10-23',
          occurredAt: '2026-10-23T09:00:00+07:00',
          source: 'parsed',
        },
        'now',
      );
      await recordParseLearningQueries(
        queries,
        { noteText: 'cà phê', kind: 'expense' },
        'now',
      );
      throw new Error('SAVE_FAILED');
    }),
  ).rejects.toThrow('SAVE_FAILED');
  expect(sqlite.prepare('SELECT COUNT(*) n FROM parse_learning').get()?.n).toBe(
    0,
  );
  expect(sqlite.prepare('SELECT COUNT(*) n FROM transactions').get()?.n).toBe(
    0,
  );
  await recordParseLearning(db, { noteText: 'cà phê', kind: 'expense' }, 'one');
  sqlite.exec(
    "UPDATE parse_learning SET hit_count=9007199254740991 WHERE token_key='phe'",
  );
  await expect(
    recordParseLearning(
      db,
      { noteText: 'cà phê', kind: 'expense' },
      'overflow',
    ),
  ).rejects.toThrow('PARSE_LEARNING_OVERFLOW');
  expect(
    sqlite
      .prepare("SELECT hit_count FROM parse_learning WHERE token_key='ca'")
      .get()?.hit_count,
  ).toBe(1);
});

it('reads known debt names and ignores archived-parent learning targets without deleting history', async () => {
  await migrate(db);
  await seed(db, 'old');
  await createDebt(
    db,
    randomUUID(),
    randomUUID(),
    {
      counterpartyLabel: 'Hùng',
      direction: 'borrowed',
      amount: 500000,
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-10-23',
    },
    'old',
  );
  const context = await readClassifierContext(db);
  expect(context.knownCounterparties).toEqual(['Hùng']);
  const clock = {
    now: () => new Date('2026-10-23T09:00:00+07:00'),
    timeZone: 'Asia/Ho_Chi_Minh',
  };
  expect(
    parseEntry('trả nợ Hùng 30k', { clock, ...context }).candidates[0].kind,
  ).toBe('debt_repay_paid');
  expect(
    parseEntry('Lan trả nợ 30k', { clock, ...context }).candidates[0].kind,
  ).toBe('unknown');
  const categories = await listCategories(db);
  const child = categories.find((c) => c.system_key === 'expense.food.coffee')!;
  await recordParseLearning(
    db,
    { noteText: 'sáng', kind: 'expense', categoryId: child.id },
    'one',
  );
  await recordParseLearning(
    db,
    { noteText: 'sáng', kind: 'expense', categoryId: child.id },
    'two',
  );
  await archiveCategory(db, child.parent_id!, null, 'archived');
  expect((await readClassifierContext(db)).learned[0]).toMatchObject({
    available: false,
    hitCount: 2,
    categoryId: child.id,
  });
  await expect(
    recordParseLearning(
      db,
      { noteText: 'sáng', kind: 'expense', categoryId: child.id },
      'bad',
    ),
  ).rejects.toThrow('CATEGORY_ARCHIVED');
});

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  db = {
    execAsync: async (sql) => {
      sqlite.exec(sql);
    },
    runAsync: async (sql, ...params) => sqlite.prepare(sql).run(...params),
    getAllAsync: async <T>(
      sql: string,
      ...params: (string | number | null)[]
    ) => sqlite.prepare(sql).all(...params) as T[],
    getFirstAsync: async <T>(
      sql: string,
      ...params: (string | number | null)[]
    ) => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
    transaction: async (task) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        await task(db);
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
});
afterEach(() => {
  sqlite.close();
  if (temporaryFile) {
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      rmSync(temporaryFile + suffix, { force: true });
    temporaryFile = undefined;
  }
});

it('tracks manual or wallet savings without adding them together and preserves archived goals', async () => {
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID();
  const input = {
    name: 'Laptop',
    targetAmount: 10000000,
    manualSavedAmount: 2000000,
  };
  await saveGoal(db, id, input, 'old', false);
  expect((await listGoals(db))[0]).toMatchObject({
    progress: 2000000,
    status: 'active',
  });
  await saveGoal(
    db,
    id,
    { ...input, fundingWalletId: DEFAULT_WALLET_ID },
    'next',
    true,
  );
  expect((await listGoals(db))[0].progress).toBe(0);
  await db.runAsync(
    'UPDATE wallets SET initial_balance=12000000 WHERE id=?',
    DEFAULT_WALLET_ID,
  );
  expect((await listGoals(db))[0]).toMatchObject({
    progress: 12000000,
    status: 'achieved',
  });
  await db.runAsync(
    'UPDATE wallets SET initial_balance=-2000000 WHERE id=?',
    DEFAULT_WALLET_ID,
  );
  expect((await listGoals(db))[0]).toMatchObject({
    progress: -2000000,
    status: 'active',
  });
  await setWalletArchived(db, DEFAULT_WALLET_ID, true, 'next');
  await saveGoal(
    db,
    id,
    { ...input, fundingWalletId: DEFAULT_WALLET_ID },
    'next',
    true,
  );
  await expect(
    saveGoal(
      db,
      randomUUID(),
      { ...input, fundingWalletId: DEFAULT_WALLET_ID },
      'next',
      false,
    ),
  ).rejects.toThrow('WALLET_ARCHIVED');
  await saveGoal(db, id, input, 'next', true);
  expect((await listGoals(db))[0].progress).toBe(2000000);
  await archiveGoal(db, id, 'next');
  expect((await listGoals(db))[0].status).toBe('archived');
  await expect(saveGoal(db, id, input, 'next', true)).rejects.toThrow(
    'GOAL_NOT_EDITABLE',
  );
  await expect(
    saveGoal(db, randomUUID(), { ...input, targetAmount: 0 }, 'next', false),
  ).rejects.toThrow();
});

it('restores only the selected category and its parent when needed, preserving siblings and history', async () => {
  await migrate(db);
  await seed(db, 'old');
  const categories = await listCategories(db);
  const parent = categories.find((c) => c.system_key === 'expense.food')!;
  const children = categories.filter((c) => c.parent_id === parent.id);
  expect(children.length).toBeGreaterThan(1);
  const [child, sibling] = children;
  await createBudget(
    db,
    randomUUID(),
    { amount: 100000, categoryId: child.id, startMonth: '2026-10' },
    'old',
  );
  await createTransaction(
    db,
    randomUUID(),
    {
      kind: 'expense',
      amount: 10000,
      walletId: DEFAULT_WALLET_ID,
      categoryId: child.id,
      occurredOn: '2026-10-26',
      occurredAt: '2026-10-26T05:00:00Z',
    },
    'old',
  );
  const transactions = await listTransactions(db),
    budgets = await readBudgetMonth(db, '2026-10');
  await archiveCategory(db, parent.id, null, 'archive');
  await restoreCategory(db, parent.id, 'restore-parent');
  expect((await listCategories(db)).some((c) => c.id === child.id)).toBe(false);
  await archiveCategory(db, parent.id, null, 'archive');
  await restoreCategory(db, child.id, 'restore-child');
  expect((await requireActiveCategory(db, child.id, 'expense')).id).toBe(
    child.id,
  );
  expect((await requireActiveCategory(db, parent.id, 'expense')).id).toBe(
    parent.id,
  );
  expect(
    (await listCategories(db, true)).find((c) => c.id === sibling.id)
      ?.is_archived,
  ).toBe(1);
  await restoreCategory(db, child.id, 'repeat');
  expect(await listTransactions(db)).toEqual(transactions);
  expect(await readBudgetMonth(db, '2026-10')).toEqual(budgets);
  await expect(restoreCategory(db, randomUUID(), 'missing')).rejects.toThrow(
    'CATEGORY_NOT_FOUND',
  );
});

it('rolls back child and parent restoration together if the database write fails', async () => {
  await migrate(db);
  await seed(db, 'old');
  const categories = await listCategories(db);
  const child = categories.find((c) => c.parent_id)!;
  await archiveCategory(db, child.parent_id!, null, 'archive');
  await db.execAsync(
    `CREATE TRIGGER fail_restore BEFORE UPDATE OF is_archived ON categories WHEN NEW.id='${child.id}' AND NEW.is_archived=0 BEGIN SELECT RAISE(ABORT,'restore failed'); END;`,
  );
  await expect(restoreCategory(db, child.id, 'restore')).rejects.toThrow(
    'restore failed',
  );
  const rows = await listCategories(db, true);
  expect(rows.find((c) => c.id === child.id)?.is_archived).toBe(1);
  expect(rows.find((c) => c.id === child.parent_id)?.is_archived).toBe(1);
});

it('catches up 40 daily occurrences once, honors skips on delete/move and preserves edits', async () => {
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID();
  const input = {
    kind: 'expense',
    amount: 100,
    walletId: DEFAULT_WALLET_ID,
    frequency: 'daily',
    startOn: '2026-09-01',
  } as const;
  await saveRecurringRule(db, id, input, '2026-09-01T00:00:00Z', false);
  expect(
    (await generateRecurring(db, '2026-10-10', 'now', randomUUID)).created,
  ).toBe(40);
  expect(
    (await generateRecurring(db, '2026-10-10', 'now', randomUUID)).created,
  ).toBe(0);
  const rows = await listTransactions(db),
    deleted = rows[1];
  await deleteTransaction(db, deleted.id);
  const moved = rows[0];
  await updateTransaction(
    db,
    moved.id,
    {
      kind: 'expense',
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-11-01',
      occurredAt: '2026-11-01T05:00:00Z',
      amount: 200,
    },
    'changed',
  );
  // Force a rescan to prove durable skip records, independently of the cursor.
  await db.runAsync(
    'UPDATE recurring_rules SET last_generated_on=NULL WHERE id=?',
    id,
  );
  expect(
    (await generateRecurring(db, '2026-10-10', 'now', randomUUID)).created,
  ).toBe(0);
  expect(
    (await listTransactions(db)).find((t) => t.id === moved.id)?.amount,
  ).toBe(200);
  await undoDeleteTransaction(db, deleted);
  await saveRecurringRule(db, id, { ...input, amount: 300 }, 'changed', true);
  expect(
    (await generateRecurring(db, '2026-10-11', 'now', randomUUID)).created,
  ).toBe(1);
  expect(
    (await listTransactions(db)).find((t) => t.occurred_on === '2026-10-11')
      ?.amount,
  ).toBe(300);
  expect(
    (await listTransactions(db)).find((t) => t.id === deleted.id)?.amount,
  ).toBe(100);
});

it('distinguishes archived-reference catch-up from explicit pause and bounds each run', async () => {
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID();
  const input = {
    kind: 'income',
    amount: 100,
    walletId: DEFAULT_WALLET_ID,
    frequency: 'daily',
    startOn: '2026-01-01',
    endOn: '2026-01-10',
  } as const;
  await saveRecurringRule(db, id, input, 'old', false);
  await setWalletArchived(db, DEFAULT_WALLET_ID, true, 'old');
  expect(
    (await generateRecurring(db, '2026-01-05', 'now', randomUUID)).created,
  ).toBe(0);
  expect((await listRecurringRules(db))[0].last_generated_on).toBeNull();
  await setWalletArchived(db, DEFAULT_WALLET_ID, false, 'old');
  expect(
    await generateRecurring(db, '2026-01-05', 'now', randomUUID, 2),
  ).toMatchObject({ created: 2, hasMore: true });
  expect(
    (await generateRecurring(db, '2026-01-05', 'now', randomUUID)).created,
  ).toBe(3);
  await setRecurringActive(db, id, false, '2026-01-06', 'paused');
  expect(
    (await generateRecurring(db, '2026-01-08', 'now', randomUUID)).created,
  ).toBe(0);
  await setRecurringActive(db, id, true, '2026-01-09', 'resumed');
  expect(
    (await generateRecurring(db, '2026-01-12', 'now', randomUUID)).created,
  ).toBe(2);
  const dates = (await listTransactions(db)).map((t) => t.occurred_on);
  expect(dates).not.toContain('2026-01-06');
  expect(dates).toContain('2026-01-09');
  expect(dates).not.toContain('2026-01-11');
  await expect(
    saveRecurringRule(db, randomUUID(), { ...input, amount: 0 }, 'now', false),
  ).rejects.toThrow();
});

it('blocks archived categories, preserves transfer balances and enforces the default 366 occurrence cap', async () => {
  await migrate(db);
  await seed(db, 'old');
  const parent = (await listCategories(db)).find(
    (c) => c.system_key === 'expense.food',
  )!;
  const id = randomUUID();
  await saveRecurringRule(
    db,
    id,
    {
      kind: 'expense',
      amount: 100,
      walletId: DEFAULT_WALLET_ID,
      categoryId: parent.id,
      frequency: 'daily',
      startOn: '2025-01-01',
    },
    'old',
    false,
  );
  await archiveCategory(db, parent.id, null, 'archived');
  expect(
    (await generateRecurring(db, '2026-01-02', 'now', randomUUID)).created,
  ).toBe(0);
  await restoreCategory(db, parent.id, 'restored');
  expect(
    await generateRecurring(db, '2026-01-02', 'now', randomUUID),
  ).toMatchObject({ created: 366, hasMore: true });
  expect(
    (await generateRecurring(db, '2026-01-02', 'now', randomUUID)).created,
  ).toBe(1);
  const destination = randomUUID();
  await createWallet(
    db,
    destination,
    { name: 'Destination', kind: 'bank' },
    'old',
  );
  const transfer = randomUUID();
  await saveRecurringRule(
    db,
    transfer,
    {
      kind: 'transfer',
      amount: 1000,
      walletId: DEFAULT_WALLET_ID,
      toWalletId: destination,
      frequency: 'monthly',
      startOn: '2026-01-31',
    },
    'old',
    false,
  );
  await setWalletArchived(db, destination, true, 'old');
  expect(
    (await generateRecurring(db, '2026-01-31', 'now', randomUUID)).created,
  ).toBe(29);
  await setWalletArchived(db, destination, false, 'old');
  expect(
    (await generateRecurring(db, '2026-01-31', 'now', randomUUID)).created,
  ).toBe(1);
  expect(
    (await listWallets(db)).find((w) => w.id === destination)?.balance,
  ).toBe(1000);
  expect((await listWallets(db)).reduce((sum, w) => sum + w.balance, 0)).toBe(
    -39600,
  );
});

it('rolls back generated rows, cursor and conflicting moves atomically', async () => {
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID();
  await saveRecurringRule(
    db,
    id,
    {
      kind: 'income',
      amount: 100,
      walletId: DEFAULT_WALLET_ID,
      frequency: 'daily',
      startOn: '2026-10-01',
    },
    'old',
    false,
  );
  await expect(
    generateRecurring(db, '2026-10-02', 'now', () => 'duplicate'),
  ).rejects.toThrow();
  expect(await listTransactions(db)).toEqual([]);
  expect((await listRecurringRules(db))[0].last_generated_on).toBeNull();
  await generateRecurring(db, '2026-10-02', 'now', randomUUID);
  const [latest, earlier] = await listTransactions(db);
  await expect(
    updateTransaction(
      db,
      earlier.id,
      {
        kind: 'income',
        amount: 100,
        walletId: DEFAULT_WALLET_ID,
        occurredOn: latest.occurred_on,
        occurredAt: latest.occurred_at,
      },
      'changed',
    ),
  ).rejects.toThrow();
  expect(await db.getAllAsync('SELECT * FROM recurring_skips')).toEqual([]);
  expect(
    (await listTransactions(db)).find((row) => row.id === earlier.id)
      ?.occurred_on,
  ).toBe('2026-10-01');
});

it('persists recurring rules, skip records and catch-up cursor across a real file reopen', async () => {
  sqlite.close();
  temporaryFile = join(tmpdir(), `pfm-recurring-${randomUUID()}.db`);
  sqlite = new DatabaseSync(temporaryFile);
  sqlite.exec('PRAGMA foreign_keys=ON');
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID();
  await saveRecurringRule(
    db,
    id,
    {
      kind: 'income',
      amount: 100,
      walletId: DEFAULT_WALLET_ID,
      frequency: 'daily',
      startOn: '2026-10-01',
    },
    'old',
    false,
  );
  await generateRecurring(db, '2026-10-03', 'now', randomUUID);
  const deleted = (await listTransactions(db))[0];
  await deleteTransaction(db, deleted.id);
  sqlite.close();
  sqlite = new DatabaseSync(temporaryFile);
  sqlite.exec('PRAGMA foreign_keys=ON');
  await migrate(db);
  expect((await listRecurringRules(db))[0].last_generated_on).toBe(
    '2026-10-03',
  );
  await db.runAsync(
    'UPDATE recurring_rules SET last_generated_on=NULL WHERE id=?',
    id,
  );
  expect(
    (await generateRecurring(db, '2026-10-04', 'now', randomUUID)).created,
  ).toBe(1);
  expect((await listTransactions(db)).map((row) => row.occurred_on)).toEqual([
    '2026-10-04',
    '2026-10-02',
    '2026-10-01',
  ]);
  expect((await listWallets(db))[0].balance).toBe(300);
});

it('summarizes monthly finances, parent-only categories, recent entries and six calendar months', async () => {
  await migrate(db);
  await seed(db, 'old');
  const cats = await listCategories(db),
    parent = cats.find((c) => c.system_key === 'expense.food')!,
    child = cats.find((c) => c.parent_id === parent.id)!;
  const insert = sqlite.prepare(
    `INSERT INTO transactions (id,kind,amount,wallet_id,category_id,occurred_on,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'old','old')`,
  );
  for (const [kind, amount, category, date] of [
    ['income', 15000000, null, '2026-10-01'],
    ['expense', 4000000, parent.id, '2026-10-01'],
    ['expense', 3000000, child.id, '2026-10-31'],
    ['expense', 2000000, null, '2026-10-15'],
    ['expense', 10000000, null, '2026-09-30'],
    ['expense', 123, null, '2026-11-01'],
  ] as const)
    insert.run(
      randomUUID(),
      kind,
      amount,
      DEFAULT_WALLET_ID,
      category,
      date,
      `${date}T05:00:00Z`,
    );
  const other = randomUUID();
  await createWallet(db, other, { name: 'Other', kind: 'bank' }, 'old');
  await createTransaction(
    db,
    randomUUID(),
    {
      kind: 'transfer',
      amount: 500,
      walletId: DEFAULT_WALLET_ID,
      toWalletId: other,
      occurredOn: '2026-10-10',
      occurredAt: '2026-10-10T05:00:00Z',
    },
    'old',
  );
  await archiveCategory(db, parent.id, null, 'archived');
  const result = await readDashboard(db, '2026-10');
  expect(result.current).toEqual({
    month: '2026-10',
    income: 15000000,
    expense: 9000000,
    net: 6000000,
  });
  expect(result.expenseChangeBps).toBe(-1000);
  expect(result.incomeChangeBps).toBeNull();
  expect(result.months.map((m) => m.month)).toEqual([
    '2026-05',
    '2026-06',
    '2026-07',
    '2026-08',
    '2026-09',
    '2026-10',
  ]);
  expect(result.categories).toEqual([
    { id: parent.id, name: parent.name, amount: 7000000 },
    { id: null, name: null, amount: 2000000 },
  ]);
  expect(result.recent).toHaveLength(5);
  expect(result.recent[0].occurred_on).toBe('2026-10-31');
  expect(result.recent.every((t) => t.occurred_on.startsWith('2026-10'))).toBe(
    true,
  );
  const empty = await readDashboard(db, '2027-01');
  expect(empty.current.expense).toBe(0);
  expect(empty.categories).toEqual([]);
  expect(empty.recent).toEqual([]);
  await expect(readDashboard(db, '2026-13')).rejects.toThrow();
});

it('keeps top six expense groups and sums the remainder exactly without losing uncategorized data', async () => {
  await migrate(db);
  await seed(db, 'old');
  for (let i = 0; i < 8; i++) {
    const id = randomUUID();
    await createCategory(
      db,
      id,
      { name: `Parent ${i}`, kind: 'expense' },
      'old',
    );
    await createTransaction(
      db,
      randomUUID(),
      {
        kind: 'expense',
        amount: (i + 1) * 100,
        walletId: DEFAULT_WALLET_ID,
        categoryId: id,
        occurredOn: '2026-10-26',
        occurredAt: '2026-10-26T05:00:00Z',
      },
      'old',
    );
  }
  await createTransaction(
    db,
    randomUUID(),
    {
      kind: 'expense',
      amount: 50,
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-10-26',
      occurredAt: '2026-10-26T05:00:00Z',
    },
    'old',
  );
  const result = await readDashboard(db, '2026-10');
  expect(result.topCategories.map((c) => c.amount)).toEqual([
    800, 700, 600, 500, 400, 300,
  ]);
  expect(result.otherCategoryAmount).toBe(350);
  expect(result.categories.find((c) => c.id === null)?.amount).toBe(50);
  expect(
    result.topCategories.reduce((sum, c) => sum + c.amount, 0) +
      result.otherCategoryAmount,
  ).toBe(3650);
});

it('returns an empty overview and excludes all debt cash flows from monthly income and expense', async () => {
  await migrate(db);
  const empty = await readDashboard(db, '2026-10');
  expect(empty.balance).toBe(0);
  expect(empty.current).toEqual({
    month: '2026-10',
    income: 0,
    expense: 0,
    net: 0,
  });
  expect(empty.budgets).toEqual([]);
  expect(empty.goals).toEqual([]);
  expect(empty.recent).toEqual([]);
  await seed(db, 'old');
  await db.runAsync(
    "INSERT INTO debts (id,counterparty_label,direction,created_at,updated_at) VALUES ('debt','Synthetic','borrowed','old','old')",
  );
  for (const kind of [
    'debt_borrow',
    'debt_lend',
    'debt_repay_paid',
    'debt_repay_received',
  ])
    await db.runAsync(
      "INSERT INTO transactions (id,kind,amount,wallet_id,debt_id,occurred_on,occurred_at,created_at,updated_at) VALUES (?,?,100000,?,'debt','2026-10-26','2026-10-26T05:00:00Z','old','old')",
      randomUUID(),
      kind,
      DEFAULT_WALLET_ID,
    );
  const result = await readDashboard(db, '2026-10');
  expect(result.current).toEqual(empty.current);
  expect(result.categories).toEqual([]);
  expect(result.recent).toHaveLength(4);
});

it('shows only applicable active budgets and current non-archived goals in an overview', async () => {
  await migrate(db);
  await seed(db, 'old');
  const active = randomUUID(),
    paused = randomUUID(),
    future = randomUUID();
  await createBudget(
    db,
    active,
    { amount: 1000, startMonth: '2026-10' },
    'old',
  );
  await createBudget(
    db,
    paused,
    { amount: 2000, startMonth: '2026-10' },
    'old',
  );
  await setBudgetActive(db, paused, false, 'paused');
  await createBudget(
    db,
    future,
    { amount: 3000, startMonth: '2026-11' },
    'old',
  );
  const goal = randomUUID(),
    archived = randomUUID();
  await saveGoal(
    db,
    goal,
    { name: 'Current', targetAmount: 1000, manualSavedAmount: 1200 },
    'old',
    false,
  );
  await saveGoal(
    db,
    archived,
    { name: 'Archived', targetAmount: 1000 },
    'old',
    false,
  );
  await archiveGoal(db, archived, 'archived');
  const result = await readDashboard(db, '2026-10');
  expect(result.budgets.map((b) => b.id)).toEqual([active]);
  expect(result.goals).toHaveLength(1);
  expect(result.goals[0]).toMatchObject({
    id: goal,
    status: 'achieved',
    progress: 1200,
  });
});

it('borrows and repays atomically, rejects overpay, and reconciles delete/undo/edit with wallet balances', async () => {
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID();
  await createDebt(
    db,
    id,
    randomUUID(),
    {
      counterpartyLabel: 'Synthetic lender',
      direction: 'borrowed',
      amount: 1000000,
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-10-26',
    },
    'old',
  );
  expect((await listDebts(db))[0]).toMatchObject({
    outstanding: 1000000,
    status: 'open',
  });
  const repayment = randomUUID();
  await repayDebt(
    db,
    id,
    repayment,
    { amount: 400000, walletId: DEFAULT_WALLET_ID, occurredOn: '2026-10-26' },
    'paid',
  );
  expect((await listDebts(db))[0].outstanding).toBe(600000);
  await expect(
    repayDebt(
      db,
      id,
      randomUUID(),
      { amount: 600001, walletId: DEFAULT_WALLET_ID, occurredOn: '2026-10-26' },
      'paid',
    ),
  ).rejects.toThrow('DEBT_OVERPAY');
  const rest = randomUUID();
  await repayDebt(
    db,
    id,
    rest,
    { amount: 600000, walletId: DEFAULT_WALLET_ID, occurredOn: '2026-10-26' },
    'closed',
  );
  expect((await listDebts(db))[0]).toMatchObject({
    outstanding: 0,
    status: 'closed',
  });
  expect((await listWallets(db))[0].balance).toBe(0);
  const snapshot = await deleteTransaction(db, rest);
  expect((await listDebts(db))[0]).toMatchObject({
    outstanding: 600000,
    status: 'open',
  });
  await undoDeleteTransaction(db, snapshot);
  expect((await listDebts(db))[0].status).toBe('closed');
  await updateTransaction(
    db,
    rest,
    {
      kind: 'debt_repay_paid',
      amount: 500000,
      walletId: DEFAULT_WALLET_ID,
      debtId: id,
      occurredOn: '2026-10-26',
      occurredAt: '2026-10-26T05:00:00Z',
    },
    'edit',
  );
  expect((await listDebts(db))[0].outstanding).toBe(100000);
  const principal = (await listTransactions(db)).find(
    (row) => row.kind === 'debt_borrow',
  )!;
  await expect(deleteTransaction(db, principal.id)).rejects.toThrow(
    'DEBT_OVERPAY',
  );
  const overview = await readDashboard(db, '2026-10');
  expect(overview.current.income).toBe(0);
  expect(overview.current.expense).toBe(0);
});

it('tracks lent money in the opposite direction and rejects wrong debt kinds and archived new wallets', async () => {
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID();
  await createDebt(
    db,
    id,
    randomUUID(),
    {
      counterpartyLabel: 'Synthetic borrower',
      direction: 'lent',
      amount: 1000,
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-10-26',
    },
    'old',
  );
  await repayDebt(
    db,
    id,
    randomUUID(),
    { amount: 400, walletId: DEFAULT_WALLET_ID, occurredOn: '2026-10-26' },
    'paid',
  );
  expect((await listWallets(db))[0].balance).toBe(-600);
  expect((await listDebts(db))[0].outstanding).toBe(600);
  await expect(
    createTransaction(
      db,
      randomUUID(),
      {
        kind: 'debt_repay_paid',
        amount: 100,
        walletId: DEFAULT_WALLET_ID,
        debtId: id,
        occurredOn: '2026-10-26',
        occurredAt: '2026-10-26T05:00:00Z',
      },
      'bad',
    ),
  ).rejects.toThrow('DEBT_DIRECTION');
  await setWalletArchived(db, DEFAULT_WALLET_ID, true, 'archived');
  await expect(
    repayDebt(
      db,
      id,
      randomUUID(),
      { amount: 100, walletId: DEFAULT_WALLET_ID, occurredOn: '2026-10-26' },
      'bad',
    ),
  ).rejects.toThrow('WALLET_ARCHIVED');
  await updateDebt(
    db,
    id,
    { counterpartyLabel: 'Renamed', dueOn: '2026-11-01', note: 'Local only' },
    'edited',
  );
  expect((await listDebts(db))[0]).toMatchObject({
    counterparty_label: 'Renamed',
    due_on: '2026-11-01',
    outstanding: 600,
  });
});

it('rolls back invalid debt creation, principal edits and stale repayment undo without affecting another debt', async () => {
  await migrate(db);
  await seed(db, 'old');
  const input = {
    counterpartyLabel: 'Synthetic',
    direction: 'borrowed',
    amount: 1000,
    walletId: DEFAULT_WALLET_ID,
    occurredOn: '2026-10-26',
  } as const;
  await setWalletArchived(db, DEFAULT_WALLET_ID, true, 'old');
  await expect(
    createDebt(db, randomUUID(), randomUUID(), input, 'old'),
  ).rejects.toThrow('WALLET_ARCHIVED');
  expect(await listDebts(db)).toEqual([]);
  await setWalletArchived(db, DEFAULT_WALLET_ID, false, 'old');
  const id = randomUUID(),
    other = randomUUID(),
    principalId = randomUUID();
  await createDebt(db, id, principalId, input, 'old');
  await createDebt(db, other, randomUUID(), input, 'old');
  const destination = randomUUID();
  await createWallet(
    db,
    destination,
    { name: 'Repay wallet', kind: 'bank', initialBalance: 1000 },
    'old',
  );
  const repayment = randomUUID();
  await repayDebt(
    db,
    id,
    repayment,
    { amount: 1000, walletId: destination, occurredOn: '2026-10-26' },
    'paid',
  );
  expect(
    (await listWallets(db)).find((row) => row.id === destination)?.balance,
  ).toBe(0);
  const snapshot = await deleteTransaction(db, repayment);
  await repayDebt(
    db,
    id,
    randomUUID(),
    { amount: 1000, walletId: destination, occurredOn: '2026-10-26' },
    'replacement',
  );
  await expect(undoDeleteTransaction(db, snapshot)).rejects.toThrow(
    'DEBT_OVERPAY',
  );
  await expect(
    updateTransaction(
      db,
      principalId,
      {
        kind: 'debt_borrow',
        amount: 999,
        walletId: DEFAULT_WALLET_ID,
        debtId: id,
        occurredOn: '2026-10-26',
        occurredAt: '2026-10-26T05:00:00Z',
      },
      'bad',
    ),
  ).rejects.toThrow('DEBT_OVERPAY');
  await expect(
    updateTransaction(
      db,
      principalId,
      {
        kind: 'debt_borrow',
        amount: 1000,
        walletId: DEFAULT_WALLET_ID,
        debtId: other,
        occurredOn: '2026-10-26',
        occurredAt: '2026-10-26T05:00:00Z',
      },
      'bad',
    ),
  ).rejects.toThrow('DEBT_TRANSACTION_KIND');
  expect((await listDebts(db)).find((row) => row.id === id)?.outstanding).toBe(
    0,
  );
  expect(
    (await listDebts(db)).find((row) => row.id === other)?.outstanding,
  ).toBe(1000);
  expect(
    (await listTransactions(db, undefined, { debtId: id })).every(
      (row) => row.debt_id === id,
    ),
  ).toBe(true);
});

it('persists loan metadata, derived balance, payoff state and wallet effects across a real file reopen', async () => {
  sqlite.close();
  temporaryFile = join(tmpdir(), `pfm-debt-${randomUUID()}.db`);
  sqlite = new DatabaseSync(temporaryFile);
  sqlite.exec('PRAGMA foreign_keys=ON');
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID();
  await createDebt(
    db,
    id,
    randomUUID(),
    {
      counterpartyLabel: 'Persistent',
      direction: 'lent',
      amount: 1000,
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-10-26',
      dueOn: '2026-11-01',
    },
    'old',
  );
  await repayDebt(
    db,
    id,
    randomUUID(),
    { amount: 400, walletId: DEFAULT_WALLET_ID, occurredOn: '2026-10-26' },
    'paid',
  );
  sqlite.close();
  sqlite = new DatabaseSync(temporaryFile);
  sqlite.exec('PRAGMA foreign_keys=ON');
  await migrate(db);
  expect((await listDebts(db))[0]).toMatchObject({
    counterparty_label: 'Persistent',
    outstanding: 600,
    status: 'open',
    due_on: '2026-11-01',
  });
  expect((await listWallets(db))[0].balance).toBe(-600);
});

it('paginates a debt with 51 cash flows without mixing other debts or losing the principal', async () => {
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID(),
    other = randomUUID(),
    principal = randomUUID();
  const input = {
    counterpartyLabel: 'Long history',
    direction: 'borrowed',
    amount: 1000,
    walletId: DEFAULT_WALLET_ID,
    occurredOn: '2026-10-01',
  } as const;
  await createDebt(db, id, principal, input, 'old');
  await createDebt(db, other, randomUUID(), input, 'old');
  for (let i = 0; i < 50; i++)
    await repayDebt(
      db,
      id,
      randomUUID(),
      { amount: 1, walletId: DEFAULT_WALLET_ID, occurredOn: '2026-10-26' },
      'paid',
    );
  const first = await listTransactions(db, undefined, { debtId: id });
  expect(first).toHaveLength(50);
  expect(first.some((row) => row.id === principal)).toBe(false);
  const second = await listTransactions(db, first.at(-1), { debtId: id });
  expect(second.map((row) => row.id)).toEqual([principal]);
  expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(51);
  expect((await listDebts(db)).find((row) => row.id === id)?.outstanding).toBe(
    950,
  );
});

it('restores goals using current progress without modifying money or archived wallets', async () => {
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID();
  await saveGoal(
    db,
    id,
    { name: 'Saved goal', targetAmount: 100, manualSavedAmount: 120 },
    'old',
    false,
  );
  await archiveGoal(db, id, 'archived');
  await restoreGoal(db, id, 'restored');
  expect((await listGoals(db))[0]).toMatchObject({
    status: 'achieved',
    progress: 120,
  });
  await saveGoal(
    db,
    id,
    {
      name: 'Wallet goal',
      targetAmount: 100,
      fundingWalletId: DEFAULT_WALLET_ID,
    },
    'changed',
    true,
  );
  await archiveGoal(db, id, 'archived');
  await setWalletArchived(db, DEFAULT_WALLET_ID, true, 'archived');
  await restoreGoal(db, id, 'restored');
  expect((await listGoals(db))[0]).toMatchObject({
    status: 'active',
    progress: 0,
    funding_wallet_id: DEFAULT_WALLET_ID,
  });
  expect((await listWallets(db, true))[0].is_archived).toBe(1);
  expect(await listTransactions(db)).toEqual([]);
  await restoreGoal(db, id, 'again');
  expect((await listGoals(db))[0].status).toBe('active');
  await expect(restoreGoal(db, randomUUID(), 'missing')).rejects.toThrow(
    'GOAL_NOT_FOUND',
  );
});

it('counts only monthly expenses, including children and archived categories, for independent parent and child budgets', async () => {
  await migrate(db);
  await seed(db, 'old');
  const cats = await listCategories(db),
    parent = cats.find((c) => c.system_key === 'expense.food')!,
    child = cats.find((c) => c.parent_id === parent.id)!;
  const overall = randomUUID(),
    parentBudget = randomUUID(),
    childBudget = randomUUID();
  await createBudget(
    db,
    overall,
    { amount: 3000000, startMonth: '2026-10' },
    'old',
  );
  await createBudget(
    db,
    parentBudget,
    { amount: 1000000, categoryId: parent.id, startMonth: '2026-10' },
    'old',
  );
  await createBudget(
    db,
    childBudget,
    { amount: 500000, categoryId: child.id, startMonth: '2026-10' },
    'old',
  );
  const insert = sqlite.prepare(
    `INSERT INTO transactions (id,kind,amount,wallet_id,category_id,occurred_on,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'2026-10-26T05:00:00Z','old','old')`,
  );
  insert.run(
    'budget-child',
    'expense',
    200000,
    DEFAULT_WALLET_ID,
    child.id,
    '2026-10-31',
  );
  insert.run(
    'budget-parent',
    'expense',
    100000,
    DEFAULT_WALLET_ID,
    parent.id,
    '2026-10-01',
  );
  insert.run(
    'budget-null',
    'expense',
    50000,
    DEFAULT_WALLET_ID,
    null,
    '2026-10-26',
  );
  insert.run(
    'budget-income',
    'income',
    900000,
    DEFAULT_WALLET_ID,
    null,
    '2026-10-26',
  );
  insert.run(
    'budget-nov',
    'expense',
    900000,
    DEFAULT_WALLET_ID,
    child.id,
    '2026-11-01',
  );
  const bank = randomUUID();
  await createWallet(db, bank, { name: 'Bank', kind: 'bank' }, 'old');
  sqlite
    .prepare(
      `INSERT INTO transactions (id,kind,amount,wallet_id,to_wallet_id,occurred_on,occurred_at,created_at,updated_at) VALUES ('budget-transfer','transfer',800000,?,?,'2026-10-26','2026-10-26T05:00:00Z','old','old')`,
    )
    .run(DEFAULT_WALLET_ID, bank);
  sqlite
    .prepare(
      `INSERT INTO debts (id,counterparty_label,direction,created_at,updated_at) VALUES ('budget-debt','Synthetic','borrowed','old','old')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO transactions (id,kind,amount,wallet_id,debt_id,occurred_on,occurred_at,created_at,updated_at) VALUES ('budget-debt-tx','debt_borrow',900000,?,'budget-debt','2026-10-26','2026-10-26T05:00:00Z','old','old')`,
    )
    .run(DEFAULT_WALLET_ID);
  const october = await readBudgetMonth(db, '2026-10');
  expect(october.find((b) => b.id === overall)?.spent).toBe(350000);
  expect(october.find((b) => b.id === parentBudget)?.spent).toBe(300000);
  expect(october.find((b) => b.id === childBudget)?.spent).toBe(200000);
  expect(
    (await readBudgetMonth(db, '2026-11')).find((b) => b.id === parentBudget)
      ?.spent,
  ).toBe(900000);
  await archiveCategory(db, parent.id, null, 'archive');
  expect(
    (await readBudgetMonth(db, '2026-10')).find((b) => b.id === parentBudget),
  ).toMatchObject({ spent: 300000, category_archived: 1 });
  await expect(
    createBudget(
      db,
      randomUUID(),
      { amount: 1000, categoryId: parent.id, startMonth: '2026-10' },
      'new',
    ),
  ).rejects.toThrow('CATEGORY_ARCHIVED');
  await updateBudget(
    db,
    parentBudget,
    { amount: 2000000, categoryId: parent.id, startMonth: '2026-10' },
    'new',
  );
});

it('claims budget thresholds once per budget/month/threshold across delete, recross, edits and pause', async () => {
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID(),
    tx = randomUUID();
  await createBudget(db, id, { amount: 3000000, startMonth: '2026-10' }, 'old');
  const input = {
    kind: 'expense',
    amount: 2399999,
    walletId: DEFAULT_WALLET_ID,
    occurredOn: '2026-10-26',
    occurredAt: '2026-10-26T05:00:00Z',
  } as const;
  await createTransaction(db, tx, input, 'old');
  expect(await claimBudgetAlert(db, id, '2026-10', 80, 'now')).toBe(false);
  await updateTransaction(db, tx, { ...input, amount: 3000000 }, 'new');
  expect(await claimBudgetAlert(db, id, '2026-10', 80, 'now')).toBe(true);
  expect(await claimBudgetAlert(db, id, '2026-10', 100, 'now')).toBe(true);
  expect(await claimBudgetAlert(db, id, '2026-10', 80, 'again')).toBe(false);
  const deleted = await deleteTransaction(db, tx);
  await undoDeleteTransaction(db, deleted);
  expect(await claimBudgetAlert(db, id, '2026-10', 100, 'again')).toBe(false);
  await updateBudget(
    db,
    id,
    { amount: 4000000, startMonth: '2026-10' },
    'raise',
  );
  expect(await claimBudgetAlert(db, id, '2026-10', 80, 'again')).toBe(false);
  await updateBudget(
    db,
    id,
    { amount: 3000000, startMonth: '2026-10' },
    'lower',
  );
  expect(await claimBudgetAlert(db, id, '2026-10', 100, 'again')).toBe(false);
  await setBudgetActive(db, id, false, 'pause');
  expect(
    (await readBudgetMonth(db, '2026-10')).find((b) => b.id === id)?.is_active,
  ).toBe(0);
  expect(await claimBudgetAlert(db, id, '2026-11', 80, 'next')).toBe(false);
  await setBudgetActive(db, id, true, 'resume');
  await createTransaction(
    db,
    randomUUID(),
    {
      ...input,
      amount: 3000000,
      occurredOn: '2026-11-01',
      occurredAt: '2026-11-01T05:00:00Z',
    },
    'next',
  );
  expect(await claimBudgetAlert(db, id, '2026-11', 80, 'next')).toBe(true);
  await releaseBudgetAlert(db, id, '2026-11', 80);
  expect(await claimBudgetAlert(db, id, '2026-11', 80, 'retry')).toBe(true);
});

it('rejects invalid budget ranges, amounts and income categories and excludes out-of-period alerts', async () => {
  await migrate(db);
  await seed(db, 'old');
  const income = (await listCategories(db)).find((c) => c.kind === 'income')!,
    id = randomUUID();
  await expect(
    createBudget(db, id, { amount: 0, startMonth: '2026-10' }, 'old'),
  ).rejects.toThrow();
  await expect(
    createBudget(
      db,
      id,
      { amount: 1000, startMonth: '2026-11', endMonth: '2026-10' },
      'old',
    ),
  ).rejects.toThrow();
  await expect(
    createBudget(
      db,
      id,
      { amount: 1000, startMonth: '2026-10', categoryId: income.id },
      'old',
    ),
  ).rejects.toThrow('CATEGORY_KIND');
  await createBudget(
    db,
    id,
    {
      amount: 1000,
      startMonth: '2026-10',
      endMonth: '2026-10',
      warnPercent: 100,
    },
    'old',
  );
  expect(
    (await readBudgetMonth(db, '2026-11')).find((b) => b.id === id)?.in_period,
  ).toBe(0);
  expect(await claimBudgetAlert(db, id, '2026-11', 100, 'next')).toBe(false);
  await expect(readBudgetMonth(db, '2026-13')).rejects.toThrow();
});

it('delivers budget alerts once, retains unclaimed alerts when denied and retries explicit delivery failures', async () => {
  await migrate(db);
  await seed(db, 'old');
  const id = randomUUID();
  await createBudget(db, id, { amount: 3000000, startMonth: '2026-10' }, 'old');
  await createTransaction(
    db,
    randomUUID(),
    {
      kind: 'expense',
      amount: 3000000,
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-10-26',
      occurredAt: '2026-10-26T05:00:00Z',
    },
    'old',
  );
  const sent: number[] = [];
  const port = {
    hasPermission: async () => true,
    send: async (_id: string, _month: string, threshold: number) => {
      sent.push(threshold);
    },
  };
  await processBudgetAlerts(db, '2026-10', {
    ...port,
    hasPermission: async () => false,
  });
  expect(
    sqlite.prepare('SELECT count(*) n FROM budget_alerts_sent').get()?.n,
  ).toBe(0);
  await expect(
    processBudgetAlerts(db, '2026-10', {
      ...port,
      send: async () => {
        throw new Error('explicit delivery failure');
      },
    }),
  ).rejects.toThrow('explicit delivery failure');
  expect(
    sqlite.prepare('SELECT count(*) n FROM budget_alerts_sent').get()?.n,
  ).toBe(0);
  await processBudgetAlerts(db, '2026-10', port);
  await processBudgetAlerts(db, '2026-10', port);
  expect(sent).toEqual([80, 100]);
  const warn100 = randomUUID();
  await createBudget(
    db,
    warn100,
    { amount: 3000000, startMonth: '2026-10', warnPercent: 100 },
    'new',
  );
  await setBudgetActive(db, warn100, false, 'pause');
  await processBudgetAlerts(db, '2026-10', port);
  expect(sent).toEqual([80, 100]);
  await setBudgetActive(db, warn100, true, 'resume');
  await processBudgetAlerts(db, '2026-10', port);
  expect(sent).toEqual([80, 100, 100]);
});

it('upgrades version 1 notes in bounded batches without changing original transaction fields', async () => {
  sqlite.close();
  temporaryFile = join(tmpdir(), `pfm-v1-upgrade-${randomUUID()}.db`);
  sqlite = new DatabaseSync(temporaryFile);
  sqlite.exec('PRAGMA foreign_keys=ON');
  await migrate(db, MIGRATIONS.slice(0, 1));
  await seed(db, 'old');
  const insert = sqlite.prepare(
    `INSERT INTO transactions (id,kind,amount,wallet_id,occurred_on,occurred_at,note,created_at,updated_at) VALUES (?,'expense',1000,?,'2026-10-26','2026-10-26T05:00:00Z',?,'old','old')`,
  );
  for (let n = 0; n < 205; n++)
    insert.run(
      String(n).padStart(3, '0'),
      DEFAULT_WALLET_ID,
      n === 204 ? null : 'Ăn sáng và ĐIỆN',
    );
  const original = sqlite
    .prepare('SELECT * FROM transactions ORDER BY id')
    .all();
  sqlite.close();
  sqlite = new DatabaseSync(temporaryFile);
  sqlite.exec('PRAGMA foreign_keys=ON');
  await migrate(db);
  const upgraded = sqlite
    .prepare('SELECT * FROM transactions ORDER BY id')
    .all();
  expect(upgraded).toEqual(
    original.map((row) => ({
      ...row,
      note_search: row.note === null ? '' : 'an sang va dien',
      original_currency: 'VND',
      original_amount_minor: row.amount,
      booking_rate: null,
    })),
  );
  expect(sqlite.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
  await migrate(db);
  expect(
    sqlite.prepare('SELECT * FROM transactions ORDER BY id').all(),
  ).toEqual(upgraded);
});

it('rolls back the search column and backfill together on upgrade failure', async () => {
  await migrate(db, MIGRATIONS.slice(0, 1));
  await seed(db, 'old');
  sqlite
    .prepare(
      `INSERT INTO transactions (id,kind,amount,wallet_id,occurred_on,occurred_at,note,created_at,updated_at) VALUES ('legacy','expense',1000,?,'2026-10-26','2026-10-26T05:00:00Z','Ăn sáng','old','old')`,
    )
    .run(DEFAULT_WALLET_ID);
  const original = sqlite.prepare('SELECT * FROM transactions').all();
  await expect(
    migrate(db, [
      MIGRATIONS[0],
      {
        ...MIGRATIONS[1],
        backfill: async (transaction) => {
          await MIGRATIONS[1].backfill!(transaction);
          throw new Error('injected backfill failure');
        },
      },
    ]),
  ).rejects.toThrow('injected backfill failure');
  expect(sqlite.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  expect(sqlite.prepare('SELECT * FROM transactions').all()).toEqual(original);
  await migrate(db);
  expect(
    await listTransactions(db, undefined, { text: 'an sang' }),
  ).toHaveLength(1);
});

it('searches Vietnamese notes and combines date, kind, wallet, category subtree and amount filters before pagination', async () => {
  await migrate(db);
  await seed(db, 'old');
  const bank = randomUUID();
  await createWallet(db, bank, { name: 'Bank', kind: 'bank' }, 'old');
  const cats = await listCategories(db),
    parent = cats.find((c) => c.system_key === 'expense.food')!,
    child = cats.find((c) => c.parent_id === parent.id)!;
  const rows = [
    {
      kind: 'expense',
      amount: 10000,
      categoryId: parent.id,
      occurredOn: '2026-10-26',
      note: 'Ăn sáng',
    },
    {
      kind: 'expense',
      amount: 20000,
      categoryId: child.id,
      occurredOn: '2026-10-27',
      note: 'ĐIỆN ở nhà',
    },
    {
      kind: 'income',
      amount: 30000,
      occurredOn: '2026-10-28',
      note: 'Thu nhập',
    },
    {
      kind: 'transfer',
      amount: 40000,
      toWalletId: bank,
      occurredOn: '2026-10-27',
      note: '_ % literal',
    },
    { kind: 'expense', amount: 5000, occurredOn: '2026-10-25', note: null },
  ] as const;
  const ids = rows.map(() => randomUUID());
  for (const [index, row] of rows.entries())
    await createTransaction(
      db,
      ids[index],
      {
        ...row,
        walletId: DEFAULT_WALLET_ID,
        occurredAt: `${row.occurredOn}T12:00:00+07:00`,
      },
      'old',
    );
  const query = async (filters: Parameters<typeof listTransactions>[2]) =>
    (await listTransactions(db, undefined, filters)).map((r) => r.id);
  expect(await query({ text: 'an sang' })).toEqual([ids[0]]);
  expect(await query({ text: '  DIE\u0302\u0323N  ' })).toEqual([ids[1]]);
  expect(await query({ text: '%' })).toEqual([ids[3]]);
  expect(await query({ text: '_' })).toEqual([ids[3]]);
  expect(await query({ text: "' OR 1=1 --" })).toEqual([]);
  expect(await query({ kind: 'income' })).toEqual([ids[2]]);
  expect(await query({ walletId: bank })).toEqual([ids[3]]);
  expect(new Set(await query({ categoryId: parent.id }))).toEqual(
    new Set([ids[0], ids[1]]),
  );
  expect(await query({ categoryId: child.id })).toEqual([ids[1]]);
  expect(new Set(await query({ from: '2026-10-27' }))).toEqual(
    new Set([ids[1], ids[2], ids[3]]),
  );
  expect(await query({ to: '2026-10-26' })).toEqual([ids[0], ids[4]]);
  expect(new Set(await query({ minAmount: 20000 }))).toEqual(
    new Set([ids[1], ids[2], ids[3]]),
  );
  expect(await query({ maxAmount: 10000 })).toEqual([ids[0], ids[4]]);
  expect(
    await query({
      from: '2026-10-27',
      to: '2026-10-27',
      kind: 'expense',
      walletId: DEFAULT_WALLET_ID,
      categoryId: parent.id,
      minAmount: 20000,
      maxAmount: 20000,
      text: 'dien',
    }),
  ).toEqual([ids[1]]);
  expect(await query({ minAmount: 5000, maxAmount: 10000 })).toEqual([
    ids[0],
    ids[4],
  ]);
  expect(await query({ text: 'does not exist' })).toEqual([]);
  await expect(query({ from: '2026-02-30' })).rejects.toThrow();
  await expect(query({ minAmount: 30000, maxAmount: 10000 })).rejects.toThrow();
  await expect(
    query({ from: '2026-10-28', to: '2026-10-25' }),
  ).rejects.toThrow();
  await updateTransaction(
    db,
    ids[0],
    {
      ...rows[0],
      note: 'Cà phê',
      walletId: DEFAULT_WALLET_ID,
      occurredAt: '2026-10-26T05:00:00Z',
    },
    'new',
  );
  expect(await query({ text: 'an sang' })).toEqual([]);
  expect(await query({ text: 'ca phe' })).toEqual([ids[0]]);
  const deleted = await deleteTransaction(db, ids[0]);
  await undoDeleteTransaction(db, deleted);
  expect(await query({ text: 'ca phe' })).toEqual([ids[0]]);
  await archiveCategory(db, parent.id, null, 'archive');
  await setWalletArchived(db, bank, true, 'archive');
  expect(new Set(await query({ categoryId: parent.id }))).toEqual(
    new Set([ids[0], ids[1]]),
  );
  expect(await query({ walletId: bank })).toEqual([ids[3]]);
});

it('applies search and amount filters before paging tied timestamps', async () => {
  await migrate(db);
  await seed(db, 'old');
  const insert = sqlite.prepare(
    `INSERT INTO transactions (id,kind,amount,wallet_id,occurred_on,occurred_at,note,note_search,created_at,updated_at) VALUES (?,'expense',?,?,'2026-10-26','2026-10-26T05:00:00Z','Ăn sáng','an sang','old','old')`,
  );
  for (let n = 0; n < 210; n++)
    insert.run(
      String(n).padStart(3, '0'),
      n % 2 === 0 ? 10000 : 20000,
      DEFAULT_WALLET_ID,
    );
  const filters = { text: 'AN SANG', maxAmount: 10000 };
  const first = await listTransactions(db, undefined, filters),
    second = await listTransactions(db, first.at(-1), filters),
    third = await listTransactions(db, second.at(-1), filters);
  expect([first.length, second.length, third.length]).toEqual([50, 50, 5]);
  expect([...first, ...second, ...third].map((row) => row.id)).toEqual(
    Array.from({ length: 105 }, (_, i) => String(208 - i * 2).padStart(3, '0')),
  );
});

it('upgrades and queries 50000 synthetic transactions with the actual migration and repository', async () => {
  await migrate(db, MIGRATIONS.slice(0, 1));
  await seed(db, 'old');
  const insert = sqlite.prepare(
    `INSERT INTO transactions (id,kind,amount,wallet_id,occurred_on,occurred_at,note,created_at,updated_at) VALUES (?,'expense',1000,?,'2026-10-26','2026-10-26T05:00:00Z',?,'old','old')`,
  );
  await db.transaction(async () => {
    for (let n = 0; n < 50000; n++)
      insert.run(
        String(n).padStart(6, '0'),
        DEFAULT_WALLET_ID,
        n === 0 ? 'Ăn sáng' : 'Ghi chú tổng hợp',
      );
  });
  let start = performance.now();
  await migrate(db);
  const migrationMs = performance.now() - start;
  start = performance.now();
  const result = await listTransactions(db, undefined, {
    text: 'an sang',
    kind: 'expense',
    from: '2026-10-26',
    to: '2026-10-26',
    walletId: DEFAULT_WALLET_ID,
    minAmount: 1000,
    maxAmount: 1000,
  });
  const searchMs = performance.now() - start;
  expect(result.map((row) => row.id)).toEqual(['000000']);
  start = performance.now();
  const first = await listTransactions(db);
  const firstPageMs = performance.now() - start;
  start = performance.now();
  const history = await listTransactionHistory(db);
  const historyPageMs = performance.now() - start;
  expect(history.map((row) => row.id)).toEqual(first.map((row) => row.id));
  expect(history.map((row) => row.wallet_balance_after)).toEqual(
    Array.from({ length: 50 }, (_, i) => -(50000 - i) * 1000),
  );
  expect(
    (await listTransactionHistory(db, undefined, { text: 'an sang' }))[0]
      .wallet_balance_after,
  ).toBe(-1000);
  const aggregateBudget = randomUUID();
  await createBudget(
    db,
    aggregateBudget,
    { amount: 3000000, startMonth: '2026-10' },
    'old',
  );
  start = performance.now();
  expect(
    (await readBudgetMonth(db, '2026-10')).find((b) => b.id === aggregateBudget)
      ?.spent,
  ).toBe(50000000);
  const budgetMs = performance.now() - start;
  expect(first.map((row) => row.id)).toEqual(
    Array.from({ length: 50 }, (_, i) => String(49999 - i).padStart(6, '0')),
  );
  expect(
    sqlite
      .prepare('SELECT COUNT(*) count,SUM(amount) total FROM transactions')
      .get(),
  ).toEqual({ count: 50000, total: 50000000 });
  console.info(
    JSON.stringify({
      benchmark: 'T2.4-host-only',
      rows: 50000,
      migrationMs: Math.round(migrationMs),
      searchMs: Math.round(searchMs),
      firstPageMs: Math.round(firstPageMs),
      historyPageMs: Math.round(historyPageMs),
      budgetMs: Math.round(budgetMs),
    }),
  );
});

it('records income, expense and a single-row transfer, then edits its destination without double counting', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const bank = randomUUID(),
    other = randomUUID(),
    transfer = randomUUID();
  const stamp = '2026-10-26T05:00:00Z';
  await finishOnboarding(db, 1000000, stamp);
  await createWallet(db, bank, { name: 'Bank', kind: 'bank' }, stamp);
  await createWallet(db, other, { name: 'Other', kind: 'cash' }, stamp);
  const input = {
    kind: 'income',
    amount: 500000,
    walletId: DEFAULT_WALLET_ID,
    occurredOn: '2026-10-26',
    occurredAt: stamp,
  } as const;
  await createTransaction(db, randomUUID(), input, stamp);
  await createTransaction(
    db,
    randomUUID(),
    { ...input, kind: 'expense', amount: 200000 },
    stamp,
  );
  await createTransaction(
    db,
    transfer,
    { ...input, kind: 'transfer', amount: 300000, toWalletId: bank },
    stamp,
  );
  expect((await listWallets(db)).map((w) => w.balance)).toEqual([
    1000000, 300000, 0,
  ]);
  expect(await listTransactions(db)).toHaveLength(3);
  await updateTransaction(
    db,
    transfer,
    { ...input, kind: 'transfer', amount: 300000, toWalletId: other },
    stamp,
  );
  expect((await listWallets(db)).map((w) => w.balance)).toEqual([
    1000000, 0, 300000,
  ]);
  const deleted = await deleteTransaction(db, transfer);
  expect((await listWallets(db)).map((w) => w.balance)).toEqual([
    1300000, 0, 0,
  ]);
  await undoDeleteTransaction(db, deleted);
  expect((await listWallets(db)).map((w) => w.balance)).toEqual([
    1000000, 0, 300000,
  ]);
});

it('rejects invalid amounts, same-wallet transfers, archived references and wrong-kind categories without writes', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const stamp = '2026-10-26T05:00:00Z';
  const input = {
    kind: 'expense',
    amount: 30000,
    walletId: DEFAULT_WALLET_ID,
    occurredOn: '2026-10-26',
    occurredAt: stamp,
  } as const;
  for (const amount of [0, -1, 0.5, 100000000001, NaN])
    await expect(
      createTransaction(db, randomUUID(), { ...input, amount }, stamp),
    ).rejects.toThrow();
  await expect(
    createTransaction(
      db,
      randomUUID(),
      { ...input, kind: 'debt_borrow', debtId: randomUUID() },
      stamp,
    ),
  ).rejects.toThrow('DEBT_NOT_FOUND');
  await expect(
    createTransaction(
      db,
      randomUUID(),
      { ...input, source: 'recurring', recurringRuleId: randomUUID() },
      stamp,
    ),
  ).rejects.toThrow('TRANSACTION_FEATURE_PENDING');
  await expect(
    createTransaction(
      db,
      randomUUID(),
      { ...input, kind: 'transfer', toWalletId: DEFAULT_WALLET_ID },
      stamp,
    ),
  ).rejects.toThrow();
  const categories = await listCategories(db),
    income = categories.find((c) => c.kind === 'income')!,
    expense = categories.find((c) => c.kind === 'expense')!;
  const archivedDestination = randomUUID();
  await createWallet(
    db,
    archivedDestination,
    { name: 'Archived destination', kind: 'bank' },
    stamp,
  );
  await setWalletArchived(db, archivedDestination, true, stamp);
  await expect(
    createTransaction(
      db,
      randomUUID(),
      { ...input, kind: 'transfer', toWalletId: archivedDestination },
      stamp,
    ),
  ).rejects.toThrow('WALLET_ARCHIVED');
  await expect(
    createTransaction(
      db,
      randomUUID(),
      { ...input, categoryId: income.id },
      stamp,
    ),
  ).rejects.toThrow('CATEGORY_KIND');
  await archiveCategory(db, expense.id, null, stamp);
  await expect(
    createTransaction(
      db,
      randomUUID(),
      { ...input, categoryId: expense.id },
      stamp,
    ),
  ).rejects.toThrow('CATEGORY_ARCHIVED');
  await setWalletArchived(db, DEFAULT_WALLET_ID, true, stamp);
  await expect(
    createTransaction(db, randomUUID(), input, stamp),
  ).rejects.toThrow('WALLET_ARCHIVED');
  expect(await listTransactions(db)).toEqual([]);
});

it('validates local calendar dates around midnight and permits future dates', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const input = {
    kind: 'expense',
    amount: 30000,
    walletId: DEFAULT_WALLET_ID,
    occurredOn: '2026-10-26',
    occurredAt: '2026-10-26T23:59:00+07:00',
  } as const;
  await createTransaction(db, randomUUID(), input, input.occurredAt);
  await createTransaction(
    db,
    randomUUID(),
    { ...input, occurredOn: '2026-10-27', occurredAt: '2026-10-26T17:01:00Z' },
    input.occurredAt,
  );
  await expect(
    createTransaction(
      db,
      randomUUID(),
      {
        ...input,
        occurredOn: '2026-10-26',
        occurredAt: '2026-10-26T17:01:00Z',
      },
      input.occurredAt,
    ),
  ).rejects.toThrow('TRANSACTION_DATE_MISMATCH');
  await createTransaction(
    db,
    randomUUID(),
    {
      ...input,
      occurredOn: '2027-01-01',
      occurredAt: '2027-01-01T12:00:00+07:00',
    },
    input.occurredAt,
  );
  expect((await listTransactions(db)).map((row) => row.occurred_on)).toEqual([
    '2027-01-01',
    '2026-10-27',
    '2026-10-26',
  ]);
});

it('deletes and undoes exactly the same transaction including archived history without overwriting an existing row', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const id = randomUUID(),
    stamp = '2026-10-26T05:00:00Z';
  await createTransaction(
    db,
    id,
    {
      kind: 'expense',
      amount: 30000,
      walletId: DEFAULT_WALLET_ID,
      occurredOn: '2026-10-26',
      occurredAt: stamp,
      note: 'Synthetic note',
    },
    stamp,
  );
  const original = sqlite.prepare('SELECT * FROM transactions').get();
  await setWalletArchived(db, DEFAULT_WALLET_ID, true, stamp);
  const deletion = await deleteTransaction(db, id);
  expect(await listTransactions(db)).toEqual([]);
  await undoDeleteTransaction(db, deletion);
  expect(sqlite.prepare('SELECT * FROM transactions').get()).toEqual(original);
  await expect(undoDeleteTransaction(db, deletion)).rejects.toThrow();
  expect((await listWallets(db, true))[0].balance).toBe(-30000);
});

it('rejects category mismatch when changing income/expense and permits historical archived references unchanged', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const id = randomUUID(),
    stamp = '2026-10-26T05:00:00Z';
  const expense = (await listCategories(db)).find((c) => c.kind === 'expense')!;
  const input = {
    kind: 'expense',
    amount: 30000,
    walletId: DEFAULT_WALLET_ID,
    categoryId: expense.id,
    occurredOn: '2026-10-26',
    occurredAt: stamp,
  } as const;
  await createTransaction(db, id, input, stamp);
  await expect(
    updateTransaction(db, id, { ...input, kind: 'income' }, stamp),
  ).rejects.toThrow('CATEGORY_KIND');
  expect((await listTransactions(db))[0].kind).toBe('expense');
  await archiveCategory(db, expense.id, null, stamp);
  await setWalletArchived(db, DEFAULT_WALLET_ID, true, stamp);
  await updateTransaction(
    db,
    id,
    { ...input, note: 'Historical correction' },
    stamp,
  );
  expect((await listTransactions(db))[0].note).toBe('Historical correction');
  await updateTransaction(
    db,
    id,
    { ...input, kind: 'income', categoryId: null },
    stamp,
  );
  expect((await listWallets(db, true))[0].balance).toBe(30000);
});

it('rejects stale transaction edits and deletion after another operation changes the row', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const id = randomUUID(),
    stamp = '2026-10-26T05:00:00Z',
    changed = '2026-10-26T05:01:00Z';
  const input = {
    kind: 'expense',
    amount: 30000,
    walletId: DEFAULT_WALLET_ID,
    occurredOn: '2026-10-26',
    occurredAt: stamp,
  } as const;
  await createTransaction(db, id, input, stamp);
  await updateTransaction(db, id, { ...input, amount: 40000 }, changed, stamp);
  await expect(
    updateTransaction(db, id, input, changed, stamp),
  ).rejects.toThrow('TRANSACTION_CHANGED');
  await expect(deleteTransaction(db, id, stamp)).rejects.toThrow(
    'TRANSACTION_CHANGED',
  );
  expect((await listTransactions(db))[0].amount).toBe(40000);
});

it('paginates tied transaction timestamps without missing or repeating rows', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const stamp = '2026-10-26T05:00:00Z';
  const statement = sqlite.prepare(
    `INSERT INTO transactions (id,kind,amount,wallet_id,occurred_on,occurred_at,created_at,updated_at) VALUES (?,'expense',1000,?,'2026-10-26',?,?,?)`,
  );
  for (let n = 0; n < 105; n++)
    statement.run(
      String(n).padStart(3, '0'),
      DEFAULT_WALLET_ID,
      stamp,
      stamp,
      stamp,
    );
  const first = await listTransactions(db),
    second = await listTransactions(db, first.at(-1)),
    third = await listTransactions(db, second.at(-1));
  expect([first.length, second.length, third.length]).toEqual([50, 50, 5]);
  expect([...first, ...second, ...third].map((row) => row.id)).toEqual(
    Array.from({ length: 105 }, (_, i) => String(104 - i).padStart(3, '0')),
  );
});

it('creates only two category levels with matching kinds and active parents', async () => {
  await migrate(db);
  const parent = randomUUID(),
    child = randomUUID();
  const stamp = '2026-10-26T00:00:00Z';
  await createCategory(db, parent, { name: 'Meals', kind: 'expense' }, stamp);
  await createCategory(
    db,
    child,
    { name: 'Lunch', kind: 'expense', parentId: parent },
    stamp,
  );
  await expect(
    createCategory(
      db,
      randomUUID(),
      { name: 'Third level', kind: 'expense', parentId: child },
      stamp,
    ),
  ).rejects.toThrow('CATEGORY_DEPTH');
  await expect(
    createCategory(
      db,
      randomUUID(),
      { name: 'Wrong kind', kind: 'income', parentId: parent },
      stamp,
    ),
  ).rejects.toThrow('CATEGORY_KIND');
  await expect(
    createCategory(
      db,
      randomUUID(),
      { name: 'Missing', kind: 'expense', parentId: randomUUID() },
      stamp,
    ),
  ).rejects.toThrow('CATEGORY_NOT_FOUND');
  expect(await listCategories(db)).toHaveLength(2);
  await archiveCategory(db, parent, null, stamp);
  await expect(
    createCategory(
      db,
      randomUUID(),
      { name: 'Archived parent', kind: 'expense', parentId: parent },
      stamp,
    ),
  ).rejects.toThrow('CATEGORY_ARCHIVED');
  await expect(requireActiveCategory(db, child, 'expense')).rejects.toThrow(
    'CATEGORY_ARCHIVED',
  );
});

it('renames system categories without changing their key, kind, parent or history', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const food = (await listCategories(db)).find(
    (c) => c.system_key === 'expense.food',
  )!;
  sqlite
    .prepare(
      `INSERT INTO transactions (id,kind,amount,wallet_id,category_id,occurred_on,occurred_at,created_at,updated_at) VALUES ('rename-tx','expense',10000,?,?,'2026-10-26','2026-10-26T00:00:00Z','old','old')`,
    )
    .run(DEFAULT_WALLET_ID, food.id);
  const history = sqlite.prepare('SELECT * FROM transactions').all();
  await updateCategory(
    db,
    food.id,
    {
      name: 'Meals renamed',
      isFixedCost: true,
      icon: 'food',
      color: '#195DB7',
    },
    '2026-10-27T00:00:00Z',
  );
  const updated = (await listCategories(db)).find((c) => c.id === food.id)!;
  expect(updated).toMatchObject({
    name: 'Meals renamed',
    system_key: 'expense.food',
    parent_id: null,
    kind: 'expense',
    is_fixed_cost: 1,
    icon: 'food',
    color: '#195DB7',
  });
  expect(sqlite.prepare('SELECT * FROM transactions').all()).toEqual(history);
  await seed(db, '2026-10-28T00:00:00Z');
  expect((await listCategories(db)).find((c) => c.id === food.id)?.name).toBe(
    'Meals renamed',
  );
  for (const input of [
    { name: ' ', kind: 'expense' },
    { name: 'Invalid color', kind: 'expense', color: 'bad' },
    { name: 'Invalid icon', kind: 'expense', icon: 'bad' },
  ] as const)
    await expect(
      createCategory(db, randomUUID(), input, '2026-10-26T00:00:00Z'),
    ).rejects.toThrow();
});

it('archives parent and children while retaining transaction and budget references by default', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const rows = await listCategories(db);
  const food = rows.find((c) => c.system_key === 'expense.food')!;
  const child = rows.find((c) => c.parent_id === food.id)!;
  sqlite
    .prepare(
      `INSERT INTO transactions (id,kind,amount,wallet_id,category_id,occurred_on,occurred_at,created_at,updated_at) VALUES ('category-tx','expense',30000,?,?,'2026-10-26','2026-10-26T00:00:00Z','old','old')`,
    )
    .run(DEFAULT_WALLET_ID, child.id);
  sqlite
    .prepare(
      `INSERT INTO budgets (id,category_id,amount,start_month,created_at,updated_at) VALUES ('category-budget',?,100000,'2026-10','old','old')`,
    )
    .run(food.id);
  await archiveCategory(db, food.id, null, '2026-10-27T00:00:00Z');
  expect(
    (await listCategories(db, true))
      .filter((c) => c.id === food.id || c.parent_id === food.id)
      .every((c) => c.is_archived === 1),
  ).toBe(true);
  expect(
    (await listCategories(db)).some(
      (c) => c.id === food.id || c.parent_id === food.id,
    ),
  ).toBe(false);
  expect(
    sqlite
      .prepare('SELECT category_id,amount,updated_at FROM transactions')
      .get(),
  ).toEqual({ category_id: child.id, amount: 30000, updated_at: 'old' });
  expect(sqlite.prepare('SELECT category_id FROM budgets').get()).toEqual({
    category_id: food.id,
  });
  await seed(db, '2026-10-28T00:00:00Z');
  expect((await listCategories(db)).some((c) => c.id === food.id)).toBe(false);
});

it('explicit reassignment moves exactly the archived subtree transactions and preserves budgets and money', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const rows = await listCategories(db),
    food = rows.find((c) => c.system_key === 'expense.food')!,
    child = rows.find((c) => c.parent_id === food.id)!,
    target = rows.find((c) => c.system_key === 'expense.other')!;
  const statement = sqlite.prepare(
    `INSERT INTO transactions (id,kind,amount,wallet_id,category_id,occurred_on,occurred_at,created_at,updated_at) VALUES (?,'expense',30000,?,?,'2026-10-26','2026-10-26T00:00:00Z','old','old')`,
  );
  for (const [id, category] of [
    ['parent', food.id],
    ['child', child.id],
    ['other', target.id],
  ])
    statement.run(id, DEFAULT_WALLET_ID, category);
  const before = sqlite.prepare('SELECT * FROM transactions ORDER BY id').all();
  sqlite
    .prepare(
      `INSERT INTO budgets (id,category_id,amount,start_month,created_at,updated_at) VALUES ('reassign-budget',?,100000,'2026-10','old','old')`,
    )
    .run(food.id);
  const budgetsBefore = sqlite.prepare('SELECT * FROM budgets').all();
  await archiveCategory(db, food.id, target.id, '2026-10-27T00:00:00Z');
  expect(
    sqlite.prepare('SELECT * FROM transactions ORDER BY id').all(),
  ).toEqual(
    before.map((row) =>
      row.id === 'other'
        ? row
        : {
            ...row,
            category_id: target.id,
            updated_at: '2026-10-27T00:00:00Z',
          },
    ),
  );
  expect((await listWallets(db))[0].balance).toBe(-90000);
  expect(sqlite.prepare('SELECT * FROM budgets').all()).toEqual(budgetsBefore);
  const reassigned = sqlite
    .prepare('SELECT * FROM transactions ORDER BY id')
    .all();
  await restoreCategory(db, food.id, 'restored');
  expect(
    sqlite.prepare('SELECT * FROM transactions ORDER BY id').all(),
  ).toEqual(reassigned);
  expect(sqlite.prepare('SELECT * FROM budgets').all()).toEqual(budgetsBefore);
});

it('rejects invalid category reassignment atomically, including own descendants and wrong kinds', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const rows = await listCategories(db),
    food = rows.find((c) => c.system_key === 'expense.food')!,
    child = rows.find((c) => c.parent_id === food.id)!,
    income = rows.find((c) => c.kind === 'income')!;
  for (const target of [food.id, child.id, income.id, randomUUID()]) {
    await expect(archiveCategory(db, food.id, target, 'new')).rejects.toThrow();
    expect(
      (await listCategories(db)).find((c) => c.id === food.id)?.is_archived,
    ).toBe(0);
  }
  await expect(requireActiveCategory(db, food.id, 'income')).rejects.toThrow(
    'CATEGORY_KIND',
  );
  const target = rows.find((c) => c.system_key === 'expense.other')!;
  await archiveCategory(db, target.id, null, 'new');
  await expect(archiveCategory(db, food.id, target.id, 'new')).rejects.toThrow(
    'CATEGORY_ARCHIVED',
  );
  const activeTarget = rows.find((c) => c.system_key === 'expense.shopping')!;
  sqlite
    .prepare(
      `INSERT INTO transactions (id,kind,amount,wallet_id,category_id,occurred_on,occurred_at,created_at,updated_at) VALUES ('rollback-tx','expense',10000,?,?,'2026-10-26','2026-10-26T00:00:00Z','old','old')`,
    )
    .run(DEFAULT_WALLET_ID, child.id);
  const historyBefore = sqlite.prepare('SELECT * FROM transactions').all();
  sqlite.exec(
    `CREATE TRIGGER reject_archive BEFORE UPDATE OF is_archived ON categories WHEN OLD.parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected archive failure'); END;`,
  );
  await expect(
    archiveCategory(db, food.id, activeTarget.id, 'new'),
  ).rejects.toThrow('injected archive failure');
  expect(
    (await listCategories(db)).filter(
      (c) => c.id === food.id || c.parent_id === food.id,
    ),
  ).toHaveLength(4);
  expect(sqlite.prepare('SELECT * FROM transactions').all()).toEqual(
    historyBefore,
  );
});

it('archives an individual child without hiding its parent or siblings', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const rows = await listCategories(db),
    food = rows.find((c) => c.system_key === 'expense.food')!,
    child = rows.find((c) => c.parent_id === food.id)!;
  await archiveCategory(db, child.id, null, '2026-10-27T00:00:00Z');
  const active = await listCategories(db);
  expect(active.find((c) => c.id === food.id)?.is_archived).toBe(0);
  expect(active.filter((c) => c.parent_id === food.id)).toHaveLength(2);
  await expect(
    updateCategory(db, child.id, { name: 'Archived' }, 'new'),
  ).rejects.toThrow('CATEGORY_ARCHIVED');
});

it('creates a negative-balance credit wallet and edits initial balance without losing transactions', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const id = '00000000-0000-4000-8000-000000000002';
  await createWallet(
    db,
    id,
    { name: 'Synthetic credit', kind: 'credit_card', initialBalance: -2000000 },
    '2026-10-26T00:00:00Z',
  );
  expect(
    (await listWallets(db)).find((wallet) => wallet.id === id)?.balance,
  ).toBe(-2000000);
  sqlite
    .prepare(
      `INSERT INTO transactions (id, kind, amount, wallet_id, occurred_on, occurred_at, created_at, updated_at)
    VALUES ('tx-income', 'income', 500000, ?, '2026-10-26', '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z')`,
    )
    .run(id);
  await updateWallet(
    db,
    id,
    {
      name: 'Renamed credit',
      kind: 'credit_card',
      initialBalance: -1000000,
      isGoalFunding: true,
    },
    '2026-10-27T00:00:00Z',
  );
  expect(
    (await listWallets(db)).find((wallet) => wallet.id === id),
  ).toMatchObject({
    name: 'Renamed credit',
    balance: -500000,
    is_goal_funding: 1,
  });
  expect(sqlite.prepare('SELECT amount FROM transactions').get()?.amount).toBe(
    500000,
  );
});

it('rejects invalid wallet inputs without inserting or updating rows', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  for (const initialBalance of [0.5, NaN, 100000000001, -100000000001]) {
    await expect(
      createWallet(
        db,
        'bad-id',
        { name: 'Synthetic', kind: 'cash', initialBalance },
        '2026-10-26T00:00:00Z',
      ),
    ).rejects.toThrow();
  }
  await expect(
    updateWallet(
      db,
      DEFAULT_WALLET_ID,
      { name: '  ', kind: 'cash' },
      '2026-10-26T00:00:00Z',
    ),
  ).rejects.toThrow();
  expect(await listWallets(db)).toHaveLength(1);
});

it('archives instead of deleting, rejects archived selections, preserves history and permits restoring', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  sqlite
    .prepare(
      `INSERT INTO transactions (id, kind, amount, wallet_id, occurred_on, occurred_at, created_at, updated_at)
    VALUES ('tx-expense', 'expense', 25000, ?, '2026-10-26', '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z')`,
    )
    .run(DEFAULT_WALLET_ID);
  await setWalletArchived(db, DEFAULT_WALLET_ID, true, '2026-10-26T00:00:00Z');
  expect(await listWallets(db)).toEqual([]);
  await expect(requireActiveWallet(db, DEFAULT_WALLET_ID)).rejects.toThrow(
    'WALLET_ARCHIVED',
  );
  expect((await listWallets(db, true))[0].balance).toBe(-25000);
  expect(sqlite.prepare('SELECT count(*) n FROM transactions').get()?.n).toBe(
    1,
  );
  await seed(db, '2026-10-27T00:00:00Z');
  expect(await listWallets(db)).toEqual([]);
  await setWalletArchived(db, DEFAULT_WALLET_ID, false, '2026-10-27T00:00:00Z');
  expect((await requireActiveWallet(db, DEFAULT_WALLET_ID)).balance).toBe(
    -25000,
  );
});

it('reorders active wallets atomically and rejects incomplete or duplicate IDs without changing order', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  const second = '00000000-0000-4000-8000-000000000002';
  await createWallet(
    db,
    second,
    { name: 'Synthetic bank', kind: 'bank' },
    '2026-10-26T00:00:00Z',
  );
  await reorderWallets(db, [second, DEFAULT_WALLET_ID], '2026-10-27T00:00:00Z');
  for (const ids of [
    [DEFAULT_WALLET_ID],
    [second, second],
    ['missing', DEFAULT_WALLET_ID],
  ]) {
    await expect(
      reorderWallets(db, ids, '2026-10-27T00:00:00Z'),
    ).rejects.toThrow('WALLET_ORDER_INVALID');
  }
  expect((await listWallets(db)).map(({ id }) => id)).toEqual([
    second,
    DEFAULT_WALLET_ID,
  ]);
  await updateWallet(
    db,
    second,
    { name: 'Synthetic bank', kind: 'bank', sortOrder: 10 },
    '2026-10-27T00:00:00Z',
  );
  await updateWallet(
    db,
    second,
    { name: 'Renamed bank', kind: 'bank' },
    '2026-10-27T00:00:00Z',
  );
  expect((await listWallets(db)).map(({ id }) => id)).toEqual([
    DEFAULT_WALLET_ID,
    second,
  ]);
  expect(
    (await listWallets(db)).find(({ id }) => id === second)?.sort_order,
  ).toBe(10);
  await expect(
    updateWallet(
      db,
      'missing',
      { name: 'Synthetic', kind: 'cash' },
      '2026-10-27T00:00:00Z',
    ),
  ).rejects.toThrow('WALLET_NOT_FOUND');
});

it('paginates tied chat timestamps without losing or duplicating rows', async () => {
  await migrate(db);
  for (let index = 0; index < 53; index++) {
    await saveChatMessage(
      db,
      `id-${String(index).padStart(3, '0')}`,
      `Synthetic message ${index}`,
      '2026-10-26T00:00:00Z',
      'session-a',
    );
  }
  await saveChatMessage(
    db,
    'other',
    'Other session',
    '2026-10-26T00:00:00Z',
    'session-b',
  );
  const first = await listChatMessages(db, undefined, 'session-a');
  const second = await listChatMessages(db, first.at(-1), 'session-a');
  expect(first).toHaveLength(50);
  expect(first[0].id).toBe('id-052');
  expect(second.map(({ id }) => id)).toEqual(['id-002', 'id-001', 'id-000']);
  expect(new Set([...first, ...second].map(({ id }) => id)).size).toBe(53);
});

it('preserves old chat as one session and keeps new session history separate', async () => {
  await migrate(db, MIGRATIONS.slice(0, 2));
  await db.runAsync(
    "INSERT INTO chat_messages (id,text,created_at) VALUES ('old-1','Câu hỏi cũ','2026-10-26T00:00:00Z')",
  );
  await migrate(db);
  expect((await listChatSessions(db)).map((row) => row.id)).toEqual(['legacy']);
  await saveChatMessage(
    db,
    'new-1',
    'Mua xe máy',
    '2026-10-27T00:00:00Z',
    'session-a',
  );
  await saveChatMessage(
    db,
    'new-2',
    'Tiết kiệm bao lâu?',
    '2026-10-27T00:01:00Z',
    'session-a',
  );
  await saveChatMessage(
    db,
    'other',
    'Khoản vay',
    '2026-10-28T00:00:00Z',
    'session-b',
  );
  expect(
    (await listChatSessions(db)).map((row) => [
      row.id,
      row.title,
      row.messageCount,
    ]),
  ).toEqual([
    ['session-b', 'Khoản vay', 1],
    ['session-a', 'Mua xe máy', 2],
    ['legacy', 'Câu hỏi cũ', 1],
  ]);
  expect(
    (await listChatMessages(db, undefined, 'session-a')).map((row) => row.id),
  ).toEqual(['new-2', 'new-1']);
  expect(
    (await listChatMessages(db, undefined, 'session-b')).map((row) => row.id),
  ).toEqual(['other']);
  expect(
    (await listChatMessages(db, undefined, 'legacy')).map((row) => row.id),
  ).toEqual(['old-1']);
});

it('deletes only selected chat sessions and their saved AI replies', async () => {
  await migrate(db);
  await saveChatMessage(
    db,
    'a-1',
    'Mua xe',
    '2026-10-26T00:00:00Z',
    'session-a',
  );
  await saveChatMessage(
    db,
    'a-2',
    'Tôi tiết kiệm 3 triệu',
    '2026-10-26T00:01:00Z',
    'session-a',
  );
  await saveChatMessage(
    db,
    'b-1',
    'Ngân sách',
    '2026-10-26T00:02:00Z',
    'session-b',
  );
  await db.runAsync(
    'INSERT INTO settings(key,value) VALUES (?,?)',
    'ai_chat_replies_v1',
    JSON.stringify({
      'a-1': { replyText: 'Hỏi thêm' },
      'a-2': { replyText: 'Tư vấn' },
      'b-1': { replyText: 'Giữ lại' },
    }),
  );
  await deleteChatSessions(db, ['session-a', 'session-a']);
  expect((await listChatSessions(db)).map((row) => row.id)).toEqual([
    'session-b',
  ]);
  expect(await listChatMessages(db, undefined, 'session-a')).toEqual([]);
  expect(
    (await listChatMessages(db, undefined, 'session-b')).map((row) => row.id),
  ).toEqual(['b-1']);
  const saved = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    'ai_chat_replies_v1',
  );
  expect(JSON.parse(saved!.value)).toEqual({ 'b-1': { replyText: 'Giữ lại' } });
});

it('preserves wallets, category hierarchy, goals, budgets and alert markers, onboarding and chat after reopening a real file', async () => {
  sqlite.close();
  temporaryFile = join(tmpdir(), `pfm-preview-test-${randomUUID()}.db`);
  sqlite = new DatabaseSync(temporaryFile);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  await finishOnboarding(db, 1500000, '2026-10-26T00:00:00Z');
  const credit = '00000000-0000-4000-8000-000000000002';
  const archived = '00000000-0000-4000-8000-000000000003';
  await createWallet(
    db,
    credit,
    { name: 'Synthetic credit', kind: 'credit_card', initialBalance: -2000000 },
    '2026-10-26T00:00:00Z',
  );
  await createWallet(
    db,
    archived,
    { name: 'Synthetic archive', kind: 'bank', initialBalance: 100000 },
    '2026-10-26T00:00:00Z',
  );
  await setWalletArchived(db, archived, true, '2026-10-26T00:00:00Z');
  await reorderWallets(db, [credit, DEFAULT_WALLET_ID], '2026-10-26T00:00:00Z');
  const parentCategory = randomUUID(),
    childCategory = randomUUID();
  await createCategory(
    db,
    parentCategory,
    { name: 'Persistent parent', kind: 'income' },
    '2026-10-26T00:00:00Z',
  );
  await createCategory(
    db,
    childCategory,
    { name: 'Persistent child', kind: 'income', parentId: parentCategory },
    '2026-10-26T00:00:00Z',
  );
  await updateCategory(
    db,
    parentCategory,
    { name: 'Renamed persistent parent', icon: 'cash' },
    '2026-10-26T00:00:00Z',
  );
  await archiveCategory(db, parentCategory, null, '2026-10-26T00:00:00Z');
  await saveChatMessage(
    db,
    'message-a',
    'Synthetic offline message',
    '2026-10-26T00:00:00Z',
  );
  const persistentInput = {
    kind: 'expense',
    amount: 30000,
    walletId: DEFAULT_WALLET_ID,
    occurredOn: '2026-10-26',
    occurredAt: '2026-10-26T05:00:00Z',
    note: 'Persistent transaction',
  } as const;
  await createTransaction(
    db,
    randomUUID(),
    persistentInput,
    '2026-10-26T05:00:00Z',
  );
  await createTransaction(
    db,
    randomUUID(),
    { ...persistentInput, kind: 'income' },
    '2026-10-26T05:00:00Z',
  );
  const persistedTransactions = await listTransactions(db);
  const persistedGoal = randomUUID();
  await saveGoal(
    db,
    persistedGoal,
    {
      name: 'Persistent goal',
      targetAmount: 10000000,
      fundingWalletId: DEFAULT_WALLET_ID,
      deadlineOn: '2027-04-30',
    },
    'old',
    false,
  );
  const persistedGoals = await listGoals(db);
  const persistedBudget = randomUUID();
  await createBudget(
    db,
    persistedBudget,
    { amount: 30000, startMonth: '2026-10' },
    'old',
  );
  expect(
    await claimBudgetAlert(db, persistedBudget, '2026-10', 80, 'old'),
  ).toBe(true);
  expect(
    await claimBudgetAlert(db, persistedBudget, '2026-10', 100, 'old'),
  ).toBe(true);
  sqlite.close();
  sqlite = new DatabaseSync(temporaryFile);
  await migrate(db);
  await seed(db, '2026-10-27T00:00:00Z');
  expect(await readOnboarding(db)).toBe(true);
  expect(await listTransactions(db)).toEqual(persistedTransactions);
  expect(await listGoals(db)).toEqual(persistedGoals);
  await createTransaction(
    db,
    randomUUID(),
    { ...persistentInput, amount: 100000 },
    'next',
  );
  expect((await listGoals(db))[0].progress).toBe(1400000);
  const goalExpense = (await listTransactions(db)).find(
    (t) => t.amount === 100000,
  )!;
  await deleteTransaction(db, goalExpense.id);
  expect((await listGoals(db))[0].progress).toBe(1500000);
  expect(
    (await readBudgetMonth(db, '2026-10')).find(
      (b) => b.id === persistedBudget,
    ),
  ).toMatchObject({ spent: 30000, amount: 30000 });
  expect(
    await claimBudgetAlert(db, persistedBudget, '2026-10', 80, 'after-reopen'),
  ).toBe(false);
  expect(
    await claimBudgetAlert(db, persistedBudget, '2026-10', 100, 'after-reopen'),
  ).toBe(false);
  const categories = await listCategories(db, true);
  expect(categories.find((c) => c.id === parentCategory)).toMatchObject({
    name: 'Renamed persistent parent',
    icon: 'cash',
    is_archived: 1,
  });
  expect(categories.find((c) => c.id === childCategory)).toMatchObject({
    parent_id: parentCategory,
    is_archived: 1,
  });
  expect(
    sqlite
      .prepare('SELECT balance FROM v_wallet_balance WHERE wallet_id = ?')
      .get(DEFAULT_WALLET_ID)?.balance,
  ).toBe(1500000);
  expect(
    (await listWallets(db)).map(({ id, balance }) => ({ id, balance })),
  ).toEqual([
    { id: credit, balance: -2000000 },
    { id: DEFAULT_WALLET_ID, balance: 1500000 },
  ]);
  expect(
    (await listWallets(db, true)).find(({ id }) => id === archived),
  ).toMatchObject({ is_archived: 1, balance: 100000 });
  expect((await listChatMessages(db))[0].text).toBe(
    'Synthetic offline message',
  );
  expect(sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe(
    'ok',
  );
});

it('migrates once, seeds exactly 25 categories and one cash wallet twice', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  await migrate(db);
  await seed(db, '2026-10-27T00:00:00Z');
  expect(sqlite.prepare('SELECT count(*) n FROM categories').get()?.n).toBe(25);
  expect(sqlite.prepare('SELECT count(*) n FROM wallets').get()?.n).toBe(1);
  expect(
    sqlite.prepare('SELECT count(*) n FROM schema_migrations').get()?.n,
  ).toBe(4);
  expect(
    sqlite
      .prepare('SELECT count(*) n FROM categories WHERE parent_id IS NOT NULL')
      .get()?.n,
  ).toBe(9);
  expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('rolls back DDL, data and version together on a failed upgrade', async () => {
  await migrate(db, MIGRATIONS.slice(0, 1));
  await seed(db, '2026-10-26T00:00:00Z');
  await expect(
    migrate(db, [
      { version: 1, description: 'initial', sql: '' },
      {
        version: 2,
        description: 'broken',
        sql: 'UPDATE wallets SET initial_balance = 99; CREATE TABLE partial (id TEXT); INVALID SQL;',
      },
    ]),
  ).rejects.toThrow();
  expect(sqlite.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  expect(
    sqlite.prepare('SELECT initial_balance FROM wallets').get()
      ?.initial_balance,
  ).toBe(0);
  expect(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE name = 'partial'")
      .get(),
  ).toBeUndefined();
  expect(
    sqlite.prepare('SELECT count(*) n FROM schema_migrations').get()?.n,
  ).toBe(1);
});

it('refuses newer databases without changing their version', async () => {
  sqlite.exec('PRAGMA user_version = 99');
  await expect(migrate(db)).rejects.toThrow('SCHEMA_NEWER_THAN_APP');
  expect(sqlite.prepare('PRAGMA user_version').get()?.user_version).toBe(99);
});

it('fresh onboarding starts with only default categories and an empty wallet, never sample financial data', async () => {
  await migrate(db);
  await seed(db, '2026-11-09T00:00:00Z');
  expect(await readOnboarding(db)).toBe(false);
  expect(await listTransactions(db)).toEqual([]);
  expect(await listGoals(db)).toEqual([]);
  const wallets = await listWallets(db);
  expect(wallets).toHaveLength(1);
  expect(wallets[0]).toMatchObject({
    id: DEFAULT_WALLET_ID,
    balance: 0,
    initial_balance: 0,
  });
  expect(
    sqlite
      .prepare("SELECT value FROM settings WHERE key = 'pref_seed_enabled'")
      .get(),
  ).toBeUndefined();
});

it('commits first-run balance once and preserves it across repeated onboarding calls', async () => {
  await migrate(db);
  await seed(db, '2026-10-26T00:00:00Z');
  expect(await readOnboarding(db)).toBe(false);
  await expect(
    finishOnboarding(db, -1, '2026-10-26T00:00:00Z'),
  ).rejects.toThrow();
  expect(await readOnboarding(db)).toBe(false);
  await finishOnboarding(db, 1500000, '2026-10-26T00:00:00Z');
  await finishOnboarding(db, 0, '2026-10-27T00:00:00Z');
  await seed(db, '2026-10-27T00:00:00Z');
  expect(await readOnboarding(db)).toBe(true);
  expect(
    sqlite
      .prepare('SELECT balance FROM v_wallet_balance WHERE wallet_id = ?')
      .get(DEFAULT_WALLET_ID)?.balance,
  ).toBe(1500000);
});

it('stores trimmed user chat only, rejects blank/oversize input and handles SQL characters safely', async () => {
  await migrate(db);
  await expect(
    saveChatMessage(db, 'id-a', '   ', '2026-10-26T00:00:00Z'),
  ).rejects.toThrow();
  await expect(
    saveChatMessage(db, 'id-a', 'x'.repeat(501), '2026-10-26T00:00:00Z'),
  ).rejects.toThrow();
  await saveChatMessage(
    db,
    'id-a',
    "  '); DROP TABLE wallets; --  ",
    '2026-10-26T00:00:00Z',
  );
  expect(sqlite.prepare('SELECT text FROM chat_messages').get()?.text).toBe(
    "'); DROP TABLE wallets; --",
  );
  expect(sqlite.prepare('SELECT count(*) n FROM wallets').get()?.n).toBe(0);
});
