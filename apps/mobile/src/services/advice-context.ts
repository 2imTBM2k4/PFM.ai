import {
  ConversationStateSchema,
  isMoneyFact,
  type ConversationState,
  type ConversationFact,
  type AdviceHistoryItem,
} from '@pfm/contracts';
import { classifyAdviceScope } from '@pfm/domain';
import type { ChatSourceMessage } from '@/data/repository';

export interface AdviceContextPayload {
  scenario: ConversationState['activeScenario'];
  activeFacts: ConversationFact[];
  pendingFields: string[];
  sourceEvidence: { id: string; text: string }[];
  revision: number;
  sessionId: string;
  isIncomplete: boolean;
  wasTrimmed: boolean;
}

/** Identify scenario membership through explicit references, never through kind alone. */
export function getScenarioFactIds(
  scenario: ConversationState['activeScenario'],
): Set<string> {
  const ids = new Set<string>();
  for (const value of Object.values(scenario)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      'status' in value &&
      value.status === 'known'
    ) {
      for (const id of value.factIds) ids.add(id);
    }
  }
  for (const fact of [
    ...scenario.expenseItems,
    ...scenario.debtMonthlyPayments,
  ])
    ids.add(fact.id);
  return ids;
}

/** Build a bounded client context from already stored facts and their original SQLite evidence. */
export function buildAdviceContext(
  input: ConversationState,
  currentMessage: string,
  options: {
    language: 'vi' | 'en';
    currency: 'VND' | 'USD';
    sourceMessages: readonly ChatSourceMessage[];
  },
): AdviceContextPayload {
  const state = ConversationStateSchema.parse(input);
  if (!currentMessage.trim() || currentMessage.length > 500)
    throw new Error('ADVICE_CONTEXT_QUESTION_INVALID');
  if (state.activeScenario.currency !== options.currency)
    throw new Error('ADVICE_CONTEXT_CURRENCY_MISMATCH');
  const currentScope = classifyAdviceScope(currentMessage);
  if (
    currentScope.status === 'allowed' &&
    currentScope.topic &&
    currentScope.topic !== 'general' &&
    state.activeScenario.topic !== 'general' &&
    currentScope.topic !== state.activeScenario.topic
  ) {
    throw new Error('ADVICE_CONTEXT_TOPIC_MISMATCH');
  }
  const referenced = getScenarioFactIds(state.activeScenario);
  const replaced = new Set(state.facts.map((fact) => fact.supersedes_id));
  const eligible = state.facts.filter(
    (fact) =>
      referenced.has(fact.id) &&
      !replaced.has(fact.id) &&
      fact.mode === state.activeScenario.mode &&
      (!isMoneyFact(fact) || fact.currency === options.currency),
  );
  // Stored facts are append-ordered: prefer the newest 32; the legacy adapter rejects lost references.
  const activeFacts = eligible.slice(-32).reverse();
  const selected = new Set(activeFacts.map(({ id }) => id));
  const wasTrimmed =
    eligible.length > 32 || [...referenced].some((id) => !selected.has(id));
  const sources = new Set(activeFacts.map((fact) => fact.source_message_id));
  const sourceEvidence = options.sourceMessages
    .filter(
      (message) =>
        sources.has(message.id) && message.sessionId === state.sessionId,
    )
    .slice()
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    // Keep original selected messages: cutting clauses can erase negation, periods or goal horizons.
    .map(({ id, text }) => ({ id, text: text.trim() }));
  return {
    scenario: {
      ...state.activeScenario,
      expenseItems: state.activeScenario.expenseItems.filter(({ id }) =>
        selected.has(id),
      ),
      debtMonthlyPayments: state.activeScenario.debtMonthlyPayments.filter(
        ({ id }) => selected.has(id),
      ),
    },
    activeFacts,
    pendingFields: [...state.pendingFields],
    sourceEvidence,
    revision: state.revision,
    sessionId: state.sessionId,
    isIncomplete:
      state.pendingFields.length > 0 || !activeFacts.length || wasTrimmed,
    wasTrimmed,
  };
}

/** Bridge only original user evidence to the unchanged history protocol until phase 2.3. */
export function adviceContextToHistory(
  context: AdviceContextPayload,
): AdviceHistoryItem[] {
  if (context.wasTrimmed) throw new Error('ADVICE_CONTEXT_TRIMMED');
  const ids = new Set(context.sourceEvidence.map(({ id }) => id));
  if (context.activeFacts.some((fact) => !ids.has(fact.source_message_id)))
    throw new Error('ADVICE_CONTEXT_SOURCE_MISSING');
  if (
    ids.size !== context.sourceEvidence.length ||
    ids.size > 8 ||
    context.sourceEvidence.some(({ text }) => !text || text.length > 500)
  )
    throw new Error('ADVICE_CONTEXT_WIRE_LIMIT');
  return context.sourceEvidence.map(({ id, text }) => ({
    id,
    role: 'user',
    text,
  }));
}

/** Initialize unknown slots only; extraction and correction belong to phase 2.2b. */
export function createInitialAdviceState(
  sessionId: string,
  question: string,
  options: { language: 'vi' | 'en'; currency: 'VND' | 'USD' },
): ConversationState {
  const unknown = { status: 'unknown' as const };
  const topic = classifyAdviceScope(question).topic ?? 'general';
  return ConversationStateSchema.parse({
    version: 1,
    sessionId,
    revision: 0,
    activeScenario: {
      id: `scenario-${sessionId}`,
      topic,
      mode: 'actual',
      currency: options.currency,
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
    facts: [],
    pendingFields:
      topic === 'savings_plan'
        ? [
            'cashFlowBasis',
            'income',
            'expenseTotal',
            'goalTarget',
            'savingsForGoal',
            'savingsMonths',
          ]
        : ['scenario'],
    updatedAt: new Date().toISOString(),
  });
}
