import {
  ConversationStateSchema,
  isDurationFact,
  isMoneyFact,
  minorToScenario,
  scenarioAmountToMinor,
  type ConversationFact,
  type ConversationState,
  type DurationFact,
  type MoneyFact,
} from '@pfm/contracts';
import { extractAmounts } from '@pfm/domain';
import { writeConversationState } from '@/data/conversation-state';
import { createInitialAdviceState } from './advice-context';
import {
  hasDurationEvidence,
  hasNegationEvidence,
} from './advice-state-validation';
import { detectCorrection } from './correction-detection';

export type IngestableField =
  | 'income'
  | 'expenseTotal'
  | 'goalTarget'
  | 'savingsForGoal'
  | 'savingsMonths'
  | 'debtOutstanding'
  | 'monthlyPayment'
  | 'paymentMonths'
  | 'purchasePrice';

export interface IngestFactsInput {
  sessionId: string;
  messageId: string;
  messageText: string;
  state: ConversationState | null;
  language: 'vi' | 'en';
  currency: 'VND' | 'USD';
  now: string;
  generateFactId: () => string;
}

export type IngestFactsResult =
  | {
      status: 'ingested';
      newState: ConversationState;
      addedFields: IngestableField[];
      addedFactIds: string[];
    }
  | {
      status: 'no_change';
      reason:
        | 'correction_detected'
        | 'no_new_facts'
        | 'conflict'
        | 'validation_failed';
    };

type MoneyIngestableField = Exclude<
  IngestableField,
  'savingsMonths' | 'paymentMonths'
>;
type DurationIngestableField = 'savingsMonths' | 'paymentMonths';

const MONEY_FIELD_META: Readonly<
  Record<
    MoneyIngestableField,
    { kind: MoneyFact['kind']; period: MoneyFact['period'] }
  >
> = {
  income: { kind: 'income', period: 'monthly' },
  expenseTotal: { kind: 'expense', period: 'monthly' },
  goalTarget: { kind: 'saving_goal', period: 'one_off' },
  savingsForGoal: { kind: 'savingsForGoal', period: 'one_off' },
  debtOutstanding: { kind: 'debtOutstanding', period: 'one_off' },
  monthlyPayment: { kind: 'debt', period: 'monthly' },
  purchasePrice: { kind: 'one_off', period: 'one_off' },
};

const DURATION_FIELD_META: Readonly<
  Record<DurationIngestableField, DurationFact['kind']>
> = {
  savingsMonths: 'savings_months',
  paymentMonths: 'payment_months',
};

const MONEY_FIELD_ORDER: readonly MoneyIngestableField[] = [
  'income',
  'expenseTotal',
  'goalTarget',
  'savingsForGoal',
  'debtOutstanding',
  'monthlyPayment',
  'purchasePrice',
];

const MONEY_PATTERNS: Readonly<Record<MoneyIngestableField, RegExp>> = {
  income: /\b(?:thu nhap|luong|income|salary)\b/,
  expenseTotal:
    /\b(?:tong chi|chi tieu|chi phi|chi hang thang|chi moi thang|expense|expenses)\b/,
  goalTarget:
    /\b(?:muc tieu|muon tiet kiem|can tiet kiem|muon du|tiet kiem du|can dat|goal|target)\b/,
  savingsForGoal:
    /\b(?:danh rieng|da danh rieng|da co san|da de danh|tien danh rieng|tien de danh|savings for goal|set aside|reserved)\b/,
  debtOutstanding: /\b(?:du no|con no|tong no|debt outstanding|total debt)\b/,
  monthlyPayment:
    /\b(?:tra gop|tra no hang thang|tra no moi thang|monthly payment)\b/,
  purchasePrice: /\b(?:gia mua|muon mua\b.*\bgia|purchase price|price)\b/,
};

const RESERVED_NEGATION =
  /\b(?:chua (?:danh rieng|de danh)|(?:khong|chua) co (?:tien )?(?:danh rieng|de danh)|no savings yet|haven't saved|haven't reserved|no money set aside)\b/;
const GENERAL_NEGATION = /\b(?:chua co gi|(?:khong|chua) co tien)\b/;
const UNSUPPORTED_MONEY_TERMS =
  /\b(?:million|billion|trillion|eur|euros?|gbp|jpy|cny)\b|[€£¥]/;

