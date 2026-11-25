import { flags } from '../../app.config';
import * as Crypto from 'expo-crypto';
import { en } from '@/messages/en';
import { vi } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';
import { AdviceValidationContextSchema } from '@pfm/contracts';
import { classifyAdviceScope, resolveAdviceToolPolicy, today, type AdviceTopic } from '@pfm/domain';
import { withDatabase } from '@/data/connection';
import { readConversationState } from '@/data/conversation-state';
import { readChatSourceMessages } from '@/data/repository';
import { buildAdviceContext, adviceContextToHistory, getScenarioFactIds } from './advice-context';
import { validateConversationStateFacts } from './advice-state-validation';
import { detectCorrection } from './correction-detection';
import { commitCorrection } from './correction-commit';
import { ingestUserFacts, recordPendingFields } from './fact-ingestion';
import { runAgentLoop } from './advice-agent-loop';
import { createAgentTurnTransport } from './agent-http-adapter';
import { executeTool } from './advice-tools';
import { readAIAuth, aiAuthHeaders } from './ai-auth';
import { formatAgentFallbackReply } from './advice-agent-fallback';
import { readAgentFinalSse, type AgentVerifiedDelta } from './agent-sse-reader';
import {
  classifyLocally,
  defaultAIService,
  applyAdviceDisclaimer,
  buildAdviceClarification,
  getProxyBaseUrl,
  isDevRuntime,
  type AdviceHistoryItem,
  type AIResponsePayload,
  type AIServiceContext,
} from './ai-service';

export interface AdviceInput {
  prompt: string;
  context: AIServiceContext;
  userMessageId: string;
  history?: AdviceHistoryItem[];
  sessionId?: string;
  onDelta?: (delta: AgentVerifiedDelta) => void;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  generateId?: () => string;
}

function legacyAdvice(input: AdviceInput): Promise<AIResponsePayload> {
  return defaultAIService.sendMessage(
    input.prompt,
    input.context,
    input.userMessageId,
    input.history,
  );
}

async function withLinkedSignal<T>(outer: AbortSignal | undefined, inner: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!outer) return task(inner);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (outer.aborted || inner.aborted) abort();
  outer.addEventListener('abort', abort, { once: true });
  inner.addEventListener('abort', abort, { once: true });
  try { return await task(controller.signal); }
  finally { outer.removeEventListener('abort', abort); inner.removeEventListener('abort', abort); }
}

async function selectFetch(): Promise<typeof fetch> {
  const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node);
  const isWeb = typeof document !== 'undefined';
  if (!isNode && !isWeb) {
    try {
      const expoFetch = (await import('expo/fetch')).fetch;
      if (typeof expoFetch === 'function') return expoFetch as typeof fetch;
    } catch {
      /* Fall back to the runtime fetch. */
    }
  }
  return globalThis.fetch;
}

function hasLocalPii(text: string): boolean {
  return (
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i.test(text) ||
    /https?:\/\/[^\s]+/i.test(text) ||
    /(?:\+84|0)(?:3[2-9]|5[689]|7[06-9]|8[1-9]|9\d)\d{7}\b/.test(text) ||
    /\b\d{10,}\b/.test(text)
  );
}

function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

function isDataRefusal(prompt: string): boolean {
  return /\b(?:dung|khong|chua)\s+(?:(?:can|muon|co)\s+)?(?:xem|doc|liet ke|kiem tra|tinh|cho biet|biet|hien thi|so du)\b/.test(
    foldText(prompt),
  );
}

function isExplicitToolReadWithMissingParams(
  prompt: string,
  decisionFields?: readonly string[],
): boolean {
  if (!decisionFields?.length) return false;
  const text = foldText(prompt);
  if (
    decisionFields.includes('snapshotMonths') &&
    /\btrung binh\b/.test(text)
  ) {
    return true;
  }
  if (
    (decisionFields.includes('category_id') ||
      decisionFields.includes('observationRange') ||
      decisionFields.includes('transactionLimit') ||
      decisionFields.includes('transactionKind')) &&
    /\b(?:liet ke|danh sach|(?:xem\s+)?\d+\s+(?:giao dich|khoan chi|khoan thu))\b/.test(
      text,
    )
  ) {
    return true;
  }
  if (
    decisionFields.includes('budget_id') &&
    /\bngan sach\s+.+?\bthang\s+\d{1,2}\/\d{4}\b/.test(text)
  ) {
    return true;
  }
  return false;
}

