import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { migrate, type Database, type Queries } from '@/data/migrate';
import { saveChatMessage, readChatSourceMessages } from '@/data/repository';
import {
  readConversationState,
  writeConversationState,
} from '@/data/conversation-state';
import {
  ConversationStateSchema,
  isDurationFact,
  isMoneyFact,
  type ConversationState,
} from '@pfm/contracts';
import { detectCorrection } from './correction-detection';
import { commitCorrection } from './correction-commit';
import { buildAdviceContext, adviceContextToHistory } from './advice-context';
import { validateConversationStateFacts } from './advice-state-validation';
import { adviceStateFixture } from './advice-context.fixtures';
import { RemoteAIService } from './ai-service';

let sqlite: DatabaseSync;
let db: Database;
const analysis = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/data/connection', () => ({
  withDatabase: (task: (db: Database) => Promise<unknown>) => task(db),
}));
vi.mock('expo-crypto', () => ({
  randomUUID: () => '11111111-2222-4333-8444-555555555555',
}));
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('./ai-auth', () => ({
  readAIAuth: async () => ({ mode: 'guest', deviceId: 'test-device' }),
  aiAuthHeaders: () => ({}),
}));
vi.mock('@/state/preferences', () => ({
  usePreferences: {
    getState: () => ({ language: 'vi', currency: 'VND', exchangeRate: null }),
  },
  formatCurrencyAmount: (value: number) => String(value),
}));
vi.mock('@/data/analysis', () => ({ readAnalysisSummary: analysis.read }));
vi.mock('@/data/advice-groups', () => ({ readAdviceGroups: async () => [] }));
const context = { language: 'vi' as const, currency: 'VND' as const };
const now = '2026-11-16T12:00:00.000Z';
const originalFetch = global.fetch;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
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
  const { state, sourceMessages } = adviceStateFixture();
  for (const source of sourceMessages)
    await saveChatMessage(
      db,
      source.id,
      source.text,
      source.createdAt,
      state.sessionId,
    );
  await writeConversationState({ ...state, revision: 0 });
  analysis.read
    .mockReset()
    .mockRejectedValue(new Error('Unexpected app-summary fallback'));
});
afterEach(() => {
  global.fetch = originalFetch;
  sqlite.close();
});

async function correct(
  state: ConversationState,
  text: string,
  messageId: string,
  factId: string,
) {
  await saveChatMessage(db, messageId, text, now, state.sessionId);
  const proposal = detectCorrection(text, messageId, state, context);
  expect(proposal).toMatchObject({
    targetField: 'income',
    reason: 'explicit_correction',
    ambiguous: false,
  });
  if (!proposal) throw Error('Expected proposal');
  const result = await commitCorrection(state, proposal, {
    now,
    generateFactId: () => factId,
  });
  expect(result.status).toBe('committed');
  if (result.status !== 'committed') throw Error('Expected committed');
  return result.newState;
}