function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function hasNegativeNumber(folded: string): boolean {
  return /\b(?:am|minus|negative)\s+\d|[-−]\s*(?:\$\s*)?\d/.test(folded);
}

function splitClauses(
  text: string,
  currency: 'VND' | 'USD',
): string[] {
  const primary = text
    .split(/[,;\n]+|\.(?!\d)/)
    .map((part) => part.trim())
    .filter(Boolean);
  const result: string[] = [];
  for (const part of primary) {
    const subParts = part.split(
      /\s+\b(?:và|va|nhưng|nhung|còn|con|and|but)\b\s+/i,
    );
    if (subParts.length <= 1) {
      result.push(part);
      continue;
    }
    let current = subParts[0].trim();
    for (let i = 1; i < subParts.length; i++) {
      const nextPart = subParts[i].trim();
      const foldedNext = foldText(nextPart);
      const startsNewFact =
        RESERVED_NEGATION.test(foldedNext) ||
        GENERAL_NEGATION.test(foldedNext) ||
        extractAmounts(nextPart, currency).length > 0 ||
        /\b[1-9]\d*\s*(?:thang|months?)\b/.test(foldedNext);
      if (startsNewFact) {
        if (current) result.push(current);
        current = nextPart;
      } else {
        current = `${current} và ${nextPart}`;
      }
    }
    if (current) result.push(current);
  }
  return result;
}

function extractExpenseIncludes(
  foldedClause: string,
): ('housing' | 'debt' | 'food')[] | undefined {
  if (
    !/\b(?:da\s+gom|da\s+bao\s+gom|bao\s+gom|gom|includ(?:e|es|ing))\b/.test(
      foldedClause,
    )
  )
    return undefined;
  const items: ('housing' | 'debt' | 'food')[] = [];
  if (/\b(?:tien nha|thue nha|nha o|housing|rent)\b/.test(foldedClause))
    items.push('housing');
  if (/\b(?:tra no|no|debt)\b/.test(foldedClause)) items.push('debt');
  if (/\b(?:an uong|tien an|food)\b/.test(foldedClause)) items.push('food');
  return items.length ? items : undefined;
}

function extractDurationFromClause(
  clause: string,
  fullText: string,
  currency: 'VND' | 'USD',
): { months: number; matchedLiterals: Set<string> } | null {
  const folded = foldText(clause);
  if (/[?？]/u.test(clause) || hasNegativeNumber(folded)) return null;
  const matches = [
    ...folded.matchAll(/([1-9]\d*)\s*(?:thang|months?)\b/g),
  ];
  const validMonths: number[] = [];
  const literals = new Set<string>();
  for (const match of matches) {
    const months = Number(match[1]);
    if (
      hasDurationEvidence(clause, months, currency) &&
      hasDurationEvidence(fullText, months, currency)
    ) {
      validMonths.push(months);
      literals.add(match[1]);
    }
  }
  if (validMonths.length !== 1) return null;
  return { months: validMonths[0], matchedLiterals: literals };
}

function extractSingleMoneyFromClause(
  clause: string,
  currency: 'VND' | 'USD',
  durationLiterals?: Set<string>,
): number | null {
  if (/[?？]/u.test(clause)) return null;
  const folded = foldText(clause);
  if (hasNegativeNumber(folded)) return null;
  const allAmounts = extractAmounts(clause, currency);
  const filtered = allAmounts.filter((item) => {
    if (
      durationLiterals &&
      !item.marked &&
      durationLiterals.has((item.amount.matchedText ?? '').trim())
    ) {
      const after = clause.slice(item.span.end);
      if (/^\s*(?:tháng|thang|months?)\b/iu.test(after)) return false;
    }
    return true;
  });
  if (filtered.length !== 1) return null;
  const { amount, warnings, span } = filtered[0];
  // Reject stray numbers outside the parsed money span and any duration literal.
  for (const numMatch of clause.matchAll(/\d+(?:[.,]+\d+)*/g)) {
    const start = numMatch.index!;
    const end = start + numMatch[0].length;
    if (start >= span.start && end <= span.end) continue;
    const after = clause.slice(end);
    if (
      durationLiterals?.has(numMatch[0]) &&
      /^\s*(?:tháng|thang|months?)\b/iu.test(after)
    )
      continue;
    return null;
  }
  if (
    amount.value === null ||
    amount.value < 0 ||
    amount.confidence === 'low' ||
    (amount.currency ?? currency) !== currency ||
    warnings.some((warning) => warning !== 'ZERO_AMOUNT') ||
    (amount.value === 0 && !warnings.includes('ZERO_AMOUNT'))
  )
    return null;
  try {
    return scenarioAmountToMinor(
      minorToScenario(amount.value, currency),
      currency,
    )!;
  } catch {
    return null;
  }
}

