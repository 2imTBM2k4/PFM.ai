import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ConversationStateSchema,
  isMoneyFact,
  type ConversationState,
} from '@pfm/contracts';
import { migrate, MIGRATIONS, type Database, type Queries } from './migrate';
import {
  deleteChatSessions,
  saveChatMessage,
  readChatSourceMessages,
} from './repository';
import {
  readConversationState,
  writeConversationState,
  deleteConversationState,
  listSessionsWithState,
} from './conversation-state';

let sqlite: DatabaseSync;
let db: Database;
let operations: Promise<unknown>;
vi.mock('./connection', () => ({
  withDatabase: (task: (db: Database) => Promise<unknown>) => {
    const result = operations.then(() => task(db));
    operations = result.catch(() => undefined);
    return result;
  },
}));

function wrapSqlite(): Database {
  const queries: Queries = {
    execAsync: async (sql) => {
      sqlite.exec(sql);
    },
    runAsync: async (sql, ...params) => sqlite.prepare(sql).run(...params),
    getFirstAsync: async <T>(
      sql: string,
      ...params: (string | number | null)[]
    ) => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T>(
      sql: string,
      ...params: (string | number | null)[]
    ) => sqlite.prepare(sql).all(...params) as T[],
  };
  return {
    ...queries,
    transaction: async (task) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        await task(queries);
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function state(sessionId = 'session-1'): ConversationState {
  const unknown = { status: 'unknown' as const };
  return {
    version: 1,
    sessionId,
    revision: 0,
    updatedAt: '2026-11-16T00:00:00.000Z',
    facts: [],
    pendingFields: ['income'],
    activeScenario: {
      id: 'scenario-1',
      topic: 'savings',
      mode: 'actual',
      currency: 'VND',
      cashFlowBasis: unknown,
      observationRange: unknown,
      income: unknown,
      expenseTotal: unknown,
      expenseIncludes: unknown,
      expenseItems: [],
      debtMonthlyPayments: [],
      debtOutstanding: unknown,
      goalTarget: unknown,
      monthlySavingsGoal: unknown,
      savingsForGoal: unknown,
      savingsMonths: unknown,
      purchasePrice: unknown,
      monthlyPayment: unknown,
      paymentMonths: unknown,
    },
  };
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  db = wrapSqlite();
  operations = Promise.resolve();
  await migrate(db);
});
afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

it('reads a missing state without creating one', async () => {
  expect(await readConversationState('missing')).toBeNull();
  expect(await listSessionsWithState()).toEqual([]);
});

it('reads only requested evidence from the owning session even beyond the latest chat page', async () => {
  for (let i = 0; i < 55; i++)
    await saveChatMessage(
      db,
      `old-${i}`,
      `Thu nhập ${i + 1} triệu`,
      `2026-11-15T00:00:${String(i).padStart(2, '0')}.000Z`,
      'session-1',
    );
  await saveChatMessage(
    db,
    'other',
    'Thu nhập 999 triệu',
    state().updatedAt,
    'session-2',
  );
  expect(
    await readChatSourceMessages(db, 'session-1', [
      'old-0',
      'other',
      'deleted',
      'old-0',
    ]),
  ).toEqual([
    {
      id: 'old-0',
      text: 'Thu nhập 1 triệu',
      sessionId: 'session-1',
      createdAt: '2026-11-15T00:00:00.000Z',
    },
  ]);
  await db.runAsync('DELETE FROM chat_messages WHERE id=?', 'old-0');
  expect(await readChatSourceMessages(db, 'session-1', ['old-0'])).toEqual([]);
  expect(await readChatSourceMessages(db, 'session-1', [])).toEqual([]);
});

it('does not initialize state for a missing, deleted or differently owned source message', async () => {
  const input = state();
  await saveChatMessage(
    db,
    'foreign-message',
    'Thu nhập 15 triệu',
    input.updatedAt,
    'other-session',
  );
  for (const sourceMessageId of ['missing', 'foreign-message']) {
    await expect(
      writeConversationState(input, { sourceMessageId }),
    ).rejects.toThrow('CONVERSATION_STATE_SOURCE_MISSING');
    expect(await readConversationState(input.sessionId)).toBeNull();
  }
  await saveChatMessage(
    db,
    'current',
    'Kế hoạch tiết kiệm',
    input.updatedAt,
    input.sessionId,
  );
  expect(
    (await writeConversationState(input, { sourceMessageId: 'current' }))
      .revision,
  ).toBe(1);
  await deleteChatSessions(db, [input.sessionId]);
  await expect(
    writeConversationState(input, { sourceMessageId: 'current' }),
  ).rejects.toThrow('CONVERSATION_STATE_SOURCE_MISSING');
  expect(await readConversationState(input.sessionId)).toBeNull();
});

it('round-trips the full state and increments the stored revision without mutating input', async () => {
  const input = state();
  await writeConversationState(input);
  const first = await readConversationState(input.sessionId);
  expect(first).toEqual({ ...input, revision: 1 });
  expect(input.revision).toBe(0);
  await writeConversationState({ ...first!, pendingFields: ['savingsMonths'] });
  expect(await readConversationState(input.sessionId)).toEqual({
    ...input,
    revision: 2,
    pendingFields: ['savingsMonths'],
  });
});

it('returns the committed state so the next write can use its revision', async () => {
  const input = state();
  const first = await writeConversationState(input);
  expect(first).toEqual({ ...input, revision: input.revision + 1 });
  expect(await readConversationState(input.sessionId)).toEqual(first);
  const second = await writeConversationState(first);
  expect(second.revision).toBe(2);
  expect(await readConversationState(input.sessionId)).toEqual(second);
  expect(input.revision).toBe(0);
  await expect(writeConversationState(input)).rejects.toThrow(
    'CONVERSATION_STATE_CONFLICT',
  );
  expect(await readConversationState(input.sessionId)).toEqual(second);
});

it('rejects stale and missing-state revisions without changing stored data', async () => {
  const input = state();
  await writeConversationState(input);
  await expect(writeConversationState(input)).rejects.toThrow(
    'CONVERSATION_STATE_CONFLICT',
  );
  await expect(
    writeConversationState({ ...state('missing'), revision: 3 }),
  ).rejects.toThrow('CONVERSATION_STATE_CONFLICT');
  expect(await readConversationState(input.sessionId)).toEqual({
    ...input,
    revision: 1,
  });
  expect(await readConversationState('missing')).toBeNull();
});

it('allows exactly one of two writers using the same revision', async () => {
  await writeConversationState(state());
  const current = (await readConversationState('session-1'))!;
  const results = await Promise.allSettled([
    writeConversationState({ ...current, pendingFields: ['income'] }),
    writeConversationState({ ...current, pendingFields: ['savingsMonths'] }),
  ]);
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
    1,
  );
  expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
  expect((await readConversationState('session-1'))?.revision).toBe(2);
});