const COACH_DIRECT_CLARIFICATION_FIELDS = new Set([
  'toolIntent',
  'budgetMonth',
  'budget_id',
  'snapshotMonths',
  'category_id',
  'observationRange',
  'transactionLimit',
  'transactionKind',
]);

function canUseCoachTurn(
  prompt: string,
  scope: ReturnType<typeof classifyAdviceScope>,
  history?: AdviceHistoryItem[],
  decisionFields?: readonly string[],
): boolean {
  if (isDataRefusal(prompt)) return false;
  if (isExplicitToolReadWithMissingParams(prompt, decisionFields)) return false;
  if (
    decisionFields &&
    (!decisionFields.length ||
      decisionFields.some((field) => !COACH_DIRECT_CLARIFICATION_FIELDS.has(field)))
  ) {
    return false;
  }
  if (scope.status === 'allowed') return true;
  if (
    scope.status === 'ambiguous' &&
    scope.reason === 'INSUFFICIENT_FINANCIAL_CONTEXT' &&
    history?.length
  ) {
    return history.some((item) => {
      if (item.role !== 'user') return false;
      const prior = classifyAdviceScope(item.text);
      return prior.status === 'allowed' && prior.topic !== 'savings_plan';
    });
  }
  return false;
}

async function readCoachSnapshot(params: {
  sessionId: string;
  stateRevision: number;
  currency: 'VND' | 'USD';
  context: AIServiceContext;
  now: () => number;
}) {
  const topCategories = (params.context.topCategories ?? [])
    .filter((item) => item.name && Number.isFinite(item.amount) && item.amount > 0)
    .slice(0, 6)
    .map((item) => ({
      name: item.name.slice(0, 80),
      amount: Math.trunc(item.amount),
    }));
  const extraSnapshot = {
    ...(topCategories.length ? { topCategories } : {}),
    ...(typeof params.context.budgetsCount === 'number'
      ? { budgetsCount: params.context.budgetsCount }
      : {}),
    ...(typeof params.context.goalsCount === 'number'
      ? { goalsCount: params.context.goalsCount }
      : {}),
  };
  try {
    const result = await executeTool(
      'get_financial_snapshot',
      {
        months: 3,
        fields: [
          'monthly_income_avg',
          'monthly_expense_avg',
          'liquid_balance',
          'months_with_data',
        ],
      },
      ['get_financial_snapshot'],
      {
        sessionId: params.sessionId,
        stateRevision: params.stateRevision,
        deadline: params.now() + 1500,
      },
    );
    if (result.status === 'ok') {
      const data = result.data as {
        indicators: Record<string, number | null>;
        period: { from: string; to: string };
        currency: 'VND' | 'USD';
      };
      return {
        monthlyIncomeAvg: data.indicators.monthly_income_avg ?? null,
        monthlyExpenseAvg: data.indicators.monthly_expense_avg ?? null,
        liquidBalance:
          data.indicators.liquid_balance ?? params.context.balance ?? null,
        monthsWithData: data.indicators.months_with_data ?? null,
        currentMonthIncome: params.context.monthlyIncome,
        currentMonthExpense: params.context.monthlyExpense,
        period: data.period,
        currency: data.currency,
        ...extraSnapshot,
      };
    }
  } catch {
    /* Fall back to aggregate dashboard context when snapshot read fails. */
  }
  return {
    liquidBalance: params.context.balance,
    currentMonthIncome: params.context.monthlyIncome,
    currentMonthExpense: params.context.monthlyExpense,
    currency: params.currency,
    ...extraSnapshot,
  };
}