/** Ingest explicit user-stated facts into unknown slots without mutating state or overwriting known slots. */
export async function ingestUserFacts(
  input: IngestFactsInput,
): Promise<IngestFactsResult> {
  const noChange = (
    reason:
      | 'correction_detected'
      | 'no_new_facts'
      | 'conflict'
      | 'validation_failed',
  ): IngestFactsResult => ({
    status: 'no_change',
    reason,
  });

  const trimmed = input.messageText.trim();
  if (!trimmed || input.messageText.length > 500)
    return noChange('no_new_facts');
  const foldedFull = foldText(trimmed);
  if (UNSUPPORTED_MONEY_TERMS.test(foldedFull))
    return noChange('no_new_facts');

  if (input.state !== null) {
    const parsedExisting = ConversationStateSchema.safeParse(input.state);
    if (
      !parsedExisting.success ||
      parsedExisting.data.sessionId !== input.sessionId
    )
      return noChange('validation_failed');
    if (
      detectCorrection(trimmed, input.messageId, parsedExisting.data, {
        language: input.language,
        currency: parsedExisting.data.activeScenario.currency,
      }) !== null
    ) {
      return noChange('correction_detected');
    }
  }

  if (hasNegativeNumber(foldedFull)) return noChange('no_new_facts');

  const draft: ConversationState =
    input.state === null
      ? createInitialAdviceState(input.sessionId, trimmed, {
          language: input.language,
          currency: input.currency,
        })
      : structuredClone(input.state);
  const currency = draft.activeScenario.currency;
  const mode = draft.activeScenario.mode;
  const pendingSet = new Set(input.state?.pendingFields ?? []);

  const addedFields: IngestableField[] = [];
  const addedFactIds: string[] = [];

  const isUnknown = (field: IngestableField): boolean =>
    draft.activeScenario[field].status === 'unknown';

  const commitMoneySlot = (
    field: MoneyIngestableField,
    amount: number,
    includes?: ('housing' | 'debt' | 'food')[],
  ) => {
    if (!isUnknown(field)) return;
    const meta = MONEY_FIELD_META[field];
    const id = input.generateFactId();
    const fact: MoneyFact = {
      id,
      source_message_id: input.messageId,
      kind: meta.kind,
      amount,
      currency,
      period: meta.period,
      ...(includes?.length ? { includes } : {}),
      source: 'user_statement',
      mode,
    };
    draft.facts.push(fact);
    draft.activeScenario[field] = {
      status: 'known',
      value: amount,
      factIds: [id],
      sourceMessageIds: [input.messageId],
      source: 'user_statement',
    };
    if (
      field === 'expenseTotal' &&
      includes?.length &&
      draft.activeScenario.expenseIncludes.status === 'unknown'
    ) {
      draft.activeScenario.expenseIncludes = {
        status: 'known',
        value: includes,
        factIds: [id],
        sourceMessageIds: [input.messageId],
        source: 'user_statement',
      };
    }
    addedFields.push(field);
    addedFactIds.push(id);
  };

  const commitDurationSlot = (
    field: DurationIngestableField,
    months: number,
  ) => {
    if (!isUnknown(field)) return;
    const kind = DURATION_FIELD_META[field];
    const id = input.generateFactId();
    const fact: DurationFact = {
      id,
      source_message_id: input.messageId,
      kind,
      months,
      source: 'user_statement',
      mode,
    };
    draft.facts.push(fact);
    draft.activeScenario[field] = {
      status: 'known',
      value: months,
      factIds: [id],
      sourceMessageIds: [input.messageId],
      source: 'user_statement',
    };
    addedFields.push(field);
    addedFactIds.push(id);
  };

  // Mode 1: Labelled / multi-clause declarations
  const clauses = splitClauses(trimmed, currency);
  for (const clause of clauses) {
    if (/[?？]/u.test(clause)) continue;
    const foldedClause = foldText(clause);
    if (hasNegativeNumber(foldedClause)) continue;

    const matchedMoneyFields = MONEY_FIELD_ORDER.filter((field) =>
      MONEY_PATTERNS[field].test(foldedClause),
    );
    const hasPaymentDurationCue =
      matchedMoneyFields.includes('monthlyPayment') ||
      /\b(?:ky han vay|so thang tra|tra gop trong|tra no trong|payment months)\b/.test(
        foldedClause,
      );
    const hasSavingsDurationCue =
      matchedMoneyFields.includes('goalTarget') ||
      /\b(?:muc tieu|tiet kiem|de danh|thoi han|trong\s*[1-9]\d*\s*(?:thang|months?)|horizon|savings months)\b/.test(
        foldedClause,
      );

    const durationInfo = extractDurationFromClause(clause, trimmed, currency);
    if (durationInfo) {
      if (hasPaymentDurationCue && !hasSavingsDurationCue) {
        commitDurationSlot('paymentMonths', durationInfo.months);
      } else if (hasSavingsDurationCue) {
        commitDurationSlot('savingsMonths', durationInfo.months);
      } else if (
        matchedMoneyFields.length === 0 &&
        pendingSet.has('savingsMonths') &&
        !pendingSet.has('paymentMonths')
      ) {
        commitDurationSlot('savingsMonths', durationInfo.months);
      } else if (
        matchedMoneyFields.length === 0 &&
        pendingSet.has('paymentMonths') &&
        !pendingSet.has('savingsMonths')
      ) {
        commitDurationSlot('paymentMonths', durationInfo.months);
      }
    }

    // Check reserved negation on this clause for savingsForGoal
    if (
      isUnknown('savingsForGoal') &&
      RESERVED_NEGATION.test(foldedClause) &&
      hasNegationEvidence(clause, currency) &&
      hasNegationEvidence(trimmed, currency)
    ) {
      commitMoneySlot('savingsForGoal', 0);
      continue;
    }

    if (matchedMoneyFields.length === 1) {
      const targetField = matchedMoneyFields[0];
      if (!isUnknown(targetField)) continue;
      const value = extractSingleMoneyFromClause(
        clause,
        currency,
        durationInfo?.matchedLiterals,
      );
      if (value === null) continue;
      const includes =
        targetField === 'expenseTotal'
          ? extractExpenseIncludes(foldedClause)
          : undefined;
      commitMoneySlot(targetField, value, includes);
    }
  }

  // Mode 2: Short answer for single pendingField when Mode 1 did not fill it
  if (
    input.state !== null &&
    input.state.pendingFields.length === 1 &&
    addedFields.length === 0
  ) {
    const pendingField = input.state.pendingFields[0] as IngestableField;
    if (
      (pendingField === 'savingsMonths' || pendingField === 'paymentMonths') &&
      isUnknown(pendingField)
    ) {
      const durationInfo = extractDurationFromClause(
        trimmed,
        trimmed,
        currency,
      );
      const allNumbers = trimmed.match(/\d+(?:[.,]+\d+)*/g) ?? [];
      if (durationInfo && allNumbers.length === 1) {
        commitDurationSlot(pendingField, durationInfo.months);
      }
    } else if (
      pendingField in MONEY_FIELD_META &&
      isUnknown(pendingField)
    ) {
      const moneyField = pendingField as MoneyIngestableField;
      if (
        moneyField === 'savingsForGoal' &&
        hasNegationEvidence(trimmed, currency)
      ) {
        commitMoneySlot('savingsForGoal', 0);
      } else if (!/\b[1-9]\d*\s*(?:thang|months?)\b/.test(foldedFull)) {
        const value = extractSingleMoneyFromClause(trimmed, currency);
        if (value !== null) {
          const includes =
            moneyField === 'expenseTotal'
              ? extractExpenseIncludes(foldedFull)
              : undefined;
          commitMoneySlot(moneyField, value, includes);
        }
      }
    }
  }

  if (addedFields.length === 0) {
    return noChange('no_new_facts');
  }

  // Bind cashFlowBasis to monthly income or expenseTotal when unknown
  if (draft.activeScenario.cashFlowBasis.status === 'unknown') {
    const basisSlot =
      draft.activeScenario.income.status === 'known'
        ? draft.activeScenario.income
        : draft.activeScenario.expenseTotal.status === 'known'
          ? draft.activeScenario.expenseTotal
          : null;
    if (basisSlot) {
      draft.activeScenario.cashFlowBasis = {
        status: 'known',
        value: 'monthly',
        factIds: [...basisSlot.factIds],
        sourceMessageIds: [...basisSlot.sourceMessageIds],
        source: 'user_statement',
      };
    }
  }

  // Remove any newly known fields (and placeholder 'scenario') from pendingFields
  draft.pendingFields = draft.pendingFields.filter((field) => {
    if (field === 'scenario') return false;
    const slot =
      draft.activeScenario[field as keyof ConversationState['activeScenario']];
    return !(
      typeof slot === 'object' &&
      slot !== null &&
      'status' in slot &&
      slot.status === 'known'
    );
  });
  draft.updatedAt = input.now;

  // Verify newly added facts against the full message text using the same rules as validateConversationStateFacts
  const addedSet = new Set(addedFactIds);
  const newFacts: ConversationFact[] = draft.facts.filter((fact) =>
    addedSet.has(fact.id),
  );
  for (const fact of newFacts) {
    if (isDurationFact(fact)) {
      if (!hasDurationEvidence(trimmed, fact.months, currency))
        return noChange('validation_failed');
    } else if (isMoneyFact(fact)) {
      const matched =
        extractAmounts(trimmed, fact.currency).some(
          ({ amount, warnings }) =>
            amount.confidence !== 'low' &&
            (amount.currency ?? fact.currency) === fact.currency &&
            warnings.every((warning) => warning === 'ZERO_AMOUNT') &&
            (amount.value === fact.amount ||
              (fact.amount === 0 && warnings.includes('ZERO_AMOUNT'))),
        ) ||
        (fact.amount === 0 && hasNegationEvidence(trimmed, fact.currency));
      if (!matched) return noChange('validation_failed');
    }
  }

  const validated = ConversationStateSchema.safeParse(draft);
  if (!validated.success) return noChange('validation_failed');

  try {
    const newState = await writeConversationState(validated.data, {
      sourceMessageId: input.messageId,
    });
    return {
      status: 'ingested',
      newState,
      addedFields,
      addedFactIds,
    };
  } catch (error) {
    return noChange(
      error instanceof Error && error.message === 'CONVERSATION_STATE_CONFLICT'
        ? 'conflict'
        : 'validation_failed',
    );
  }
}