it('S5 persists 12m income and computes 2m surplus, 4m saving and -2m remaining in one advice turn', async () => {
  const initial = (await readConversationState('session-1'))!;
  const question =
    'Thực ra thu nhập của tôi là 12 triệu/tháng. Tính lại kế hoạch tiết kiệm giúp tôi.';
  const next = await correct(initial, question, 'current', 'income-12');
  expect(next.revision).toBe(2);
  expect(next.activeScenario.income).toMatchObject({
    value: 12_000_000,
    factIds: ['income-12'],
  });
  expect(await readConversationState('session-1')).toEqual(next);
  const sources = await readChatSourceMessages(
    db,
    next.sessionId,
    next.facts.map((f) => f.source_message_id),
  );
  const payload = buildAdviceContext(next, question, {
    ...context,
    sourceMessages: sources,
  });
  expect(
    validateConversationStateFacts(payload.activeFacts, sources, {
      sessionId: next.sessionId,
      scenario: payload.scenario,
    }),
  ).toEqual({ valid: true });
  expect(
    payload.activeFacts
      .filter((f) => isMoneyFact(f) && f.kind === 'income')
      .map((f) => (isMoneyFact(f) ? f.amount : 0)),
  ).toEqual([12_000_000]);
  const history = adviceContextToHistory(payload).filter(
    (item) => item.id !== 'current',
  );
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  global.fetch = vi.fn(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    const path = String(url);
    requests.push({ path, body });
    if (path.endsWith('/plan'))
      return new Response(
        JSON.stringify({
          success: true,
          requestId: body.requestId,
          planToken: 'test-plan',
          selection: {
            metrics: [
              'monthly_income_avg',
              'surplus_median',
              'savings_required_monthly',
              'surplus_after_savings_goal',
            ],
            scenario: {
              savingsTarget: 24_000_000,
              savingsForGoal: 0,
              savingsMonths: 6,
              conversationFacts: [
                {
                  id: 'plan-income',
                  source_message_id: body.requestId,
                  kind: 'income',
                  amount: 12_000_000,
                  currency: 'VND',
                  period: 'monthly',
                  source: 'user_statement',
                  mode: 'actual',
                },
                {
                  id: 'plan-expense',
                  source_message_id: 'm2',
                  kind: 'expense',
                  amount: 10_000_000,
                  currency: 'VND',
                  period: 'monthly',
                  includes: ['debt'],
                  source: 'user_statement',
                  mode: 'actual',
                },
                {
                  id: 'plan-goal',
                  source_message_id: 'm3',
                  kind: 'saving_goal',
                  amount: 24_000_000,
                  currency: 'VND',
                  period: 'one_off',
                  source: 'user_statement',
                  mode: 'actual',
                },
              ],
            },
          },
        }),
      );
    return new Response(
      JSON.stringify({
        success: true,
        answer:
          'Bạn dư 2 triệu trước mục tiêu; cần dành 4 triệu và còn thiếu 2 triệu mỗi tháng.',
      }),
    );
  });
  const result = await new RemoteAIService({
    baseUrl: 'https://proxy.example',
  }).sendMessage(
    question,
    {
      balance: 12_000_000,
      monthlyIncome: 15_000_000,
      monthlyExpense: 10_000_000,
      monthlyNet: 5_000_000,
      topCategories: [],
      budgetsCount: 0,
      goalsCount: 1,
    },
    'current',
    history,
  );
  expect(
    requests.map((r) => r.path.split('/').at(-1)),
    result.replyText,
  ).toEqual(['plan', 'complete']);
  expect(requests[1].body.results).toMatchObject({
    monthly_income_avg: 12_000_000,
    surplus_median: 2_000_000,
    savings_required_monthly: 4_000_000,
    surplus_after_savings_goal: -2_000_000,
  });
  expect(JSON.stringify(requests[0].body)).not.toContain('Thu nhập 15');
  expect(result.replyText).toContain('thiếu 2 triệu');
  expect(analysis.read).not.toHaveBeenCalled();
  expect(initial.activeScenario.income).toMatchObject({ value: 15_000_000 });
});

it('persists the 15 -> 12 -> 14 income chain and exposes only the latest active fact', async () => {
  const initial = (await readConversationState('session-1'))!;
  const second = await correct(
    initial,
    'Thực ra thu nhập 12 triệu/tháng',
    'correction-1',
    'income-12',
  );
  const final = await correct(
    second,
    'Thực ra thu nhập 14 triệu/tháng',
    'correction-2',
    'income-14',
  );
  expect(final.revision).toBe(3);
  expect(
    final.facts
      .filter((f) => isMoneyFact(f) && f.kind === 'income')
      .map((f) => [f.id, isMoneyFact(f) ? f.amount : 0, f.supersedes_id]),
  ).toEqual([
    ['income', 15_000_000, undefined],
    ['income-12', 12_000_000, 'income'],
    ['income-14', 14_000_000, 'income-12'],
  ]);
  const sources = await readChatSourceMessages(
    db,
    final.sessionId,
    final.facts.map((f) => f.source_message_id),
  );
  const payload = buildAdviceContext(final, 'Thực ra thu nhập 14 triệu/tháng', {
    ...context,
    sourceMessages: sources,
  });
  expect(
    payload.activeFacts.filter((f) => f.kind === 'income').map((f) => f.id),
  ).toEqual(['income-14']);
  expect(payload.sourceEvidence.map((s) => s.id)).not.toContain('correction-1');
  expect(
    ConversationStateSchema.safeParse(await readConversationState('session-1'))
      .success,
  ).toBe(true);
});

