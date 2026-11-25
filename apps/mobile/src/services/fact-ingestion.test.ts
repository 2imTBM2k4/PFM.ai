import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationStateSchema,
  isDurationFact,
  isMoneyFact,
  type ConversationState,
} from '@pfm/contracts';
import { migrate, type Database, type Queries } from '@/data/migrate';
import { seed } from '@/data/seed';
import {
  deleteChatSessions,
  readChatSourceMessages,
  saveChatMessage,
} from '@/data/repository';
import { readConversationState } from '@/data/conversation-state';
import { buildAdviceContext } from './advice-context';
import { validateConversationStateFacts } from './advice-state-validation';
import { detectCorrection } from './correction-detection';
import { commitCorrection } from './correction-commit';
import { executeTool } from './advice-tools';
import { ingestUserFacts, recordPendingFields } from './fact-ingestion';

let sqlite: DatabaseSync;
let db: Database;
let factSeq = 0;

vi.mock('@/data/connection', () => ({
  withDatabase: (task: (db: Database) => Promise<unknown>) => task(db),
}));

const sessionId = 'session-empty-1';
const now = '2026-11-20T07:00:00.000Z';
const nextFactId = () => `fact-${++factSeq}`;

beforeEach(async () => {
  factSeq = 0;
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
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
  db = {
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
  await migrate(db);
  await seed(db, now);
});

afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

async function addMessage(id: string, text: string, createdAt = now) {
  await saveChatMessage(db, id, text, createdAt, sessionId);
}

async function verifyStateInDb(expectedState: ConversationState) {
  const stored = await readConversationState(sessionId);
  expect(stored).toEqual(expectedState);
  expect(ConversationStateSchema.safeParse(stored).success).toBe(true);
  const sources = await readChatSourceMessages(
    db,
    sessionId,
    expectedState.facts.map((fact) => fact.source_message_id),
  );
  expect(
    validateConversationStateFacts(expectedState.facts, sources, {
      sessionId,
      scenario: expectedState.activeScenario,
    }),
  ).toEqual({ valid: true });
}

describe('1. Empty session -> full 5-fact declaration in one turn', () => {
  it('ingests all 5 savings facts from null state, binds monthly basis & debt includes, validates sources, and executes plan_savings_goal', async () => {
    expect(await readConversationState(sessionId)).toBeNull();
    const text =
      'Thu nhập 15 triệu mỗi tháng, tổng chi 10 triệu mỗi tháng đã gồm trả nợ, mục tiêu 24 triệu trong 6 tháng, dành riêng 0 đồng.';
    await addMessage('m1', text);

    const res = await ingestUserFacts({
      sessionId,
      messageId: 'm1',
      messageText: text,
      state: null,
      language: 'vi',
      currency: 'VND',
      now,
      generateFactId: nextFactId,
    });

    expect(res.status).toBe('ingested');
    if (res.status !== 'ingested') throw Error('Expected ingested');
    expect(res.newState.revision).toBe(1);
    expect(res.addedFields.sort()).toEqual(
      [
        'expenseTotal',
        'goalTarget',
        'income',
        'savingsForGoal',
        'savingsMonths',
      ].sort(),
    );
    expect(res.newState.facts.filter(isMoneyFact)).toHaveLength(4);
    expect(res.newState.facts.filter(isDurationFact)).toHaveLength(1);
    expect(res.newState.activeScenario.cashFlowBasis).toMatchObject({
      status: 'known',
      value: 'monthly',
    });
    expect(res.newState.activeScenario.expenseIncludes).toMatchObject({
      status: 'known',
      value: ['debt'],
    });
    expect(res.newState.pendingFields).toEqual([]);

    await verifyStateInDb(res.newState);

    const toolResult = await executeTool(
      'plan_savings_goal',
      {},
      ['plan_savings_goal'],
      {
        sessionId,
        stateRevision: res.newState.revision,
        state: res.newState,
        deadline: Date.now() + 5_000,
      },
    );
    expect(toolResult).toMatchObject({
      status: 'ok',
      stateRevision: 1,
      data: {
        monthlyAvailable: 5_000_000,
        requiredMonthlySaving: 4_000_000,
        remainingAfterSaving: 1_000_000,
        months: 6,
        goalAmount: 24_000_000,
        savingsForGoal: 0,
      },
    });
  });
});

describe('2. Missing savingsForGoal -> ask -> answer 0 or negation -> calculate', () => {
  it.each([
    ['0', 0],
    ['0 đồng', 0],
    ['chưa có tiền dành riêng', 0],
    ['Chưa có', 0],
  ] as const)(
    'clarifies missing savingsForGoal and accepts short reply %s on turn 2',
    async (replyText, expectedSavings) => {
      const turn1 =
        'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn tiết kiệm 24 triệu trong 6 tháng.';
      await addMessage('m1', turn1, '2026-11-20T07:00:00.000Z');
      const ingested1 = await ingestUserFacts({
        sessionId,
        messageId: 'm1',
        messageText: turn1,
        state: null,
        language: 'vi',
        currency: 'VND',
        now: '2026-11-20T07:00:00.000Z',
        generateFactId: nextFactId,
      });
      expect(ingested1.status).toBe('ingested');
      if (ingested1.status !== 'ingested') throw Error('Expected ingested');

      const step1Tool = await executeTool(
        'plan_savings_goal',
        {},
        ['plan_savings_goal'],
        {
          sessionId,
          stateRevision: ingested1.newState.revision,
          state: ingested1.newState,
          deadline: Date.now() + 5_000,
        },
      );
      expect(step1Tool).toEqual({
        status: 'needs_clarification',
        fields: ['savingsForGoal'],
      });

      const recorded = await recordPendingFields(
        ingested1.newState,
        ['savingsForGoal'],
        {
          now: '2026-11-20T07:00:01.000Z',
          sourceMessageId: 'm1',
        },
      );
      expect(recorded.status).toBe('updated');
      if (recorded.status !== 'updated') throw Error('Expected updated');
      expect(recorded.newState.pendingFields).toEqual(['savingsForGoal']);
      expect(recorded.newState.revision).toBe(2);

      await addMessage('m2', replyText, '2026-11-20T07:00:02.000Z');
      const ingested2 = await ingestUserFacts({
        sessionId,
        messageId: 'm2',
        messageText: replyText,
        state: recorded.newState,
        language: 'vi',
        currency: 'VND',
        now: '2026-11-20T07:00:02.000Z',
        generateFactId: nextFactId,
      });
      expect(ingested2.status).toBe('ingested');
      if (ingested2.status !== 'ingested') throw Error('Expected ingested');
      expect(ingested2.addedFields).toEqual(['savingsForGoal']);
      expect(ingested2.newState.pendingFields).toEqual([]);
      expect(ingested2.newState.activeScenario.savingsForGoal).toMatchObject({
        status: 'known',
        value: expectedSavings,
      });

      await verifyStateInDb(ingested2.newState);

      const step2Tool = await executeTool(
        'plan_savings_goal',
        {},
        ['plan_savings_goal'],
        {
          sessionId,
          stateRevision: ingested2.newState.revision,
          state: ingested2.newState,
          deadline: Date.now() + 5_000,
        },
      );
      expect(step2Tool).toMatchObject({
        status: 'ok',
        data: {
          monthlyAvailable: 5_000_000,
          requiredMonthlySaving: 4_000_000,
          remainingAfterSaving: 1_000_000,
          savingsForGoal: 0,
        },
      });
    },
  );
});

describe('3. Missing savingsMonths -> ask -> reject bare number or money -> accept "6 tháng" / "6tháng" -> calculate', () => {
  it.each(['6 tháng', '6tháng'] as const)(
    'rejects bare "6" and "6 triệu", then accepts "%s" for pending savingsMonths',
    async (validDurationText) => {
      const turn1 =
        'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn tiết kiệm đủ 24 triệu, hiện tiền dành riêng là 0 đồng.';
      await addMessage('m1', turn1, '2026-11-20T07:00:00.000Z');
      const ingested1 = await ingestUserFacts({
        sessionId,
        messageId: 'm1',
        messageText: turn1,
        state: null,
        language: 'vi',
        currency: 'VND',
        now: '2026-11-20T07:00:00.000Z',
        generateFactId: nextFactId,
      });
      expect(ingested1.status).toBe('ingested');
      if (ingested1.status !== 'ingested') throw Error('Expected ingested');

      const step1Tool = await executeTool(
        'plan_savings_goal',
        {},
        ['plan_savings_goal'],
        {
          sessionId,
          stateRevision: ingested1.newState.revision,
          state: ingested1.newState,
          deadline: Date.now() + 5_000,
        },
      );
      expect(step1Tool).toEqual({
        status: 'needs_clarification',
        fields: ['savingsMonths'],
      });

      const recorded = await recordPendingFields(
        ingested1.newState,
        ['savingsMonths'],
        {
          now: '2026-11-20T07:00:01.000Z',
          sourceMessageId: 'm1',
        },
      );
      if (recorded.status !== 'updated') throw Error('Expected updated');

      // Bare "6" and monetary "6 triệu" must be rejected without writing to DB
      for (const [idx, invalidReply] of ['6', '6 triệu'].entries()) {
        await addMessage(
          `bad-${idx}`,
          invalidReply,
          `2026-11-20T07:00:0${idx + 2}.000Z`,
        );
        const badResult = await ingestUserFacts({
          sessionId,
          messageId: `bad-${idx}`,
          messageText: invalidReply,
          state: recorded.newState,
          language: 'vi',
          currency: 'VND',
          now: `2026-11-20T07:00:0${idx + 2}.000Z`,
          generateFactId: nextFactId,
        });
        expect(badResult).toEqual({
          status: 'no_change',
          reason: 'no_new_facts',
        });
        expect((await readConversationState(sessionId))?.revision).toBe(
          recorded.newState.revision,
        );
      }

      // Valid duration reply ("6 tháng" or "6tháng")
      await addMessage('m2', validDurationText, '2026-11-20T07:00:05.000Z');
      const ingested2 = await ingestUserFacts({
        sessionId,
        messageId: 'm2',
        messageText: validDurationText,
        state: recorded.newState,
        language: 'vi',
        currency: 'VND',
        now: '2026-11-20T07:00:05.000Z',
        generateFactId: nextFactId,
      });
      expect(ingested2.status).toBe('ingested');
      if (ingested2.status !== 'ingested') throw Error('Expected ingested');
      expect(ingested2.addedFields).toEqual(['savingsMonths']);
      expect(ingested2.newState.pendingFields).toEqual([]);
      expect(ingested2.newState.activeScenario.savingsMonths).toMatchObject({
        status: 'known',
        value: 6,
      });

      await verifyStateInDb(ingested2.newState);

      const step2Tool = await executeTool(
        'plan_savings_goal',
        {},
        ['plan_savings_goal'],
        {
          sessionId,
          stateRevision: ingested2.newState.revision,
          state: ingested2.newState,
          deadline: Date.now() + 5_000,
        },
      );
      expect(step2Tool).toMatchObject({
        status: 'ok',
        data: {
          monthlyAvailable: 5_000_000,
          requiredMonthlySaving: 4_000_000,
          remainingAfterSaving: 1_000_000,
          months: 6,
        },
      });
    },
  );
});

describe('4. Correction 1 & Correction 2 after empty-session ingestion (no preloaded fixture)', () => {
  it('refuses to treat corrections as ingestion, preserves supersedes_id chains across 2 income corrections and 1 duration correction, and recalculates plan_savings_goal', async () => {
    const turn1 =
      'Thu nhập 15 triệu mỗi tháng, tổng chi 10 triệu mỗi tháng đã gồm trả nợ, mục tiêu 24 triệu trong 6 tháng, dành riêng 0 đồng.';
    await addMessage('m1', turn1, '2026-11-20T07:00:00.000Z');
    const ingested = await ingestUserFacts({
      sessionId,
      messageId: 'm1',
      messageText: turn1,
      state: null,
      language: 'vi',
      currency: 'VND',
      now: '2026-11-20T07:00:00.000Z',
      generateFactId: nextFactId,
    });
    if (ingested.status !== 'ingested') throw Error('Expected ingested');
    let state = ingested.newState;

    // Correction 1: income 15M -> 18M
    const corr1Text = 'Thực ra thu nhập 18 triệu';
    await addMessage('m2', corr1Text, '2026-11-20T07:01:00.000Z');
    expect(
      await ingestUserFacts({
        sessionId,
        messageId: 'm2',
        messageText: corr1Text,
        state,
        language: 'vi',
        currency: 'VND',
        now: '2026-11-20T07:01:00.000Z',
        generateFactId: nextFactId,
      }),
    ).toEqual({ status: 'no_change', reason: 'correction_detected' });

    const prop1 = detectCorrection(corr1Text, 'm2', state, {
      language: 'vi',
      currency: 'VND',
    });
    expect(prop1).toMatchObject({
      targetField: 'income',
      proposedValue: 18_000_000,
    });
    const commit1 = await commitCorrection(state, prop1!, {
      now: '2026-11-20T07:01:00.000Z',
      generateFactId: nextFactId,
    });
    if (commit1.status !== 'committed') throw Error('Expected committed');
    state = commit1.newState;

    // Correction 2: income 18M -> 20M
    const corr2Text = 'À nhầm, thu nhập 20 triệu';
    await addMessage('m3', corr2Text, '2026-11-20T07:02:00.000Z');
    expect(
      await ingestUserFacts({
        sessionId,
        messageId: 'm3',
        messageText: corr2Text,
        state,
        language: 'vi',
        currency: 'VND',
        now: '2026-11-20T07:02:00.000Z',
        generateFactId: nextFactId,
      }),
    ).toEqual({ status: 'no_change', reason: 'correction_detected' });

    const prop2 = detectCorrection(corr2Text, 'm3', state, {
      language: 'vi',
      currency: 'VND',
    });
    expect(prop2).toMatchObject({
      targetField: 'income',
      proposedValue: 20_000_000,
    });
    const commit2 = await commitCorrection(state, prop2!, {
      now: '2026-11-20T07:02:00.000Z',
      generateFactId: nextFactId,
    });
    if (commit2.status !== 'committed') throw Error('Expected committed');
    state = commit2.newState;

    // Duration correction: savingsMonths 6 -> 12
    const corr3Text = 'Thực ra thời hạn 12 tháng';
    await addMessage('m4', corr3Text, '2026-11-20T07:03:00.000Z');
    expect(
      await ingestUserFacts({
        sessionId,
        messageId: 'm4',
        messageText: corr3Text,
        state,
        language: 'vi',
        currency: 'VND',
        now: '2026-11-20T07:03:00.000Z',
        generateFactId: nextFactId,
      }),
    ).toEqual({ status: 'no_change', reason: 'correction_detected' });

    const prop3 = detectCorrection(corr3Text, 'm4', state, {
      language: 'vi',
      currency: 'VND',
    });
    expect(prop3).toMatchObject({
      targetField: 'savingsMonths',
      proposedValue: 12,
    });
    const commit3 = await commitCorrection(state, prop3!, {
      now: '2026-11-20T07:03:00.000Z',
      generateFactId: nextFactId,
    });
    if (commit3.status !== 'committed') throw Error('Expected committed');
    state = commit3.newState;

    const incomeFacts = state.facts.filter(
      (f) => isMoneyFact(f) && f.kind === 'income',
    );
    expect(
      incomeFacts.map((f) => [
        isMoneyFact(f) ? f.amount : 0,
        Boolean(f.supersedes_id),
      ]),
    ).toEqual([
      [15_000_000, false],
      [18_000_000, true],
      [20_000_000, true],
    ]);
    expect(incomeFacts[1].supersedes_id).toBe(incomeFacts[0].id);
    expect(incomeFacts[2].supersedes_id).toBe(incomeFacts[1].id);

    const durationFacts = state.facts.filter(isDurationFact);
    expect(durationFacts.map((f) => [f.months, Boolean(f.supersedes_id)])).toEqual([
      [6, false],
      [12, true],
    ]);
    expect(durationFacts[1].supersedes_id).toBe(durationFacts[0].id);

    await verifyStateInDb(state);

    const sources = await readChatSourceMessages(
      db,
      sessionId,
      state.facts.map((fact) => fact.source_message_id),
    );
    const contextPayload = buildAdviceContext(state, corr3Text, {
      language: 'vi',
      currency: 'VND',
      sourceMessages: sources,
    });
    expect(
      validateConversationStateFacts(contextPayload.activeFacts, sources, {
        sessionId,
        scenario: contextPayload.scenario,
      }),
    ).toEqual({ valid: true });

    const finalTool = await executeTool(
      'plan_savings_goal',
      {},
      ['plan_savings_goal'],
      {
        sessionId,
        stateRevision: state.revision,
        state,
        deadline: Date.now() + 5_000,
      },
    );
    expect(finalTool).toMatchObject({
      status: 'ok',
      stateRevision: 4,
      data: {
        monthlyAvailable: 10_000_000,
        requiredMonthlySaving: 2_000_000,
        remainingAfterSaving: 8_000_000,
        months: 12,
        goalAmount: 24_000_000,
        savingsForGoal: 0,
      },
    });
  });
});

describe('5. Safety boundaries: no overwrite of known slots, empty prompt, optimistic lock conflict, and deleted session', () => {
  it('does not create an empty database record when an initial message has no verifiable facts', async () => {
    for (const [idx, text] of [
      'Xin chào',
      'Giúp tôi lập kế hoạch tiết kiệm',
      'Thu nhập 2 lít mỗi tháng',
    ].entries()) {
      await addMessage(`empty-${idx}`, text);
      const res = await ingestUserFacts({
        sessionId,
        messageId: `empty-${idx}`,
        messageText: text,
        state: null,
        language: 'vi',
        currency: 'VND',
        now,
        generateFactId: nextFactId,
      });
      expect(res).toEqual({ status: 'no_change', reason: 'no_new_facts' });
      expect(await readConversationState(sessionId)).toBeNull();
    }
  });

  it('never overwrites an already known slot when the user restates a field without a correction signal', async () => {
    await addMessage('m1', 'Thu nhập 15 triệu mỗi tháng');
    const first = await ingestUserFacts({
      sessionId,
      messageId: 'm1',
      messageText: 'Thu nhập 15 triệu mỗi tháng',
      state: null,
      language: 'vi',
      currency: 'VND',
      now,
      generateFactId: nextFactId,
    });
    if (first.status !== 'ingested') throw Error('Expected ingested');
    const snapshot = structuredClone(first.newState);

    await addMessage('m2', 'Thu nhập của tôi là 20 triệu mỗi tháng');
    const restate = await ingestUserFacts({
      sessionId,
      messageId: 'm2',
      messageText: 'Thu nhập của tôi là 20 triệu mỗi tháng',
      state: first.newState,
      language: 'vi',
      currency: 'VND',
      now,
      generateFactId: nextFactId,
    });
    expect(restate).toEqual({ status: 'no_change', reason: 'no_new_facts' });
    expect(first.newState).toEqual(snapshot);
    expect(await readConversationState(sessionId)).toEqual(snapshot);
  });

  it('returns conflict without retrying when state revision is stale, and validation_failed when source message/session was deleted', async () => {
    await addMessage('m1', 'Thu nhập 15 triệu mỗi tháng');
    const first = await ingestUserFacts({
      sessionId,
      messageId: 'm1',
      messageText: 'Thu nhập 15 triệu mỗi tháng',
      state: null,
      language: 'vi',
      currency: 'VND',
      now,
      generateFactId: nextFactId,
    });
    if (first.status !== 'ingested') throw Error('Expected ingested');

    await addMessage('m2', 'Tổng chi 10 triệu mỗi tháng');
    const second = await ingestUserFacts({
      sessionId,
      messageId: 'm2',
      messageText: 'Tổng chi 10 triệu mỗi tháng',
      state: first.newState,
      language: 'vi',
      currency: 'VND',
      now,
      generateFactId: nextFactId,
    });
    if (second.status !== 'ingested') throw Error('Expected ingested');

    // Stale revision (first.newState has revision 1, DB is at revision 2)
    await addMessage('m3', 'Mục tiêu 24 triệu trong 6 tháng');
    const staleIngest = await ingestUserFacts({
      sessionId,
      messageId: 'm3',
      messageText: 'Mục tiêu 24 triệu trong 6 tháng',
      state: first.newState,
      language: 'vi',
      currency: 'VND',
      now,
      generateFactId: nextFactId,
    });
    expect(staleIngest).toEqual({ status: 'no_change', reason: 'conflict' });
    expect(
      await recordPendingFields(first.newState, ['savingsForGoal'], {
        now,
        sourceMessageId: 'm3',
      }),
    ).toEqual({ status: 'rejected', reason: 'conflict' });

    // Deleted session / missing source message -> validation_failed
    await deleteChatSessions(db, [sessionId]);
    const deletedIngest = await ingestUserFacts({
      sessionId,
      messageId: 'm3',
      messageText: 'Mục tiêu 24 triệu trong 6 tháng',
      state: null,
      language: 'vi',
      currency: 'VND',
      now,
      generateFactId: nextFactId,
    });
    expect(deletedIngest).toEqual({
      status: 'no_change',
      reason: 'validation_failed',
    });
    expect(await readConversationState(sessionId)).toBeNull();
  });
});
