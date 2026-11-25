import { expect, it } from 'vitest';
import { isDurationFact, isMoneyFact } from '@pfm/contracts';
import {
  hasDurationEvidence,
  hasNegationEvidence,
  validateConversationStateFacts,
} from './advice-state-validation';
import { adviceStateFixture } from './advice-context.fixtures';

it('validates high/medium confidence source amounts, duration facts, and explicit zero against referenced slots', () => {
  const { state, sourceMessages } = adviceStateFixture();
  expect(
    validateConversationStateFacts(state.facts, sourceMessages, {
      sessionId: state.sessionId,
      scenario: state.activeScenario,
    }),
  ).toEqual({ valid: true });
});

it.each([
  ['deleted source', 'source_missing', 'missing'],
  ['wrong session', 'source_session_mismatch', 'session'],
  ['wrong amount', 'fact_amount_unverified', 'amount'],
  ['low confidence lít', 'fact_amount_unverified', 'low'],
  ['slot amount mismatch', 'slot_amount_mismatch', 'slot'],
  ['wrong currency', 'fact_currency_mismatch', 'currency'],
] as const)('rejects %s with a bounded reason', (_case, reason, mutation) => {
  const { state, sourceMessages } = adviceStateFixture();
  if (mutation === 'missing') sourceMessages.shift();
  if (mutation === 'session') sourceMessages[0].sessionId = 'other-session';
  if (mutation === 'amount') sourceMessages[0].text = 'Thu nhập 12 triệu/tháng';
  if (mutation === 'low') {
    if (isMoneyFact(state.facts[0])) state.facts[0].amount = 200_000;
    state.activeScenario.income = {
      ...state.activeScenario.income,
      status: 'known',
      value: 200_000,
    } as typeof state.activeScenario.income;
    sourceMessages[0].text = 'Thu nhập 2 lít mỗi tháng';
  }
  if (mutation === 'slot' && state.activeScenario.income.status === 'known')
    state.activeScenario.income.value = 12_000_000;
  if (mutation === 'currency' && isMoneyFact(state.facts[0]))
    state.facts[0].currency = 'USD';
  expect(
    validateConversationStateFacts(state.facts, sourceMessages, {
      sessionId: state.sessionId,
      scenario: state.activeScenario,
    }),
  ).toEqual({ valid: false, reason });
});

it('checks USD cents against the original currency, without exchange-rate conversion', () => {
  const { state, sourceMessages } = adviceStateFixture();
  if (!isMoneyFact(state.facts[0])) throw Error('Expected MoneyFact');
  const fact = { ...state.facts[0], amount: 125, currency: 'USD' as const };
  const scenario = {
    ...state.activeScenario,
    currency: 'USD' as const,
    income: {
      status: 'known' as const,
      value: 125,
      factIds: [fact.id],
      sourceMessageIds: ['m1'],
      source: 'user_statement' as const,
    },
  };
  for (const key of [
    'cashFlowBasis',
    'expenseTotal',
    'expenseIncludes',
    'goalTarget',
    'savingsForGoal',
    'savingsMonths',
  ] as const)
    scenario[key] = { status: 'unknown' };
  sourceMessages[0].text = 'Income $1.25 monthly';
  expect(
    validateConversationStateFacts([fact], sourceMessages, {
      sessionId: state.sessionId,
      scenario,
    }),
  ).toEqual({ valid: true });
});

it('rejects a mismatched slot kind and duplicate references instead of double-counting', () => {
  const { state, sourceMessages } = adviceStateFixture();
  if (!isMoneyFact(state.facts[0])) throw Error('Expected MoneyFact');
  state.facts[0].kind = 'expense';
  expect(
    validateConversationStateFacts(state.facts, sourceMessages, {
      sessionId: state.sessionId,
      scenario: state.activeScenario,
    }),
  ).toEqual({ valid: false, reason: 'slot_kind_mismatch' });
  state.facts[0].kind = 'income';
  if (state.activeScenario.income.status === 'known') {
    state.activeScenario.income.factIds.push('income');
    state.activeScenario.income.value = 30_000_000;
  }
  expect(
    validateConversationStateFacts(state.facts, sourceMessages, {
      sessionId: state.sessionId,
      scenario: state.activeScenario,
    }),
  ).toEqual({ valid: false, reason: 'duplicate_slot_facts' });
});