it('rejects a stale revision atomically and preserves the already committed correction', async () => {
  const initial = (await readConversationState('session-1'))!;
  const latest = await correct(
    initial,
    'Thực ra thu nhập 12 triệu/tháng',
    'correction-1',
    'income-12',
  );
  const text = 'Thực ra thu nhập 14 triệu/tháng';
  await saveChatMessage(db, 'stale-source', text, now, initial.sessionId);
  const proposal = detectCorrection(text, 'stale-source', initial, context)!;
  expect(
    await commitCorrection(initial, proposal, {
      now,
      generateFactId: () => 'stale-fact',
    }),
  ).toEqual({ status: 'rejected', reason: 'conflict' });
  expect(await readConversationState(initial.sessionId)).toEqual(latest);
});

it('detects, commits, persists and validates a 6 -> 12 -> 18 duration correction chain and a savingsForGoal negation to 0', async () => {
  const initial = (await readConversationState('session-1'))!;

  // 1. Duration correction 6 -> 12
  const text1 = 'Thực ra thời hạn là 12 tháng';
  await saveChatMessage(db, 'dur-1', text1, now, initial.sessionId);
  const proposal1 = detectCorrection(text1, 'dur-1', initial, context);
  expect(proposal1).toMatchObject({
    targetField: 'savingsMonths',
    proposedValue: 12,
    reason: 'explicit_correction',
    ambiguous: false,
  });
  const res1 = await commitCorrection(initial, proposal1!, {
    now,
    generateFactId: () => 'months-12',
  });
  expect(res1.status).toBe('committed');
  if (res1.status !== 'committed') throw Error('Expected committed');

  // 2. Duration correction 12 -> 18
  const text2 = 'Sửa lại thời hạn 18 tháng';
  await saveChatMessage(db, 'dur-2', text2, now, initial.sessionId);
  const proposal2 = detectCorrection(
    text2,
    'dur-2',
    res1.newState,
    context,
  );
  expect(proposal2).toMatchObject({
    targetField: 'savingsMonths',
    proposedValue: 18,
    reason: 'explicit_correction',
    ambiguous: false,
  });
  const res2 = await commitCorrection(res1.newState, proposal2!, {
    now,
    generateFactId: () => 'months-18',
  });
  expect(res2.status).toBe('committed');
  if (res2.status !== 'committed') throw Error('Expected committed');

  // 3. Negation correction for savingsForGoal -> 0
  const text3 = 'Thực ra tôi chưa có tiền dành riêng';
  await saveChatMessage(db, 'neg-1', text3, now, initial.sessionId);
  const proposal3 = detectCorrection(
    text3,
    'neg-1',
    res2.newState,
    context,
  );
  expect(proposal3).toMatchObject({
    targetField: 'savingsForGoal',
    proposedValue: 0,
    reason: 'negation',
    ambiguous: false,
  });
  const res3 = await commitCorrection(res2.newState, proposal3!, {
    now,
    generateFactId: () => 'saved-0',
  });
  expect(res3.status).toBe('committed');
  if (res3.status !== 'committed') throw Error('Expected committed');

  const finalState = res3.newState;
  expect(
    finalState.facts
      .filter(isDurationFact)
      .map((f) => [f.id, f.months, f.supersedes_id]),
  ).toEqual([
    ['months', 6, undefined],
    ['months-12', 12, 'months'],
    ['months-18', 18, 'months-12'],
  ]);
  expect(
    finalState.facts
      .filter((f) => isMoneyFact(f) && f.kind === 'savingsForGoal')
      .map((f) => [f.id, isMoneyFact(f) ? f.amount : -1, f.supersedes_id]),
  ).toEqual([
    ['saved', 0, undefined],
    ['saved-0', 0, 'saved'],
  ]);

  const sources = await readChatSourceMessages(
    db,
    finalState.sessionId,
    finalState.facts.map((f) => f.source_message_id),
  );
  const payload = buildAdviceContext(finalState, text3, {
    ...context,
    sourceMessages: sources,
  });
  expect(
    validateConversationStateFacts(payload.activeFacts, sources, {
      sessionId: finalState.sessionId,
      scenario: payload.scenario,
    }),
  ).toEqual({ valid: true });
});
