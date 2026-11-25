import {
  ConversationStateSchema,
  CorrectionProposalSchema,
  minorToScenario,
  scenarioAmountToMinor,
  type ConversationState,
  type CorrectionProposal,
} from '@pfm/contracts';
import { extractAmounts } from '@pfm/domain';

type Field = CorrectionProposal['targetField'];
const FIELDS: readonly Field[] = [
  'income',
  'expenseTotal',
  'goalTarget',
  'savingsForGoal',
  'savingsMonths',
  'debtOutstanding',
  'monthlySavingsGoal',
  'monthlyPayment',
  'purchasePrice',
  'paymentMonths',
];
const DURATION_FIELDS: readonly Field[] = ['savingsMonths', 'paymentMonths'];

// Keep vocabulary separate from the decision rules so additions remain reviewable.
const CORRECTION_SIGNALS = [
  'thuc ra',
  'that ra',
  'hoa ra',
  'khong phai',
  'sua lai',
  'sua thanh',
  'dieu chinh',
  'nham',
  'a nham',
  'quen',
  'dinh chinh',
  'a ma',
  'ma thoi',
  'dung ra la',
  'le ra',
  'actually',
  'correction',
  'i mean',
  'wait',
  'sorry',
  'oops',
];
const SIGNAL_PATTERN = new RegExp(`\\b(?:${CORRECTION_SIGNALS.join('|')})\\b`);
const FIELD_PATTERNS: Partial<Record<Field, RegExp>> = {
  income: /\b(?:thu nhap|luong|income)\b/,
  expenseTotal: /\b(?:chi tieu|tong chi|chi phi|expense)\b/,
  goalTarget: /\b(?:muc tieu|goal|can dat)\b/,
  savingsForGoal: /\b(?:danh rieng|da de danh|savings|reserved)\b/,
  savingsMonths: /\b(?:thoi han|trong bao nhieu thang|months)\b/,
  debtOutstanding: /\b(?:du no|con no|debt)\b/,
  monthlyPayment: /\b(?:tra no|tra gop|monthly payment)\b/,
};
const RESERVED_NEGATION =
  /\b(?:chua (?:danh rieng|de danh)|(?:khong|chua) co (?:danh rieng|de danh)|no savings yet|haven't saved|haven't reserved|no money set aside)\b/;
const GENERAL_NEGATION = /\b(?:chua co gi|(?:khong|chua) co tien)\b/;
const UNSUPPORTED_MONEY_TERMS =
  /\b(?:million|billion|trillion|eur|euros?|gbp|jpy|cny)\b|[€£¥]/;

/** Propose one explicit correction without mutating state, calling a model, or persisting evidence. */
export function detectCorrection(
  currentMessage: string,
  currentMessageId: string,
  state: ConversationState | null,
  context: { language: 'vi' | 'en'; currency: 'VND' | 'USD' },
): CorrectionProposal | null {
  if (
    !state ||
    currentMessage.length > 500 ||
    !ConversationStateSchema.safeParse(state).success
  )
    return null;
  const known = FIELDS.filter(
    (field) => state.activeScenario[field].status === 'known',
  );
  if (!known.length) return null;
  const text = currentMessage.trim();
  const folded = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (UNSUPPORTED_MONEY_TERMS.test(folded)) return null;
  if (
    /[?？]/u.test(text) ||
    /\b(?:am|minus|negative)\s+\d|[-−]\s*(?:\$\s*)?\d/.test(folded)
  )
    return null;
  const reservedNegation = RESERVED_NEGATION.test(folded);
  const negation = reservedNegation || GENERAL_NEGATION.test(folded);
  if (
    negation &&
    /\b(?:chua (?:de danh|danh rieng) (?:du|het)|khong phai la chua)\b/.test(
      folded,
    )
  )
    return null;
  if (!negation && !SIGNAL_PATTERN.test(folded)) return null;
  const explicitFields = FIELDS.filter(
    (field) =>
      FIELD_PATTERNS[field]?.test(folded) ||
      (reservedNegation && field === 'savingsForGoal'),
  );
  if (explicitFields.length > 1) return null;
  const candidates = explicitFields.length ? explicitFields : known;
  if (candidates.some((field) => !known.includes(field))) return null;
  if (negation && candidates.length > 1) return null;
  const factOrder = new Map(state.facts.map((fact, index) => [fact.id, index]));
  const newest = (field: Field) => {
    const slot = state.activeScenario[field];
    return slot.status === 'known'
      ? Math.max(...slot.factIds.map((id) => factOrder.get(id) ?? -1))
      : -1;
  };
  const target = [...candidates].sort((a, b) => newest(b) - newest(a))[0];
  const currency = state.activeScenario.currency ?? context.currency;
  let value: number;
  let confidence: 'high' | 'medium';
  if (negation) {
    // Positive or uncertain numbers contradict an assertion that nothing is available.
    const amounts = extractAmounts(text, currency);
    if (
      (/\d/.test(text) && !amounts.length) ||
      amounts.some(
        ({ amount, warnings }) =>
          amount.value !== 0 ||
          amount.confidence === 'low' ||
          (amount.currency ?? currency) !== currency ||
          warnings.some((warning) => warning !== 'ZERO_AMOUNT'),
      ) ||
      amounts.length > 1
    )
      return null;
    value = 0;
    confidence = 'high';
  } else if (DURATION_FIELDS.includes(target)) {
    const match = /\b([1-9]\d*)\s*(?:thang|months?)\b/.exec(folded);
    const numbers = folded.match(/\d+(?:[.,]\d+)*/g) ?? [];
    if (!match || numbers.length !== 1 || numbers[0] !== match[1]) return null;
    // A monetary amount must never become a number of months by inference.
    if (extractAmounts(text, currency).some((amount) => amount.marked))
      return null;
    value = Number(match[1]);
    confidence = 'high';
  } else {
    const amounts = extractAmounts(text, currency);
    if (amounts.length !== 1) return null;
    const { amount, warnings } = amounts[0];
    if (
      [...text.matchAll(/\d+(?:[.,]+\d+)*/g)].some(
        (number) =>
          number.index < amounts[0].span.start ||
          number.index + number[0].length > amounts[0].span.end,
      )
    )
      return null;
    if (
      amount.value === null ||
      amount.value < 0 ||
      amount.confidence === 'low' ||
      (amount.currency ?? currency) !== currency ||
      warnings.some((warning) => warning !== 'ZERO_AMOUNT')
    )
      return null;
    // extractAmounts already returns minor units, including USD cents; do not scale them twice.
    try {
      value = scenarioAmountToMinor(
        minorToScenario(amount.value, currency),
        currency,
      )!;
    } catch {
      return null;
    }
    confidence = amount.confidence;
  }
  const proposal = CorrectionProposalSchema.safeParse({
    targetField: target,
    proposedValue: value,
    evidence: {
      sourceMessageId: currentMessageId,
      text,
      extractedAmount: value,
      confidence,
    },
    reason: negation ? 'negation' : 'explicit_correction',
    ambiguous: candidates.length > 1,
    ...(candidates.length > 1 ? { candidateFields: candidates } : {}),
  });
  return proposal.success ? proposal.data : null;
}
