import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate, type Database, type Queries } from '@/data/migrate';
import { seed, DEFAULT_WALLET_ID } from '@/data/seed';
import { createBudget } from '@/data/budgets';
import { createTransaction } from '@/data/transactions';
import { saveChatMessage } from '@/data/repository';
import { readConversationState } from '@/data/conversation-state';
import { flags } from '../../app.config';
import { runAdvice } from './advice-agent';
import { loadPersistedAIReplyMap, savePersistedAIReplyIfMessageExists } from './ai-service';
import { formatAgentFallbackReply } from './advice-agent-fallback';

let sqlite: DatabaseSync;
let db: Database;
vi.mock('expo-crypto', () => ({ randomUUID: () => '11111111-2222-4333-8444-555555555555' }));
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('./ai-auth', () => ({ readAIAuth: async () => ({ mode: 'guest', deviceId: 'test' }), aiAuthHeaders: () => ({}) }));
vi.mock('@/data/connection', () => ({ withDatabase: (task: (db: Database) => Promise<unknown>) => task(db) }));
vi.mock('@/state/preferences', () => ({ usePreferences: { getState: () => ({ language: 'vi', currency: 'VND', exchangeRate: null }) }, formatCurrencyAmount: (value: number) => String(value) }));

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const queries: Queries = {
    execAsync: async (sql) => { sqlite.exec(sql); },
    runAsync: async (sql, ...params) => sqlite.prepare(sql).run(...params),
    getFirstAsync: async <T,>(sql: string, ...params: (string | number | null)[]) => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T,>(sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params) as T[],
  };
  db = { ...queries, transaction: async (task) => { sqlite.exec('BEGIN IMMEDIATE'); try { await task(queries); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
  await migrate(db);
  await seed(db, '2026-11-16T12:00:00.000Z');
  flags.useAgentLoop = true;
});
afterEach(() => { flags.useAgentLoop = false; sqlite.close(); });

const baseInput = { context: { balance: 0, monthlyIncome: 0, monthlyExpense: 0, monthlyNet: 0, topCategories: [], budgetsCount: 0, goalsCount: 0 }, sessionId: 'session-1', baseUrl: 'https://example.test' };
const full = 'Tính kế hoạch tiết kiệm. Thu nhập 15 triệu mỗi tháng, tổng chi 10 triệu mỗi tháng đã gồm trả nợ, mục tiêu 24 triệu trong 6 tháng, dành riêng 0 đồng.';
let counter = 0;
async function send(id: string, prompt: string, fetchFn: typeof fetch, extra: Partial<Parameters<typeof runAdvice>[0]> = {}) {
  await saveChatMessage(db, id, prompt, '2026-11-16T12:00:00.000Z', 'session-1');
  return runAdvice({ ...baseInput, prompt, userMessageId: id, fetchFn, generateId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`, ...extra });
}
function model(events = 'event: delta\ndata: {"seq":1,"text":"Đã ","verification":"segment_passed"}\n\nevent: delta\ndata: {"seq":2,"text":"tính.","verification":"segment_passed"}\n\nevent: done\ndata: {"incomplete":false,"verification":"passed"}\n\n') {
  const requests: Record<string, any>[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (body.stream) return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
    const policy = { sessionId: body.turn.sessionId, scenarioId: body.turn.scenarioId, stateRevision: body.turn.stateRevision, grants: [{ name: 'plan_savings_goal', params: {} }] };
    const first = body.messages.length === 1;
    return Response.json({ choices: [{ finish_reason: first ? 'tool_calls' : 'stop', message: { role: 'assistant', content: null, tool_calls: first ? [{ id: 'call', type: 'function', function: { name: 'plan_savings_goal', arguments: '{}' } }] : [] } }], continuationToken: 'token', deadline: Date.now() + 30000, policy });
  });
  return { fetchFn, requests };
}

it('reports a monthly shortfall in the savings scenario currency', () => {
  const reply = formatAgentFallbackReply([{ name: 'plan_savings_goal', params: {}, result: {
    status: 'ok', stateRevision: 1, calculationVersion: 1, data: {
      monthlyAvailable: 10000, requiredMonthlySaving: 15000,
      remainingAfterSaving: -5000, months: 6, goalAmount: 90000, savingsForGoal: 0,
    },
  } }], { reason: 'TEST', language: 'vi', currency: 'USD' });
  expect(reply).toContain('-$50.00');
  expect(reply).toContain('Thiếu hụt');
  expect(reply).toContain('$150.00');
});

it('labels remaining budget and preserves VND without currency conversion', () => {
  const reply = formatAgentFallbackReply([{ name: 'calculate_budget_status', params: {}, result: {
    status: 'ok', stateRevision: 1, calculationVersion: 1,
    data: { budgets: [{ id: 'b', category_id: 'c', limit_amount: 100000, spent_amount: 120000, remaining_amount: 0, overspent_amount: 20000 }] },
  } }], { reason: 'TEST', language: 'vi', currency: 'USD' });
  expect(reply).toContain('Ngân sách còn lại');
  expect(reply).toContain('20.000 ₫');
  expect(reply).not.toContain('Số dư');
});

it('uses a safe message when no observation succeeded', () => {
  const reply = formatAgentFallbackReply([{ name: 'plan_savings_goal', params: {}, result: { status: 'error', code: 'DATA_ERROR', retryable: false } }], { reason: 'SECRET', language: 'en', currency: 'VND' });
  expect(reply).not.toContain('SECRET');
  expect(reply).not.toContain('DATA_ERROR');
});

it('starts with an empty session, streams verified text and persists its status', async () => {
  const server = model();
  const deltas = vi.fn();
  const reply = await send('m1', full, server.fetchFn, { onDelta: deltas });
  expect(reply).toMatchObject({ incomplete: false, verification: 'passed' });
  expect(deltas.mock.calls.map(([delta]) => [delta.seq, delta.verifiedText])).toEqual([[1, 'Đã '], [2, 'Đã tính.']]);
  expect(await savePersistedAIReplyIfMessageExists(db, reply, 'session-1')).toBe(true);
  expect((await loadPersistedAIReplyMap(db)).m1).toMatchObject({ incomplete: false, verification: 'passed' });
});

it('records the missing reserved amount and accepts a zero follow-up', async () => {
  const server = model();
  const first = await send('m1', 'Tính kế hoạch tiết kiệm. Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn tiết kiệm 24 triệu trong 6 tháng.', server.fetchFn);
  expect(first.replyText).toContain('dành riêng');
  expect(server.fetchFn).not.toHaveBeenCalled();
  expect((await readConversationState('session-1'))?.pendingFields).toContain('savingsForGoal');
  const reply = await send('m2', 'chưa có tiền dành riêng', server.fetchFn);
  expect(reply.verification).toBe('passed');
  expect(server.requests[0].messages[0].content).toBe('Tính kế hoạch tiết kiệm giúp tôi');
  expect(server.requests[0].turn.context.sourceMessages.map((m: { text: string }) => m.text)).toContain('chưa có tiền dành riêng');
  expect((await readConversationState('session-1'))?.activeScenario.savingsForGoal).toMatchObject({ value: 0 });
});

it('persists an incomplete verified prefix', async () => {
  const server = model('event: delta\ndata: {"seq":1,"text":"Đoạn đầu","verification":"segment_passed"}\n\nevent: error\ndata: {"code":"VERIFICATION_FAILED","incomplete":true,"verification":"failed"}\n\n');
  const reply = await send('m1', full, server.fetchFn);
  expect(reply).toMatchObject({ replyText: 'Đoạn đầu', incomplete: true, verification: 'failed' });
  expect(await savePersistedAIReplyIfMessageExists(db, reply, 'session-1')).toBe(true);
  expect((await loadPersistedAIReplyMap(db)).m1).toMatchObject({ incomplete: true, verification: 'failed' });
});

it('does not persist a reply for a different session', async () => {
  await saveChatMessage(db, 'm1', full, '2026-11-16T12:00:00.000Z', 'session-1');
  expect(await savePersistedAIReplyIfMessageExists(db, { id: 'ai-m1', userMessageId: 'm1', replyText: 'x', createdAt: '2026-11-16T12:00:00.000Z' }, 'wrong')).toBe(false);
  expect(await loadPersistedAIReplyMap(db)).toEqual({});
});

it('commits a correction before a single agent turn', async () => {
  const first = model();
  await send('m1', full, first.fetchFn);
  const second = model();
  const reply = await send('m2', 'Thực ra thu nhập 18 triệu', second.fetchFn);
  expect(reply.verification).toBe('passed');
  expect((await readConversationState('session-1'))?.activeScenario.income).toMatchObject({ value: 18_000_000 });
  expect(second.requests.filter((request) => request.messages.length === 1)).toHaveLength(1);
  const result = JSON.parse(second.requests.find((request) => request.stream)!.messages.find((message: { role: string }) => message.role === 'tool').content);
  expect(result.data.monthlyAvailable).toBe(8_000_000);
});

it('retains the verified prefix when the stream ends without done', async () => {
  const server = model('event: delta\ndata: {"seq":1,"text":"Đoạn đầu","verification":"segment_passed"}\n\n');
  expect(await send('m1', full, server.fetchFn)).toMatchObject({ replyText: 'Đoạn đầu', incomplete: true, verification: 'incomplete' });
});

it('returns deterministic savings values when final verification fails before any text', async () => {
  const server = model('event: error\ndata: {"code":"VERIFICATION_FAILED","incomplete":true,"verification":"failed"}\n\n');
  const reply = await send('m1', full.replace('24 triệu', '60 triệu'), server.fetchFn);
  expect(reply.replyText).toContain('Thiếu hụt');
  expect(reply.replyText).toContain('-5.000.000');
});

it('retains the prefix when cancelled while reading the stream', async () => {
  const controller = new AbortController();
  const server = model();
  const original = server.fetchFn;
  const fetchFn: typeof fetch = async (url, init) => {
    if (JSON.parse(String(init?.body)).stream) {
      const stream = new ReadableStream<Uint8Array>({ start(streamController) { streamController.enqueue(new TextEncoder().encode('event: delta\ndata: {"seq":1,"text":"Đoạn đầu","verification":"segment_passed"}\n\n')); } });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    return original(url, init);
  };
  const reply = await send('m1', full, fetchFn, { signal: controller.signal, onDelta: () => controller.abort() });
  expect(reply).toMatchObject({ replyText: 'Đoạn đầu', incomplete: true, verification: 'incomplete' });
});

it('attempts server cancellation when a later selection is aborted', async () => {
  const controller = new AbortController();
  const server = model();
  const fetchFn: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.action && !body.stream && body.messages.length > 1) {
      setTimeout(() => controller.abort(), 0);
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    return server.fetchFn(url, init);
  };
  await send('m1', full, fetchFn, { signal: controller.signal });
  expect(server.requests.some((request) => request.action === 'cancel')).toBe(true);
});

it('formats a real budget observation without calling the remainder an account balance', async () => {
  const categoryId = '00000000-0000-4000-8001-000000000001';
  const budgetId = '00000000-0000-4000-8000-000000000999';
  const time = '2026-11-16T12:00:00.000Z';
  await createBudget(db, budgetId, { categoryId, amount: 1000000, startMonth: '2026-11' }, time);
  await createTransaction(db, 'transaction-1', { amount: 1500000, kind: 'expense', walletId: DEFAULT_WALLET_ID, categoryId, occurredOn: '2026-11-10', occurredAt: '2026-11-10T12:00:00.000Z' }, time);
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.stream) return new Response('event: error\ndata: {"code":"VERIFICATION_FAILED","incomplete":true,"verification":"failed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const first = body.messages.length === 1;
    const params = { month: '2026-11', budget_id: budgetId };
    return Response.json({ choices: [{ finish_reason: first ? 'tool_calls' : 'stop', message: { role: 'assistant', content: null, tool_calls: first ? [{ id: 'budget-call', type: 'function', function: { name: 'calculate_budget_status', arguments: JSON.stringify(params) } }] : [] } }], continuationToken: 'token', deadline: Date.now() + 30000, policy: { sessionId: body.turn.sessionId, scenarioId: body.turn.scenarioId, stateRevision: body.turn.stateRevision, grants: [{ name: 'calculate_budget_status', params }] } });
  });
  const reply = await send('budget-question', 'Kiểm tra ngân sách Ăn uống tháng 11/2026.', fetchFn);
  expect(reply.replyText).toContain('Ngân sách còn lại');
  expect(reply.replyText).toContain('500.000 ₫');
  expect(reply.replyText).not.toContain('Số dư');
});

it('routes open-ended daily earning planning to /v1/advice/coach with local snapshot and streams deltas', async () => {
  const time = '2026-11-16T12:00:00.000Z';
  await createTransaction(db, 'oct-exp', { amount: 4_000_000, kind: 'expense', walletId: DEFAULT_WALLET_ID, categoryId: null, occurredOn: '2026-10-10', occurredAt: '2026-10-10T12:00:00.000Z' }, time);
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(
      'event: delta\ndata: {"seq":1,"text":"Ước tính tham khảo: ","verification":"segment_passed"}\n\nevent: delta\ndata: {"seq":2,"text":"ngày đi làm 50k, ngày nghỉ 120k.","verification":"segment_passed"}\n\nevent: done\ndata: {"incomplete":false,"verification":"passed"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const deltas = vi.fn();
  const prompt =
    'Hôm nay 16/11 tôi có số dư là 2m624 với 2m là tiền hàng tháng nhận vào ngày 15. Trong tuần có 2-4-6 tôi sẽ lên công ty từ 8h sáng tới 6h tối, còn các ngày khác trong tuần tôi không lên cty. Giờ tôi muốn những ngày lên cty thì tôi sẽ chạy shopeefood ít lại còn những ngày nghĩ thì chạy nhiều hơn chút để bù thì tôi nên kiếm bao nhiêu 1 ngày là vừa.';
  const reply = await send('coach-1', prompt, fetchFn, { onDelta: deltas });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('https://example.test/v1/advice/coach');
  expect(requests[0].body.snapshot).toMatchObject({ monthlyExpenseAvg: 4_000_000, currency: 'VND' });
  expect(reply).toMatchObject({ incomplete: false, verification: 'passed' });
  expect(reply.replyText).toContain('ngày đi làm 50k, ngày nghỉ 120k.');
  expect(deltas).toHaveBeenCalledTimes(2);
});

it('forwards coaching follow-up replies with prior history to /v1/advice/coach', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(
      'event: delta\ndata: {"seq":1,"text":"Đã tính lại theo chi tiêu 4 triệu.","verification":"segment_passed"}\n\nevent: done\ndata: {"incomplete":false,"verification":"passed"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const reply = await send('coach-2', 'Mỗi tháng mình chi tầm 4 triệu, ngày đi làm chạy 50k thôi.', fetchFn, {
    history: [
      { id: 'coach-1', role: 'user', text: 'Tôi nên kiếm bao nhiêu 1 ngày là vừa?' },
      { id: 'ai-coach-1', role: 'assistant', text: 'Mỗi tháng bạn chi tiêu khoảng bao nhiêu?' },
    ],
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('https://example.test/v1/advice/coach');
  expect(requests[0].body.history).toEqual([
    { role: 'user', content: 'Tôi nên kiếm bao nhiêu 1 ngày là vừa?' },
    { role: 'assistant', content: 'Mỗi tháng bạn chi tiêu khoảng bao nhiêu?' },
  ]);
  expect(reply).toMatchObject({ incomplete: false, verification: 'passed' });
});

it('retains partial coaching text when aborted mid-stream', async () => {
  const controller = new AbortController();
  const fetchFn: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(
            new TextEncoder().encode(
              'event: delta\ndata: {"seq":1,"text":"Đoạn đầu tư vấn","verification":"segment_passed"}\n\n',
            ),
          );
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const reply = await send('coach-abort', 'Tôi nên kiếm bao nhiêu 1 ngày là vừa?', fetchFn, {
    signal: controller.signal,
    onDelta: () => controller.abort(),
  });
  expect(reply).toMatchObject({
    replyText: 'Đoạn đầu tư vấn',
    incomplete: true,
    verification: 'incomplete',
  });
});
