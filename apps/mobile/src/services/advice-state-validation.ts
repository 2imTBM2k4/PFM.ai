import {
  ConversationFactSchema,
  isDurationFact,
  isMoneyFact,
  type ConversationFact,
  type ConversationState,
  type DurationFact,
  type MoneyFact,
} from '@pfm/contracts';
import { extractAmounts } from '@pfm/domain';
import type { ChatSourceMessage } from '@/data/repository';

const moneyKinds: Readonly<Record<string, MoneyFact['kind'] | undefined>> = {
  income: 'income',
  expenseTotal: 'expense',
  debtOutstanding: 'debtOutstanding',
  goalTarget: 'saving_goal',
  monthlySavingsGoal: 'saving_goal',
  savingsForGoal: 'savingsForGoal',
  purchasePrice: 'one_off',
  monthlyPayment: 'debt',
  expenseIncludes: 'expense',
};

const durationKinds: Readonly<
  Record<string, DurationFact['kind'] | undefined>
> = {
  savingsMonths: 'savings_months',
  paymentMonths: 'payment_months',
};

const RESERVED_NEGATION =
  /\b(?:chua (?:danh rieng|de danh)|(?:khong|chua) co (?:tien )?(?:danh rieng|de danh)|no savings yet|haven't saved|haven't reserved|no money set aside)\b/;
const GENERAL_NEGATION = /\b(?:chua co gi|(?:khong|chua) co tien)\b/;
const SHORT_STANDALONE_NEGATION =
  /^(?:chua co|khong co|khong|none|nothing)[.!]?$/;
const CONTRADICTORY_NEGATION =
  /\b(?:chua (?:de danh|danh rieng) (?:du|het)|khong phai la chua)\b/;
const UNSUPPORTED_MONEY_TERMS =
  /\b(?:million|billion|trillion|eur|euros?|gbp|jpy|cny)\b|[€£¥]/;
const OTHER_FIELD_LABEL =
  /\b(?:thu nhap|luong|income|salary|tong chi|chi tieu|chi phi|expense|expenses|muc tieu|muon tiet kiem|can tiet kiem|muon du|tiet kiem du|can dat|goal|target|du no|con no|tra gop|gia mua|price)\b/;

function foldEvidenceText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Verify an explicit integer month count in source text without mistaking money or dates for months. */
export function hasDurationEvidence(
  text: string,
  months: number,
  currency: 'VND' | 'USD',
): boolean {
  if (
    !text.trim() ||
    text.length > 500 ||
    !Number.isSafeInteger(months) ||
    months < 1 ||
    months > 1200
  )
    return false;
  const folded = foldEvidenceText(text);
  const marked = extractAmounts(text, currency).filter((item) => item.marked);
  const matches = [
    ...folded.matchAll(/([1-9]\d*)\s*(?:thang|months?)\b/g),
  ];
  return matches.some((match) => {
    if (Number(match[1]) !== months || match.index === undefined) return false;
    const start = match.index;
    const end = start + match[0].length;
    const prefix = folded.slice(0, start);
    const suffix = folded.slice(end);
    if (/[a-z0-9.,]$/i.test(prefix)) return false;
    if (/(?:\b(?:am|minus|negative)\s+|[-−]\s*(?:\$\s*)?)$/.test(prefix))
      return false;
    if (/(?:\$|₫|€|£|¥|\b(?:usd|vnd|dong)\s*)$/.test(prefix)) return false;
    if (/^\s*[.,]\d/.test(suffix)) return false;
    // Reject if the matched number token overlaps a marked monetary amount in the single-clause case.
    if (
      marked.length > 0 &&
      !folded.includes(',') &&
      !folded.includes(';') &&
      marked.every((item) => item.amount.value === months)
    )
      return false;
    return true;
  });
}

function isSingleClauseNegation(
  trimmed: string,
  currency: 'VND' | 'USD',
): boolean {
  if (!trimmed || trimmed.length > 500 || /[?？]/u.test(trimmed)) return false;
  const folded = foldEvidenceText(trimmed);
  if (
    UNSUPPORTED_MONEY_TERMS.test(folded) ||
    /\b(?:am|minus|negative)\s+\d|[-−]\s*(?:\$\s*)?\d/.test(folded)
  )
    return false;
  if (
    !RESERVED_NEGATION.test(folded) &&
    !GENERAL_NEGATION.test(folded) &&
    !SHORT_STANDALONE_NEGATION.test(folded)
  )
    return false;
  if (CONTRADICTORY_NEGATION.test(folded)) return false;
  const amounts = extractAmounts(trimmed, currency);
  if (
    (/\d/.test(trimmed) && !amounts.length) ||
    amounts.some(
      ({ amount, warnings }) =>
        amount.value !== 0 ||
        amount.confidence === 'low' ||
        (amount.currency ?? currency) !== currency ||
        warnings.some((warning) => warning !== 'ZERO_AMOUNT'),
    ) ||
    amounts.length > 1 ||
    (amounts.length === 1 &&
      [...trimmed.matchAll(/\d+(?:[.,]+\d+)*/g)].some(
        (number) =>
          number.index! < amounts[0].span.start ||
          number.index! + number[0].length > amounts[0].span.end,
      ))
  )
    return false;
  return true;
}