/** Record or clear pending clarification fields atomically without mutating the caller's state. */
export async function recordPendingFields(
  state: ConversationState,
  fields: readonly string[],
  options: { now: string; sourceMessageId: string },
): Promise<
  | { status: 'updated'; newState: ConversationState }
  | { status: 'rejected'; reason: 'conflict' | 'validation_failed' }
> {
  const reject = (reason: 'conflict' | 'validation_failed') => ({
    status: 'rejected' as const,
    reason,
  });
  const parsed = ConversationStateSchema.safeParse(state);
  if (
    !parsed.success ||
    !options.sourceMessageId.trim() ||
    fields.some(
      (field) =>
        typeof field !== 'string' ||
        field.trim().length < 1 ||
        field.trim().length > 120,
    )
  )
    return reject('validation_failed');

  const nextFields = [
    ...new Set(fields.map((field) => field.trim()).filter(Boolean)),
  ].filter((field) => {
    const slot =
      parsed.data.activeScenario[
        field as keyof ConversationState['activeScenario']
      ];
    return !(
      typeof slot === 'object' &&
      slot !== null &&
      'status' in slot &&
      slot.status === 'known'
    );
  });

  const validated = ConversationStateSchema.safeParse({
    ...parsed.data,
    pendingFields: nextFields,
    updatedAt: options.now,
  });
  if (!validated.success) return reject('validation_failed');

  try {
    const newState = await writeConversationState(validated.data, {
      sourceMessageId: options.sourceMessageId,
    });
    return { status: 'updated', newState };
  } catch (error) {
    return reject(
      error instanceof Error && error.message === 'CONVERSATION_STATE_CONFLICT'
        ? 'conflict'
        : 'validation_failed',
    );
  }
}
