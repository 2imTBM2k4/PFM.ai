import { expect, it } from 'vitest';
import {
  ConversationStateSchema,
  minorToScenario,
  scenarioAmountToMinor,
} from './conversation-state';
import { ConversationFactSchema } from './advice-flow';

function stateFixture() {
  const unknown = { status: 'unknown' as const };
  return {
    version: 1 as const,
    sessionId: 'session-1',
    revision: 0,
    activeScenario: {
      id: 'scenario-1',
      topic: 'savings',
      mode: 'actual' as const,
      currency: 'VND' as const,
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
    pendingFields: ['savingsForGoal'],
    updatedAt: '2026-11-16T00:00:00.000Z',
  };
}

const fact = {
  id: 'saved-1',
  source_message_id: 'message-1',
  kind: 'savingsForGoal',
  amount: 0,
  currency: 'VND',
  period: 'one_off',
  source: 'user_statement',
  mode: 'actual',
} as const;

const durationFact = {
  id: 'months-1',
  source_message_id: 'message-1',
  kind: 'savings_months',
  months: 6,
  source: 'user_statement',
  mode: 'actual',
} as const;

it('accepts the complete v1 state and preserves a known zero with its evidence', () => {
  const state = {
    ...stateFixture(),
    facts: [fact],
    activeScenario: {
      ...stateFixture().activeScenario,
      savingsForGoal: {
        status: 'known',
        value: 0,
        factIds: [fact.id],
        sourceMessageIds: [fact.source_message_id],
        source: 'user_statement',
      },
    },
  };
  expect(ConversationStateSchema.parse(state)).toEqual(state);
});

it.each([
  ['missing fact', 'income', ['missing']],
  ['wrong fact kind', 'expense', ['income-1']],
  ['empty fact IDs', 'income', []],
] as const)('rejects an income slot with %s', (_reason, kind, factIds) => {
  const state = stateFixture();
  expect(
    ConversationStateSchema.safeParse({
      ...state,
      facts: [
        {
          ...fact,
          id: 'income-1',
          kind,
          period: 'monthly',
          amount: 15_000_000,
        },
      ],
      activeScenario: {
        ...state.activeScenario,
        income: {
          status: 'known',
          value: 15_000_000,
          factIds,
          sourceMessageIds: ['message-1'],
          source: 'user_statement',
        },
      },
    }).success,
  ).toBe(false);
});

it('accepts an income slot backed by an active income fact', () => {
  const state = stateFixture();
  expect(
    ConversationStateSchema.safeParse({
      ...state,
      facts: [
        {
          ...fact,
          id: 'income-1',
          kind: 'income',
          period: 'monthly',
          amount: 15_000_000,
        },
      ],
      activeScenario: {
        ...state.activeScenario,
        income: {
          status: 'known',
          value: 15_000_000,
          factIds: ['income-1'],
          sourceMessageIds: ['message-1'],
          source: 'user_statement',
        },
      },
    }).success,
  ).toBe(true);
});

it.each([
  ['income', 'income', 15_000_000],
  ['expenseTotal', 'expense', 10_000_000],
  ['expenseIncludes', 'expense', ['debt']],
  ['debtOutstanding', 'debtOutstanding', 20_000_000],
  ['goalTarget', 'saving_goal', 24_000_000],
  ['monthlySavingsGoal', 'saving_goal', 4_000_000],
  ['savingsForGoal', 'savingsForGoal', 0],
  ['purchasePrice', 'one_off', 15_000_000],
  ['monthlyPayment', 'debt', 1_000_000],
] as const)('requires matching fact kind for %s', (field, kind, value) => {
  const state = stateFixture();
  const input = {
    ...state,
    facts: [{ ...fact, kind }],
    activeScenario: {
      ...state.activeScenario,
      [field]: {
        status: 'known',
        value,
        factIds: [fact.id],
        sourceMessageIds: [fact.source_message_id],
        source: 'user_statement',
      },
    },
  };
  expect(ConversationStateSchema.safeParse(input).success).toBe(true);
  expect(
    ConversationStateSchema.safeParse({
      ...input,
      facts: [{ ...fact, kind: kind === 'income' ? 'expense' : 'income' }],
    }).success,
  ).toBe(false);
});

it.each([
  ['savingsMonths', 'savings_months', 6],
  ['paymentMonths', 'payment_months', 12],
] as const)(
  'requires matching DurationFact kind for %s and rejects MoneyFact on duration slots or DurationFact on money slots',
  (field, kind, value) => {
    const state = stateFixture();
    const duration = { ...durationFact, kind, months: value };
    const valid = {
      ...state,
      facts: [duration],
      activeScenario: {
        ...state.activeScenario,
        [field]: {
          status: 'known',
          value,
          factIds: [duration.id],
          sourceMessageIds: [duration.source_message_id],
          source: 'user_statement',
        },
      },
    };
    expect(ConversationStateSchema.safeParse(valid).success).toBe(true);
    // Reject wrong duration kind
    expect(
      ConversationStateSchema.safeParse({
        ...valid,
        facts: [
          {
            ...duration,
            kind:
              kind === 'savings_months' ? 'payment_months' : 'savings_months',
          },
        ],
      }).success,
    ).toBe(false);
    // Reject MoneyFact assigned to duration slot
    expect(
      ConversationStateSchema.safeParse({
        ...valid,
        facts: [{ ...fact, id: duration.id, kind: 'saving_goal' }],
      }).success,
    ).toBe(false);
    // Reject DurationFact assigned to money slot
    expect(
      ConversationStateSchema.safeParse({
        ...state,
        facts: [duration],
        activeScenario: {
          ...state.activeScenario,
          goalTarget: {
            status: 'known',
            value: 24_000_000,
            factIds: [duration.id],
            sourceMessageIds: [duration.source_message_id],
            source: 'user_statement',
          },
        },
      }).success,
    ).toBe(false);
  },
);

it.each([
  ['cashFlowBasis', 'monthly'],
  ['observationRange', { from: '2026-11-01', to: '2026-11-30' }],
] as const)(
  'requires existing evidence even for %s without a dedicated fact kind',
  (field, value) => {
    const state = stateFixture();
    const known = {
      status: 'known',
      value,
      factIds: [fact.id],
      sourceMessageIds: [fact.source_message_id],
      source: 'app',
    };
    const input = {
      ...state,
      facts: [fact],
      activeScenario: { ...state.activeScenario, [field]: known },
    };
    expect(ConversationStateSchema.safeParse(input).success).toBe(true);
    for (const factIds of [[], ['missing']]) {
      expect(
        ConversationStateSchema.safeParse({
          ...input,
          activeScenario: {
            ...input.activeScenario,
            [field]: { ...known, factIds },
          },
        }).success,
      ).toBe(false);
    }
  },
);

it.each(['savingsForGoal', 'debtOutstanding'])(
  'extends existing facts with %s without changing legacy fields',
  (kind) => {
    expect(ConversationFactSchema.parse({ ...fact, kind }).kind).toBe(kind);
  },
);

it.each([
  { version: 2 },
  { revision: -1 },
  { revision: 0.5 },
  { updatedAt: 'invalid' },
  { sessionId: '' },
])('rejects invalid state metadata: %j', (patch) => {
  expect(
    ConversationStateSchema.safeParse({ ...stateFixture(), ...patch }).success,
  ).toBe(false);
});

it.each([
  { status: 'unknown', value: 0 },
  { status: 'known', value: 0 },
  {
    status: 'known',
    value: -1,
    factIds: [fact.id],
    sourceMessageIds: [],
    source: 'app',
  },
  {
    status: 'known',
    value: 1.25,
    factIds: [fact.id],
    sourceMessageIds: [],
    source: 'app',
  },
  {
    status: 'known',
    value: 0,
    factIds: ['missing'],
    sourceMessageIds: [],
    source: 'app',
  },
])('rejects invalid money slots: %j', (slot) => {
  const state = stateFixture();
  expect(
    ConversationStateSchema.safeParse({
      ...state,
      facts: [fact],
      activeScenario: { ...state.activeScenario, savingsForGoal: slot },
    }).success,
  ).toBe(false);
});

it('rejects a correction whose superseded fact does not exist', () => {
  expect(
    ConversationStateSchema.safeParse({
      ...stateFixture(),
      facts: [{ ...fact, supersedes_id: 'missing' }],
    }).success,
  ).toBe(false);
});

it('preserves a correction chain and rejects duplicate and branched replacements', () => {
  const corrected = {
    ...fact,
    id: 'saved-2',
    source_message_id: 'message-2',
    supersedes_id: fact.id,
    amount: 100,
  };
  expect(
    ConversationStateSchema.safeParse({
      ...stateFixture(),
      facts: [fact, corrected],
    }).success,
  ).toBe(true);
  for (const facts of [
    [fact, fact],
    [corrected, fact],
    [fact, corrected, { ...corrected, id: 'saved-3' }],
  ]) {
    expect(
      ConversationStateSchema.safeParse({ ...stateFixture(), facts }).success,
    ).toBe(false);
  }
});

it('preserves a DurationFact correction chain and rejects cross-type, mismatched or out-of-range durations', () => {
  const correctedDuration = {
    ...durationFact,
    id: 'months-2',
    source_message_id: 'message-2',
    months: 12,
    supersedes_id: durationFact.id,
  };
  expect(
    ConversationStateSchema.safeParse({
      ...stateFixture(),
      facts: [durationFact, correctedDuration],
    }).success,
  ).toBe(true);
  for (const invalidFacts of [
    [fact, { ...durationFact, id: 'months-2', supersedes_id: fact.id }],
    [durationFact, { ...fact, id: 'saved-2', supersedes_id: durationFact.id }],
    [
      durationFact,
      {
        ...correctedDuration,
        kind: 'payment_months' as const,
      },
    ],
    [
      durationFact,
      {
        ...correctedDuration,
        mode: 'hypothetical' as const,
      },
    ],
    [{ ...durationFact, months: 0 }],
    [{ ...durationFact, months: -6 }],
    [{ ...durationFact, months: 1201 }],
  ]) {
    expect(
      ConversationStateSchema.safeParse({
        ...stateFixture(),
        facts: invalidFacts,
      }).success,
    ).toBe(false);
  }
});

it.each([
  ['cashFlowBasis', 'yearly'],
  ['savingsMonths', 0],
  ['savingsMonths', 1.5],
  ['savingsMonths', 1201],
  ['paymentMonths', -1],
  ['paymentMonths', 1201],
  ['observationRange', { from: '2026-02-30', to: '2026-03-01' }],
  ['observationRange', { from: '2026-11-02', to: '2026-11-01' }],
] as const)('rejects invalid %s values: %j', (field, value) => {
  const state = stateFixture();
  expect(
    ConversationStateSchema.safeParse({
      ...state,
      facts: [fact, durationFact],
      activeScenario: {
        ...state.activeScenario,
        [field]: {
          status: 'known',
          value,
          factIds: [
            field === 'savingsMonths' || field === 'paymentMonths'
              ? durationFact.id
              : fact.id,
          ],
          sourceMessageIds: [],
          source: 'app',
        },
      },
    }).success,
  ).toBe(false);
});

it('stores USD cents, a real date range and a positive goal duration without conversion', () => {
  const state = stateFixture();
  const known = <T>(value: T, factId = 'income-usd') => ({
    status: 'known',
    value,
    factIds: [factId],
    sourceMessageIds: [],
    source: 'app',
  });
  const result = ConversationStateSchema.parse({
    ...state,
    facts: [
      {
        ...fact,
        id: 'income-usd',
        kind: 'income',
        amount: 125,
        currency: 'USD',
        period: 'monthly',
      },
      durationFact,
    ],
    activeScenario: {
      ...state.activeScenario,
      currency: 'USD',
      income: known(125),
      cashFlowBasis: known('monthly'),
      savingsMonths: known(6, durationFact.id),
      observationRange: known({ from: '2026-11-01', to: '2026-11-30' }),
    },
  });
  expect(result.activeScenario.income).toMatchObject({
    status: 'known',
    value: 125,
  });
  expect(result.activeScenario.savingsMonths).toMatchObject({
    status: 'known',
    value: 6,
  });
});

it('allows one-off expenses while keeping monthly debt payments separate', () => {
  const expense = {
    ...fact,
    id: 'expense-1',
    kind: 'expense' as const,
    amount: 1000,
  };
  const state = stateFixture();
  expect(
    ConversationStateSchema.safeParse({
      ...state,
      facts: [expense],
      activeScenario: { ...state.activeScenario, expenseItems: [expense] },
    }).success,
  ).toBe(true);
  const debt = { ...expense, kind: 'debt' as const };
  expect(
    ConversationStateSchema.safeParse({
      ...state,
      facts: [debt],
      activeScenario: { ...state.activeScenario, debtMonthlyPayments: [debt] },
    }).success,
  ).toBe(false);
});

it('rejects current slots pointing at a replaced fact', () => {
  const state = stateFixture();
  expect(
    ConversationStateSchema.safeParse({
      ...state,
      facts: [
        fact,
        {
          ...fact,
          id: 'saved-2',
          source_message_id: 'message-2',
          supersedes_id: fact.id,
        },
      ],
      activeScenario: {
        ...state.activeScenario,
        savingsForGoal: {
          status: 'known',
          value: 0,
          factIds: [fact.id],
          sourceMessageIds: [fact.source_message_id],
          source: 'user_statement',
        },
      },
    }).success,
  ).toBe(false);
});

it('does not impose the wire limit of 32 facts on local storage', () => {
  const facts = Array.from({ length: 40 }, (_, i) => ({
    ...fact,
    id: `fact-${i}`,
  }));
  expect(
    ConversationStateSchema.parse({ ...stateFixture(), facts }).facts,
  ).toHaveLength(40);
});

it.each([
  ['VND', 0, 0],
  ['VND', 15000, 15000],
  ['USD', 0, 0],
  ['USD', 1.25, 125],
] as const)(
  'converts %s scenario money %s to %s minor units and back',
  (currency, amount, minor) => {
    expect(scenarioAmountToMinor(amount, currency)).toBe(minor);
    expect(minorToScenario(minor, currency)).toBe(amount);
  },
);

it('preserves missing money and rejects invalid or excess precision', () => {
  expect(scenarioAmountToMinor(undefined, 'USD')).toBeUndefined();
  expect(minorToScenario(undefined, 'USD')).toBeUndefined();
  for (const value of [-1, Infinity, NaN, 1.001]) {
    expect(() => scenarioAmountToMinor(value, 'USD')).toThrow();
  }
  expect(() => scenarioAmountToMinor(1.5, 'VND')).toThrow();
  expect(() => minorToScenario(1.5, 'USD')).toThrow();
});