it('rejects invalid state before writing and keeps the earlier state intact', async () => {
  await writeConversationState(state());
  const bad = {
    ...state(),
    revision: 1,
    facts: [
      {
        id: 'fact-2',
        source_message_id: 'message-2',
        kind: 'savingsForGoal',
        amount: 0,
        currency: 'VND',
        period: 'one_off',
        mode: 'actual',
        source: 'user_statement',
        supersedes_id: 'missing',
      },
    ],
  };
  expect(ConversationStateSchema.safeParse(bad).success).toBe(false);
  await expect(
    writeConversationState(bad as ConversationState),
  ).rejects.toThrow();
  expect((await readConversationState('session-1'))?.revision).toBe(1);
  await expect(
    writeConversationState({ ...state('invalid'), revision: -1 }),
  ).rejects.toThrow();
  expect(await readConversationState('invalid')).toBeNull();
});

it('stores facts and their zero-valued slot together and rolls both back on SQL failure', async () => {
  const input = state();
  input.facts = [
    {
      id: 'saved-1',
      source_message_id: 'message-1',
      kind: 'savingsForGoal',
      amount: 0,
      currency: 'VND',
      period: 'one_off',
      source: 'user_statement',
      mode: 'actual',
    },
  ];
  input.activeScenario.savingsForGoal = {
    status: 'known',
    value: 0,
    factIds: ['saved-1'],
    sourceMessageIds: ['message-1'],
    source: 'user_statement',
  };
  await writeConversationState(input);
  expect(await readConversationState(input.sessionId)).toEqual({
    ...input,
    revision: 1,
  });
  sqlite.exec(
    "CREATE TRIGGER fail_state_update AFTER UPDATE ON conversation_states BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
  );
  const next = structuredClone(input);
  next.revision = 1;
  if (isMoneyFact(next.facts[0])) next.facts[0].amount = 500;
  next.activeScenario.savingsForGoal = {
    ...input.activeScenario.savingsForGoal,
    value: 500,
  };
  await expect(writeConversationState(next)).rejects.toThrow('test failure');
  expect(await readConversationState(input.sessionId)).toEqual({
    ...input,
    revision: 1,
  });
});