it('validates DurationFact month evidence and rejects monetary numbers or mismatched slot durations', () => {
  const { state, sourceMessages } = adviceStateFixture();
  sourceMessages[2].text = 'Mục tiêu 24 triệu trong 6 tháng.';
  expect(
    validateConversationStateFacts(state.facts, sourceMessages, {
      sessionId: state.sessionId,
      scenario: state.activeScenario,
    }),
  ).toEqual({ valid: true });

  // Money number "6 triệu" without a month unit must not verify months: 6
  const moneyOnly = adviceStateFixture();
  moneyOnly.state.activeScenario.goalTarget = { status: 'unknown' };
  moneyOnly.state.facts = moneyOnly.state.facts.filter((f) => f.id !== 'goal');
  moneyOnly.sourceMessages[2].text = 'Mục tiêu 6 triệu.';
  expect(
    validateConversationStateFacts(
      moneyOnly.state.facts,
      moneyOnly.sourceMessages,
      {
        sessionId: moneyOnly.state.sessionId,
        scenario: moneyOnly.state.activeScenario,
      },
    ),
  ).toEqual({ valid: false, reason: 'fact_duration_unverified' });
  expect(hasDurationEvidence('Mục tiêu 6 triệu.', 6, 'VND')).toBe(false);
  expect(hasDurationEvidence('Mục tiêu -6 tháng.', 6, 'VND')).toBe(false);
  expect(hasDurationEvidence('6 tháng', 6, 'VND')).toBe(true);
  expect(hasDurationEvidence('6tháng', 6, 'VND')).toBe(true);
  expect(hasDurationEvidence('Mục tiêu 24 triệu trong 6 tháng.', 6, 'VND')).toBe(
    true,
  );
  expect(
    hasDurationEvidence(
      'Từ 2026-11, mục tiêu 24 triệu trong 6 tháng.',
      6,
      'VND',
    ),
  ).toBe(true);

  // Slot value !== fact.months -> slot_duration_mismatch
  const slotMismatch = adviceStateFixture();
  if (slotMismatch.state.activeScenario.savingsMonths.status === 'known') {
    slotMismatch.state.activeScenario.savingsMonths.value = 12;
  }
  expect(
    validateConversationStateFacts(
      slotMismatch.state.facts,
      slotMismatch.sourceMessages,
      {
        sessionId: slotMismatch.state.sessionId,
        scenario: slotMismatch.state.activeScenario,
      },
    ),
  ).toEqual({ valid: false, reason: 'slot_duration_mismatch' });

  // Multiple duration facts in one duration slot -> slot_duration_mismatch
  const multiDuration = adviceStateFixture();
  const monthsFact = multiDuration.state.facts.find(isDurationFact)!;
  multiDuration.state.facts.push({ ...monthsFact, id: 'months-extra' });
  if (multiDuration.state.activeScenario.savingsMonths.status === 'known') {
    multiDuration.state.activeScenario.savingsMonths.factIds.push(
      'months-extra',
    );
  }
  expect(
    validateConversationStateFacts(
      multiDuration.state.facts,
      multiDuration.sourceMessages,
      {
        sessionId: multiDuration.state.sessionId,
        scenario: multiDuration.state.activeScenario,
      },
    ),
  ).toEqual({ valid: false, reason: 'slot_duration_mismatch' });
});

it('accepts verified negation evidence for zero MoneyFact and rejects partial, contradictory, or unverified zero claims', () => {
  for (const validNegation of [
    'Tôi chưa có tiền dành riêng',
    'Chưa để dành',
    'Tôi chưa dành riêng đồng nào.',
    'No savings yet',
    'Chưa có',
    'Không có',
  ]) {
    const { state, sourceMessages } = adviceStateFixture();
    sourceMessages[3].text = validNegation;
    expect(hasNegationEvidence(validNegation, 'VND')).toBe(true);
    expect(
      validateConversationStateFacts(state.facts, sourceMessages, {
        sessionId: state.sessionId,
        scenario: state.activeScenario,
      }),
    ).toEqual({ valid: true });
  }

  for (const invalidZero of [
    'Chưa để dành đủ',
    'Chưa dành riêng hết',
    'Không phải là chưa để dành',
    'Chưa để dành, hiện có 2 triệu',
    'Chưa có, hiện có 2 triệu',
    'Chưa để dành?',
    'Chưa có?',
    'Thu nhập 15 triệu',
  ]) {
    const { state, sourceMessages } = adviceStateFixture();
    sourceMessages[3].text = invalidZero;
    expect(hasNegationEvidence(invalidZero, 'VND')).toBe(false);
    expect(
      validateConversationStateFacts(state.facts, sourceMessages, {
        sessionId: state.sessionId,
        scenario: state.activeScenario,
      }),
    ).toEqual({ valid: false, reason: 'fact_amount_unverified' });
  }
});
