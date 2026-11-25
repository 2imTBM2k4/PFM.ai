import type { ConversationFact, ConversationState } from '@pfm/contracts';

/** Build verified test evidence without extracting or correcting production facts. */
export function adviceStateFixture() {
  const unknown = { status: 'unknown' as const };
  const facts: ConversationFact[] = [
    {
      id: 'income',
      source_message_id: 'm1',
      kind: 'income',
      amount: 15_000_000,
      currency: 'VND',
      period: 'monthly',
      source: 'user_statement',
      mode: 'actual',
    },
    {
      id: 'expense',
      source_message_id: 'm2',
      kind: 'expense',
      amount: 10_000_000,
      currency: 'VND',
      period: 'monthly',
      source: 'user_statement',
      mode: 'actual',
      includes: ['debt'],
    },
    {
      id: 'goal',
      source_message_id: 'm3',
      kind: 'saving_goal',
      amount: 24_000_000,
      currency: 'VND',
      period: 'one_off',
      source: 'user_statement',
      mode: 'actual',
    },
    {
      id: 'months',
      source_message_id: 'm3',
      kind: 'savings_months',
      months: 6,
      source: 'user_statement',
      mode: 'actual',
    },
    {
      id: 'saved',
      source_message_id: 'm4',
      kind: 'savingsForGoal',
      amount: 0,
      currency: 'VND',
      period: 'one_off',
      source: 'user_statement',
      mode: 'actual',
    },
  ];
  const known = <T>(value: T, fact: ConversationFact) => ({
    status: 'known' as const,
    value,
    factIds: [fact.id],
    sourceMessageIds: [fact.source_message_id],
    source: 'user_statement' as const,
  });
  const state: ConversationState = {
    version: 1,
    sessionId: 'session-1',
    revision: 1,
    activeScenario: {
      id: 'scenario-1',
      topic: 'savings_plan',
      mode: 'actual',
      currency: 'VND',
      cashFlowBasis: known('monthly' as const, facts[0]),
      observationRange: unknown,
      income: known(15_000_000, facts[0]),
      expenseTotal: known(10_000_000, facts[1]),
      expenseIncludes: known(['debt'] as 'debt'[], facts[1]),
      expenseItems: [],
      debtMonthlyPayments: [],
      debtOutstanding: unknown,
      goalTarget: known(24_000_000, facts[2]),
      monthlySavingsGoal: unknown,
      savingsForGoal: known(0, facts[4]),
      savingsMonths: known(6, facts[3]),
      purchasePrice: unknown,
      monthlyPayment: unknown,
      paymentMonths: unknown,
    },
    facts,
    pendingFields: [],
    updatedAt: '2026-11-16T00:00:00.000Z',
  };
  const texts = [
    'Thu nhập 15 triệu mỗi tháng.',
    'Tổng chi 10 triệu mỗi tháng đã gồm trả nợ.',
    'Mục tiêu tiết kiệm 24 triệu trong 6 tháng.',
    'Tiền dành riêng là 0 đồng.',
  ];
  const sourceMessages = texts.map((text, index) => ({
    id: `m${index + 1}`,
    text,
    sessionId: state.sessionId,
    createdAt: `2026-11-15T00:00:0${index}.000Z`,
  }));
  return { state, sourceMessages };
}