it.each([
  '{private broken JSON',
  JSON.stringify({ ...state(), revision: 1, version: 0 }),
  JSON.stringify({ ...state(), revision: 1, sessionId: 'wrong' }),
])(
  'returns null and logs only a fixed warning for corrupt or unsupported JSON: %s',
  async (json) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await db.runAsync(
      'INSERT INTO conversation_states (session_id, revision, state_json, updated_at) VALUES (?, ?, ?, ?)',
      'session-1',
      1,
      json,
      state().updatedAt,
    );
    await expect(readConversationState('session-1')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain(
      'CONVERSATION_STATE_INVALID',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('session-1');
  },
);

it('rejects mismatched column and JSON revisions on read', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await writeConversationState(state());
  await db.runAsync('UPDATE conversation_states SET revision=99');
  expect(await readConversationState('session-1')).toBeNull();
});

it('lists sessions deterministically and deletes state without touching other sessions', async () => {
  await writeConversationState(state('b'));
  await writeConversationState(state('a'));
  expect(await listSessionsWithState()).toEqual(['a', 'b']);
  await deleteConversationState('a');
  await deleteConversationState('a');
  expect(await readConversationState('a')).toBeNull();
  expect(await listSessionsWithState()).toEqual(['b']);
});

it('deletes state with a chat session, including sessions without messages', async () => {
  await saveChatMessage(
    db,
    'message-1',
    'test',
    state().updatedAt,
    'session-1',
  );
  for (const id of ['session-1', 'empty-session', 'keep'])
    await writeConversationState(state(id));
  await deleteChatSessions(db, ['session-1', 'empty-session']);
  expect(await readConversationState('session-1')).toBeNull();
  expect(await readConversationState('empty-session')).toBeNull();
  expect(await listSessionsWithState()).toEqual(['keep']);
});

it('upgrades a legacy session without creating or requiring state', async () => {
  sqlite.close();
  sqlite = new DatabaseSync(':memory:');
  db = wrapSqlite();
  await migrate(
    db,
    MIGRATIONS.filter(({ version }) => version <= 5),
  );
  await saveChatMessage(
    db,
    'old-message',
    'old chat',
    state().updatedAt,
    'old-session',
  );
  await migrate(db);
  await migrate(db);
  expect(await readConversationState('old-session')).toBeNull();
  expect(await listSessionsWithState()).toEqual([]);
  expect(
    await db.getFirstAsync(
      'SELECT text FROM chat_messages WHERE id=?',
      'old-message',
    ),
  ).toEqual({ text: 'old chat' });
});
