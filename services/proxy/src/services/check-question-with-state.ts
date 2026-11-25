import {
  AdviceValidationContextSchema,
  type AdviceValidationContext,
} from '@pfm/contracts';
import {
  classifyAdviceScope,
  extractAmounts,
  type AdviceTopic,
} from '@pfm/domain';
import { scanPii } from './pii-scanner';

export type CheckQuestionResult =
  | {
      status: 'allowed';
      topic: string;
      reason: 'direct_match' | 'context_inherited' | 'pending_answer';
    }
  | {
      status: 'ambiguous';
      reason:
        'MULTIPLE_TOPICS' | 'INSUFFICIENT_CONTEXT' | 'AMBIGUOUS_CORRECTION';
    }
  | {
      status: 'rejected';
      reason: 'PII' | 'OUT_OF_SCOPE' | 'RESTRICTED' | 'INVALID_CONTEXT';
    };

const topicPhrases: Record<AdviceTopic, Record<'vi' | 'en', string>> = {
  savings_plan: { vi: 'Kế hoạch tiết kiệm', en: 'savings plan' },
  spending_overview: { vi: 'Tổng quan chi tiêu', en: 'spending this month' },
  purchase_affordability: { vi: 'Có nên mua', en: 'can i afford' },
  loan_estimate: { vi: 'Tính khoản vay', en: 'loan payment' },
  budget_review: { vi: 'Ngân sách', en: 'budget' },
  general: { vi: 'Tài chính cá nhân', en: 'personal finance' },
};

/** Check the current text before using client context solely to resolve its topic. */
export async function checkQuestionWithState(
  question: string,
  context: AdviceValidationContext | null,
  options: { language: 'vi' | 'en' },
): Promise<CheckQuestionResult> {
  if (!question.trim() || question.length > 500)
    return { status: 'rejected', reason: 'INVALID_CONTEXT' };
  const parsed =
    context === null ? null : AdviceValidationContextSchema.safeParse(context);
  if (parsed && !parsed.success)
    return { status: 'rejected', reason: 'INVALID_CONTEXT' };

  if (scanPii(question).hasPii) return { status: 'rejected', reason: 'PII' };
  const scope = classifyAdviceScope(question);
  if (scope.status === 'out_of_scope')
    return { status: 'rejected', reason: 'OUT_OF_SCOPE' };
  if (scope.status === 'restricted')
    return { status: 'rejected', reason: 'RESTRICTED' };
  if (scope.status === 'allowed' && scope.topic)
    return { status: 'allowed', topic: scope.topic, reason: 'direct_match' };
  if (scope.reason === 'MULTIPLE_TOPICS')
    return { status: 'ambiguous', reason: 'MULTIPLE_TOPICS' };
  if (!parsed || !parsed.success)
    return { status: 'ambiguous', reason: 'INSUFFICIENT_CONTEXT' };

  const { activeScenario, pendingFields } = parsed.data;
  const topic = activeScenario.topic;
  if (!Object.hasOwn(topicPhrases, topic))
    return { status: 'ambiguous', reason: 'AMBIGUOUS_CORRECTION' };
  const folded = question
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .trim();
  const duration = /^(\d+)\s*(?:thang|months?)?[.!]?$/.exec(folded);
  const amounts = extractAmounts(question, activeScenario.currency);
  const amount = amounts.length === 1 ? amounts[0].amount : null;
  const matchesMoney =
    amount !== null &&
    amount.value !== null &&
    amount.value >= 0 &&
    (amount.confidence === 'high' || amount.confidence === 'medium') &&
    (amount.currency ?? activeScenario.currency) === activeScenario.currency;
  if (
    (pendingFields.includes('savingsMonths') &&
      duration &&
      Number.isSafeInteger(Number(duration[1])) &&
      Number(duration[1]) > 0) ||
    (pendingFields.some((field) =>
      ['income', 'expenseTotal', 'savingsForGoal'].includes(field),
    ) &&
      matchesMoney)
  )
    return { status: 'allowed', topic, reason: 'pending_answer' };

  // Topic prefixes must never turn arbitrary text or an unprompted bare number into advice.
  const isFollowUp = /^(?:the con|con neu|what about|what if)\b\s+\S/.test(
    folded,
  );
  if (isFollowUp) {
    const inherited = classifyAdviceScope(
      `${topicPhrases[topic as AdviceTopic][options.language]} ${question}`,
    );
    if (inherited.status === 'allowed' && inherited.topic === topic)
      return { status: 'allowed', topic, reason: 'context_inherited' };
  }
  return { status: 'ambiguous', reason: 'AMBIGUOUS_CORRECTION' };
}