/** Stream open-ended personal-finance coaching via `/v1/advice/coach` with safety verification. */
async function runCoachTurn(params: {
  input: AdviceInput;
  sessionId: string;
  stateRevision: number;
  language: 'vi' | 'en';
  currency: 'VND' | 'USD';
  strings: typeof vi | typeof en;
  now: () => number;
  generateId: () => string;
  reply: (replyText: string) => AIResponsePayload;
}): Promise<AIResponsePayload> {
  const { input, sessionId, stateRevision, language, currency, strings, now, generateId, reply } = params;
  const baseUrl = input.baseUrl ?? getProxyBaseUrl();
  if (!baseUrl || (!isDevRuntime() && !baseUrl.startsWith('https://')))
    return reply(strings.aiFallbackUnavailable);
  const snapshot = await readCoachSnapshot({
    sessionId,
    stateRevision,
    currency,
    context: input.context,
    now,
  });
  const history = (input.history ?? [])
    .slice(-6)
    .map((item) => ({
      role: item.role,
      content: item.text.trim().slice(0, 1000),
    }))
    .filter((item) => item.content.length > 0 && !hasLocalPii(item.content));
  const fetchFn = input.fetchFn ?? (await selectFetch());
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 25_000);
  try {
    return await withLinkedSignal(input.signal, timeout.signal, async (signal) => {
      const response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/v1/advice/coach`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'ngrok-skip-browser-warning': 'true',
          ...aiAuthHeaders(await readAIAuth(sessionId)),
        },
        body: JSON.stringify({
          requestId: generateId(),
          question: input.prompt,
          language,
          currency,
          ...(history.length ? { history } : {}),
          snapshot,
        }),
        signal,
      });
      if (!response.ok) {
        let code: string | undefined;
        try {
          const data = (await response.json()) as { code?: string; error?: string };
          code = data.code ?? data.error;
        } catch {
          /* Ignore non-JSON error bodies. */
        }
        if (response.status === 401 || code === 'INVALID_TOKEN') return reply(strings.AUTH_INVALID);
        if (code === 'GUEST_RATE_LIMIT_EXCEEDED') return reply(strings.GUEST_RATE_LIMIT_EXCEEDED);
        if (response.status === 429 || code === 'RATE_LIMIT_EXCEEDED' || code === 'QUOTA_EXCEEDED_DEVICE')
          return reply(strings.aiRateLimitExceededReply);
        if (code === 'PII_DETECTED') return reply(strings.aiReplyPii);
        if (code === 'ADVICE_OUT_OF_SCOPE') return reply(strings.aiReplyOutOfScope);
        if (code === 'ADVICE_RESTRICTED') return reply(strings.aiReplyRestricted);
        if (code === 'ADVICE_AMBIGUOUS') return reply(strings.aiReplyAmbiguous);
        return reply(strings.aiFallbackUnavailable);
      }
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
        void response.body?.cancel().catch(() => {});
        return reply(strings.aiFallbackUnavailable);
      }
      const streamResult = await readAgentFinalSse(response, {
        signal,
        onDelta: input.onDelta,
      });
      if (streamResult.status === 'completed')
        return applyAdviceDisclaimer(
          { ...reply(streamResult.text), incomplete: false, verification: 'passed' },
          input.prompt,
        );
      if (streamResult.text.length)
        return {
          ...reply(streamResult.text),
          incomplete: true,
          verification: streamResult.verification,
        };
      return reply(strings.aiFallbackUnavailable);
    });
  } catch (error) {
    if (input.signal?.aborted || (error as { name?: string })?.name === 'AbortError') {
      if (input.signal?.aborted) throw error;
      return reply(strings.aiFallbackUnavailable);
    }
    return reply(strings.aiFallbackUnavailable);
  } finally {
    clearTimeout(timer);
  }
}

/** Coordinate a locally verified advice turn. */
export async function runAdviceTurn(
  input: AdviceInput,
): Promise<AIResponsePayload> {
  if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const strings = usePreferences.getState().language === 'en' ? en : vi;
  if (hasLocalPii(input.prompt)) {
    return {
      id: `ai-${input.userMessageId}`,
      userMessageId: input.userMessageId,
      replyText: strings.aiReplyPii,
      createdAt: new Date().toISOString(),
    };
  }
  const { language, currency } = usePreferences.getState();
  const sessionId = input.sessionId ?? 'default-session';
  const now = input.now ?? Date.now;
  const createdAt = new Date(now()).toISOString();
  const generateId = input.generateId ?? (() => Crypto.randomUUID());
  const reply = (replyText: string): AIResponsePayload => ({ id: `ai-${input.userMessageId}`, userMessageId: input.userMessageId, replyText, createdAt });
  let state = input.sessionId ? await readConversationState(sessionId) : null;
  let updated = false;
  if (input.sessionId) {
    const proposal = detectCorrection(input.prompt, input.userMessageId, state, { language, currency });
    if (proposal && state) {
      const result = await commitCorrection(state, proposal, { now: createdAt, generateFactId: generateId });
      if (result.status === 'committed') { state = result.newState; updated = true; }
    } else if (!proposal) {
      const result = await ingestUserFacts({ sessionId, messageId: input.userMessageId, messageText: input.prompt, state, language, currency, now: createdAt, generateFactId: generateId });
      if (result.status === 'ingested') { state = result.newState; updated = true; }
    }
  }
  const scope = classifyAdviceScope(input.prompt);
  if (scope.status === 'out_of_scope') return reply(strings.aiReplyOutOfScope);
  if (scope.status === 'restricted') return reply(strings.aiReplyRestricted);
  if (!(updated && state?.activeScenario.topic === 'savings_plan')) {
    const route = await classifyLocally({ ...input, skipFactual: true });
    if (route.localReply) return route.localReply;
  }
  const clarify = async (fields: string[]) => {
    if (state) await recordPendingFields(state, fields, { now: createdAt, sourceMessageId: input.userMessageId });
    return reply(buildAdviceClarification(fields, language));
  };
  if (updated && state?.activeScenario.topic === 'savings_plan') {
    const fields = (['income', 'expenseTotal', 'goalTarget', 'savingsMonths', 'savingsForGoal'] as const).filter((field) => state!.activeScenario[field].status === 'unknown');
    if (fields.length) return clarify(fields);
  }
  const refs = await withDatabase(async (db) => ({
    categories: await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM categories WHERE is_archived = 0 ORDER BY id LIMIT 32'),
    budgets: await db.getAllAsync<{ id: string; name: string }>('SELECT b.id, c.name AS name FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.is_active = 1 ORDER BY b.id LIMIT 32'),
  }));
  let question = input.prompt;
  const policyFor = (text: string) => resolveAdviceToolPolicy({ question: text, today: today({ now: () => new Date(now()), timeZone: 'Asia/Ho_Chi_Minh' }), sessionId, scenarioId: state?.activeScenario.id ?? null, stateRevision: state?.revision ?? 0, ...refs, scenarioTopic: state?.activeScenario.topic as AdviceTopic | undefined });
  let decision = policyFor(question);
  if (updated && state?.activeScenario.topic === 'savings_plan' && decision.status !== 'allowed') {
    question = language === 'vi' ? 'Tính kế hoạch tiết kiệm giúp tôi' : 'Calculate my savings plan';
    decision = policyFor(question);
  }
  if (decision.status === 'allowed') {
    const onlySavingsGoal =
      decision.policy.grants.length === 1 &&
      decision.policy.grants[0].name === 'plan_savings_goal';
    const text = foldText(input.prompt);
    const isGeneralGoalProgressCheck =
      onlySavingsGoal &&
      (!state || state.activeScenario.topic !== 'savings_plan') &&
      /\b(?:kiem tra|xem)\s+tien do\s+muc tieu\b|\bmuc tieu\s+cua\s+toi\s+the nao\b/.test(
        text,
      ) &&
      !/\b(?:tinh|moi thang|hang thang|bao nhieu)\b/.test(text);
    if (
      isGeneralGoalProgressCheck &&
      canUseCoachTurn(input.prompt, scope, input.history)
    ) {
      return runCoachTurn({
        input,
        sessionId,
        stateRevision: state?.revision ?? 0,
        language,
        currency,
        strings,
        now,
        generateId,
        reply,
      });
    }
  }
  if (decision.status === 'needs_clarification') {
    if (
      canUseCoachTurn(input.prompt, scope, input.history, decision.fields)
    ) {
      return runCoachTurn({
        input,
        sessionId,
        stateRevision: state?.revision ?? 0,
        language,
        currency,
        strings,
        now,
        generateId,
        reply,
      });
    }
    return clarify(decision.fields);
  }
  if (decision.status === 'rejected') return reply(decision.reason === 'OUT_OF_SCOPE' ? strings.aiReplyOutOfScope : decision.reason === 'RESTRICTED' ? strings.aiReplyRestricted : strings.aiReplyAmbiguous);
  const baseUrl = input.baseUrl ?? getProxyBaseUrl();
  if (!baseUrl || (!isDevRuntime() && !baseUrl.startsWith('https://'))) return reply(strings.aiFallbackUnavailable);
  let context;
  if (state && state.revision > 0) {
    try {
      const activeIds = getScenarioFactIds(state.activeScenario);
      const ids = new Set(state.facts.filter((fact) => activeIds.has(fact.id)).map((fact) => fact.source_message_id));
      const sources = await withDatabase((db) => readChatSourceMessages(db, sessionId, [...ids]));
      const payload = buildAdviceContext(state, question, { language, currency, sourceMessages: sources });
      if (sources.length <= 8 && validateConversationStateFacts(payload.activeFacts, sources, { sessionId, scenario: payload.scenario }).valid) {
        context = AdviceValidationContextSchema.parse({ sessionId, revision: state.revision, activeScenario: payload.scenario, pendingFields: payload.pendingFields, sourceMessages: adviceContextToHistory(payload) });
      }
    } catch { /* Invalid context is never sent. */ }
  }
  const turnId = generateId();
  const transport = createAgentTurnTransport({ baseUrl, authHeaders: { 'ngrok-skip-browser-warning': 'true', ...aiAuthHeaders(await readAIAuth(sessionId)) }, fetchFn: input.fetchFn ?? await selectFetch(), turn: { version: 1, turnId, userMessageId: input.userMessageId, sessionId, scenarioId: state?.activeScenario.id ?? null, stateRevision: state?.revision ?? 0, language, currency, ...(context ? { context } : {}), ...refs }, getCurrentMetadata: async () => { const latest = await readConversationState(sessionId); return { stateRevision: latest?.revision ?? 0, scenarioId: latest?.activeScenario.id ?? null }; }, onDelta: input.onDelta });
  const result = await runAgentLoop({ turnId, sessionId, userMessageId: input.userMessageId, question, state, allowedTools: [...new Set(decision.policy.grants.map((grant) => grant.name))] }, { now, selectTools: (step, signal) => withLinkedSignal(input.signal, signal, (linked) => transport.selectTools(step, linked)), executeTool, readRevision: async (sid) => (await readConversationState(sid))?.revision ?? null, finalize: (step, signal) => withLinkedSignal(input.signal, signal, (linked) => transport.finalize(step, linked)), onTurnEnd: transport.onTurnEnd });
  if (result.status === 'completed') return applyAdviceDisclaimer({ ...reply(result.text ?? ''), incomplete: false, verification: 'passed' }, question);
  if (result.status === 'incomplete') return { ...reply(result.text), incomplete: true, verification: result.verification };
  if (result.status === 'needs_clarification') return clarify(result.fields);
  const fallback = reply(formatAgentFallbackReply(result.observations, { reason: result.reason, language, currency, ...refs }));
  return result.observations.some((observation) => observation.result.status === 'ok') ? applyAdviceDisclaimer(fallback, question) : fallback;
}

/** Keep one advice entry point and preserve direct legacy behavior while the flag is disabled. */
export function runAdvice(input: AdviceInput): Promise<AIResponsePayload> {
  return flags.useAgentLoop ? runAdviceTurn(input) : legacyAdvice(input);
}
