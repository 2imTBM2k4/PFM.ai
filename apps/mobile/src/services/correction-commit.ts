import {
  ConversationStateSchema,
  CorrectionProposalSchema,
  isDurationFact,
  isMoneyFact,
  type ConversationState,
  type CorrectionProposal,
  type DurationFact,
  type MoneyFact,
} from '@pfm/contracts';
import { writeConversationState } from '@/data/conversation-state';
import {
  hasDurationEvidence,
  hasNegationEvidence,
} from './advice-state-validation';

type Rejection =
  | 'ambiguous'
  | 'target_unknown'
  | 'conflict'
  | 'validation_failed';

const MONEY_FACTS: Partial<
  Record<
    CorrectionProposal['targetField'],
    { kind: MoneyFact['kind']; period: MoneyFact['period'] }
  >
> = {
  income: { kind: 'income', period: 'monthly' },
  expenseTotal: { kind: 'expense', period: 'monthly' },
  goalTarget: { kind: 'saving_goal', period: 'one_off' },
  savingsForGoal: { kind: 'savingsForGoal', period: 'one_off' },
  debtOutstanding: { kind: 'debtOutstanding', period: 'one_off' },
  monthlyPayment: { kind: 'debt', period: 'monthly' },
};

const DURATION_FACTS: Partial<
  Record<CorrectionProposal['targetField'], DurationFact['kind']>
> = {
  savingsMonths: 'savings_months',
  paymentMonths: 'payment_months',
};

/** Persist one explicit monetary, duration, or negation correction atomically; never retry a stale revision or mutate the caller's state. */
export async function commitCorrection(
  state: ConversationState,
  proposal: CorrectionProposal,
  options: { now: string; generateFactId: () => string },
): Promise<
  | { status: 'committed'; newState: ConversationState; newFactId: string }
  | { status: 'rejected'; reason: Rejection }
> {
  const reject = (reason: Rejection) => ({
    status: 'rejected' as const,
    reason,
  });
  if (proposal.ambiguous) return reject('ambiguous');
  if (!CorrectionProposalSchema.safeParse(proposal).success)
    return reject('validation_failed');

  const durationKind = DURATION_FACTS[proposal.targetField];
  const moneyMapping = MONEY_FACTS[proposal.targetField];
  if (!durationKind && !moneyMapping) return reject('validation_failed');

  if (durationKind) {
    if (
      proposal.reason === 'negation' ||
      proposal.proposedValue < 1 ||
      proposal.proposedValue > 1200
    )
      return reject('validation_failed');
  } else if (proposal.reason === 'negation') {
    if (
      proposal.proposedValue !== 0 ||
      !hasNegationEvidence(
        proposal.evidence.text,
        state.activeScenario.currency,
      )
    )
      return reject('validation_failed');
  }

  const slot = state.activeScenario[proposal.targetField];
  if (slot.status === 'unknown') return reject('target_unknown');
  if (slot.factIds.length !== 1) {
    console.warn('CORRECTION_SLOT_CONFLICT');
    return reject('conflict');
  }
  const parsedState = ConversationStateSchema.safeParse(state);
  if (!parsedState.success) return reject('validation_failed');
  const oldId = slot.factIds[0];
  const previous = parsedState.data.facts.find(({ id }) => id === oldId);
  if (!previous || previous.mode !== state.activeScenario.mode)
    return reject('validation_failed');

  const next = parsedState.data;
  const newId = options.generateFactId();

  if (durationKind) {
    if (
      !isDurationFact(previous) ||
      previous.kind !== durationKind ||
      !hasDurationEvidence(
        proposal.evidence.text,
        proposal.proposedValue,
        state.activeScenario.currency,
      )
    )
      return reject('validation_failed');
    const newFact: DurationFact = {
      id: newId,
      kind: previous.kind,
      months: proposal.proposedValue,
      source_message_id: proposal.evidence.sourceMessageId,
      source: 'user_statement',
      mode: previous.mode,
      supersedes_id: oldId,
    };
    next.facts.push(newFact);
  } else {
    if (
      !moneyMapping ||
      !isMoneyFact(previous) ||
      previous.kind !== moneyMapping.kind ||
      previous.period !== moneyMapping.period ||
      previous.currency !== state.activeScenario.currency
    )
      return reject('validation_failed');
    const newFact: MoneyFact = {
      ...previous,
      id: newId,
      amount: proposal.proposedValue,
      source_message_id: proposal.evidence.sourceMessageId,
      source: 'user_statement',
      supersedes_id: oldId,
    };
    next.facts.push(newFact);
  }

  for (const [key, value] of Object.entries(next.activeScenario)) {
    if (key === proposal.targetField) continue;
    if (Array.isArray(value)) {
      if (
        value.some(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            'id' in item &&
            item.id === oldId,
        )
      )
        return reject('conflict');
    } else if (
      typeof value === 'object' &&
      value !== null &&
      'status' in value &&
      value.status === 'known' &&
      value.factIds.includes(oldId)
    ) {
      if (
        durationKind ||
        (key !== 'cashFlowBasis' && key !== 'expenseIncludes')
      )
        return reject('conflict');
      if (
        key === 'cashFlowBasis' &&
        (!isMoneyFact(previous) || previous.period !== 'monthly')
      )
        return reject('conflict');
      value.factIds = value.factIds.map((id) => (id === oldId ? newId : id));
      value.sourceMessageIds = [
        ...new Set(
          value.factIds.map(
            (id) =>
              next.facts.find((fact) => fact.id === id)!.source_message_id,
          ),
        ),
      ];
    }
  }
  next.activeScenario[proposal.targetField] = {
    status: 'known',
    value: proposal.proposedValue,
    factIds: [newId],
    sourceMessageIds: [proposal.evidence.sourceMessageId],
    source: 'user_statement',
  };
  next.updatedAt = options.now;
  const validated = ConversationStateSchema.safeParse(next);
  if (!validated.success) return reject('validation_failed');
  try {
    const newState = await writeConversationState(validated.data, {
      sourceMessageId: proposal.evidence.sourceMessageId,
    });
    return { status: 'committed', newState, newFactId: newId };
  } catch (error) {
    return reject(
      error instanceof Error && error.message === 'CONVERSATION_STATE_CONFLICT'
        ? 'conflict'
        : 'validation_failed',
    );
  }
}