/** Verify explicit zero/absence negation without accepting partial negation, questions or positive amounts. */
export function hasNegationEvidence(
  text: string,
  currency: 'VND' | 'USD',
): boolean {
  const trimmed = text.trim();
  if (!trimmed || text.length > 500 || /[?？]/u.test(trimmed)) return false;
  if (isSingleClauseNegation(trimmed, currency)) return true;
  const folded = foldEvidenceText(trimmed);
  if (
    UNSUPPORTED_MONEY_TERMS.test(folded) ||
    CONTRADICTORY_NEGATION.test(folded) ||
    !RESERVED_NEGATION.test(folded)
  )
    return false;
  const clauses = trimmed
    .split(/[,;\n]+|\.(?!\d)|\s+\b(?:và|va|nhưng|nhung|còn|con|and|but)\b\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (clauses.length <= 1) return false;
  const negationClauses = clauses.filter((clause) =>
    RESERVED_NEGATION.test(foldEvidenceText(clause)),
  );
  if (
    !negationClauses.length ||
    !negationClauses.every((clause) => isSingleClauseNegation(clause, currency))
  )
    return false;
  return clauses
    .filter((clause) => !negationClauses.includes(clause))
    .every((clause) => {
      const foldedClause = foldEvidenceText(clause);
      if (/\b(?:danh rieng|de danh|reserved|set aside)\b/.test(foldedClause))
        return false;
      return !/\d/.test(clause) || OTHER_FIELD_LABEL.test(foldedClause);
    });
}

/** Verify source ownership and integer source amounts before any state-derived context is transmitted. */
export function validateConversationStateFacts(
  facts: readonly ConversationFact[],
  sourceMessages: readonly ChatSourceMessage[],
  context: { sessionId: string; scenario: ConversationState['activeScenario'] },
): { valid: true } | { valid: false; reason: string } {
  const fail = (reason: string) => ({ valid: false as const, reason });
  const messages = new Map(
    sourceMessages.map((message) => [message.id, message]),
  );
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  if (messages.size !== sourceMessages.length || byId.size !== facts.length)
    return fail('duplicate_evidence');
  for (const fact of facts) {
    if (!ConversationFactSchema.safeParse(fact).success)
      return fail('fact_invalid');
    if (isMoneyFact(fact) && fact.currency !== context.scenario.currency)
      return fail('fact_currency_mismatch');
    if (fact.mode !== context.scenario.mode) return fail('fact_mode_mismatch');
    const source = messages.get(fact.source_message_id);
    if (!source) return fail('source_missing');
    if (source.sessionId !== context.sessionId)
      return fail('source_session_mismatch');
    if (isDurationFact(fact)) {
      if (
        !hasDurationEvidence(
          source.text,
          fact.months,
          context.scenario.currency,
        )
      )
        return fail('fact_duration_unverified');
    } else {
      const negationAllowed =
        fact.amount === 0 &&
        (fact.kind === 'savingsForGoal'
          ? hasNegationEvidence(source.text, fact.currency)
          : isSingleClauseNegation(source.text.trim(), fact.currency));
      const matched =
        extractAmounts(source.text, fact.currency).some(
          ({ amount, warnings }) =>
            amount.confidence !== 'low' &&
            (amount.currency ?? fact.currency) === fact.currency &&
            warnings.every((warning) => warning === 'ZERO_AMOUNT') &&
            (amount.value === fact.amount ||
              (fact.amount === 0 && warnings.includes('ZERO_AMOUNT'))),
        ) || negationAllowed;
      if (!matched) return fail('fact_amount_unverified');
    }
  }
  const replaced = new Set(facts.map((fact) => fact.supersedes_id));
  for (const [key, slot] of Object.entries(context.scenario)) {
    if (
      typeof slot !== 'object' ||
      slot === null ||
      !('status' in slot) ||
      slot.status !== 'known'
    )
      continue;
    if (!slot.factIds.length) return fail('slot_source_missing');
    if (new Set(slot.factIds).size !== slot.factIds.length)
      return fail('duplicate_slot_facts');
    const referenced: ConversationFact[] = [];
    const expectedKind = moneyKinds[key] ?? durationKinds[key];
    for (const id of slot.factIds) {
      const fact = byId.get(id);
      if (!fact || replaced.has(id)) return fail('slot_fact_missing');
      if (expectedKind && fact.kind !== expectedKind)
        return fail('slot_kind_mismatch');
      if (!slot.sourceMessageIds.includes(fact.source_message_id))
        return fail('slot_source_mismatch');
      referenced.push(fact);
    }
    if (typeof slot.value === 'number' && moneyKinds[key]) {
      const total = referenced.reduce(
        (sum, fact) => sum + (isMoneyFact(fact) ? fact.amount : 0),
        0,
      );
      if (!Number.isSafeInteger(total) || total !== slot.value)
        return fail('slot_amount_mismatch');
    }
    if (typeof slot.value === 'number' && durationKinds[key]) {
      if (
        referenced.length !== 1 ||
        !isDurationFact(referenced[0]) ||
        referenced[0].months !== slot.value
      )
        return fail('slot_duration_mismatch');
    }
    if (
      key === 'cashFlowBasis' &&
      referenced.some(
        (fact) =>
          isMoneyFact(fact) &&
          ['income', 'expense', 'debt'].includes(fact.kind) &&
          fact.period !== 'monthly',
      )
    )
      return fail('slot_period_mismatch');
    if (key === 'expenseIncludes' && Array.isArray(slot.value)) {
      const includes = new Set(
        referenced.flatMap((fact) =>
          isMoneyFact(fact) ? (fact.includes ?? []) : [],
        ),
      );
      if (
        slot.value.length !== includes.size ||
        slot.value.some((item) => !includes.has(item))
      )
        return fail('slot_includes_mismatch');
    }
  }
  for (const item of [
    ...context.scenario.expenseItems,
    ...context.scenario.debtMonthlyPayments,
  ]) {
    if (
      replaced.has(item.id) ||
      JSON.stringify(byId.get(item.id)) !== JSON.stringify(item)
    )
      return fail('scenario_item_mismatch');
  }
  return { valid: true };
}
