import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationFactSchema,
  ConversationStateSchema,
  isMoneyFact,
  type ConversationState,
  type CorrectionProposal,
} from '@pfm/contracts';
import { adviceStateFixture } from './advice-context.fixtures';
import { validateConversationStateFacts } from './advice-state-validation';
import { commitCorrection } from './correction-commit';

const storage = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('@/data/conversation-state', () => ({
  writeConversationState: storage.write,
}));
const options = {
  now: '2026-11-16T12:00:00.000Z',
  generateFactId: () => 'new-fact',
};
function makeProposal(
  targetField: CorrectionProposal['targetField'] = 'income',
  proposedValue = 12_000_000,
): CorrectionProposal {
  const labels: Record<CorrectionProposal['targetField'], string> = {
    income: 'thu nhập',
    expenseTotal: 'chi tiêu',
    goalTarget: 'mục tiêu',
    savingsForGoal: 'dành riêng',
    debtOutstanding: 'dư nợ',
    monthlyPayment: 'trả góp',
    savingsMonths: 'thời hạn',
    paymentMonths: 'số tháng trả góp',
    monthlySavingsGoal: 'mục tiêu mỗi tháng',
    purchasePrice: 'giá mua',
  };
  return {
    targetField,
    proposedValue,
    evidence: {
      sourceMessageId: 'current',
      text: `Thực ra ${labels[targetField]} ${proposedValue} ${targetField.endsWith('Months') ? 'tháng' : 'đồng'}`,
      extractedAmount: proposedValue,
      confidence: 'high',
    },
    reason: 'explicit_correction',
    ambiguous: false,
  };
}
function makeState(): ConversationState {
  return adviceStateFixture().state;
}
beforeEach(() => {
  storage.write
    .mockReset()
    .mockImplementation(async (state) =>
      ConversationStateSchema.parse({ ...state, revision: state.revision + 1 }),
    );
});

describe('committed monetary corrections', () => {
  it('appends an income fact, rebinds the monthly basis and returns the persisted revision', async () => {
    const state = makeState();
    const before = structuredClone(state);
    const result = await commitCorrection(state, makeProposal(), options);
    expect(result).toMatchObject({
      status: 'committed',
      newFactId: 'new-fact',
      newState: {
        revision: 2,
        updatedAt: options.now,
        activeScenario: {
          id: 'scenario-1',
          income: {
            value: 12_000_000,
            factIds: ['new-fact'],
            sourceMessageIds: ['current'],
          },
          cashFlowBasis: { value: 'monthly', factIds: ['new-fact'] },
        },
      },
    });
    if (result.status !== 'committed') throw Error('Expected committed');
    expect(result.newState.facts).toHaveLength(before.facts.length + 1);
    expect(result.newState.facts.at(-1)).toEqual({
      id: 'new-fact',
      kind: 'income',
      amount: 12_000_000,
      currency: 'VND',
      period: 'monthly',
      source_message_id: 'current',
      source: 'user_statement',
      mode: 'actual',
      supersedes_id: 'income',
    });
    expect(storage.write).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1 }),
      { sourceMessageId: 'current' },
    );
    expect(state).toEqual(before);
  });

  it.each([
    ['expenseTotal', 8_000_000, 'expense', 'monthly'],
    ['goalTarget', 30_000_000, 'saving_goal', 'one_off'],
    ['savingsForGoal', 0, 'savingsForGoal', 'one_off'],
    ['debtOutstanding', 9_000_000, 'debtOutstanding', 'one_off'],
    ['monthlyPayment', 900_000, 'debt', 'monthly'],
  ] as const)(
    'commits %s with the correct monetary kind and period',
    async (field, value, kind, period) => {
      const state = makeState();
      if (field === 'debtOutstanding' || field === 'monthlyPayment') {
        const fact = {
          id: field,
          source_message_id: 'previous',
          kind,
          period,
          amount: 1_000_000,
          currency: 'VND' as const,
          mode: 'actual' as const,
          source: 'user_statement' as const,
        };
        state.facts.push(fact);
        state.activeScenario[field] = {
          status: 'known',
          value: fact.amount,
          factIds: [fact.id],
          sourceMessageIds: ['previous'],
          source: 'user_statement',
        };
      }
      const original = structuredClone(state);
      const result = await commitCorrection(
        state,
        makeProposal(field, value),
        options,
      );
      expect(result.status).toBe('committed');
      if (result.status !== 'committed') throw Error('Expected committed');
      expect(result.newState.activeScenario[field]).toMatchObject({
        value,
        factIds: ['new-fact'],
      });
      expect(result.newState.facts.at(-1)).toMatchObject({
        kind,
        period,
        amount: value,
        supersedes_id:
          original.activeScenario[field].status === 'known'
            ? original.activeScenario[field].factIds[0]
            : '',
      });
      if (field === 'expenseTotal') {
        const last = result.newState.facts.at(-1);
        expect(last && isMoneyFact(last) ? last.includes : undefined).toEqual([
          'debt',
        ]);
        expect(result.newState.activeScenario.expenseIncludes).toMatchObject({
          value: ['debt'],
          factIds: ['new-fact'],
        });
      }
      expect(state).toEqual(original);
    },
  );

  it('preserves an existing category rather than changing the correction chain', async () => {
    const state = makeState();
    if (isMoneyFact(state.facts[1])) state.facts[1].category = 'total';
    const result = await commitCorrection(
      state,
      makeProposal('expenseTotal', 8_000_000),
      options,
    );
    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      const last = result.newState.facts.at(-1);
      expect(last && isMoneyFact(last) ? last.category : undefined).toBe(
        'total',
      );
    }
  });

  it('preserves the salary category and absent includes on an income correction', async () => {
    const state = makeState();
    if (isMoneyFact(state.facts[0])) {
      state.facts[0].category = 'salary';
      delete state.facts[0].includes;
    }
    const before = structuredClone(state);
    const result = await commitCorrection(state, makeProposal(), options);
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw Error('Expected committed');
    const newFact = result.newState.facts.at(-1);
    expect(newFact).toMatchObject({
      kind: 'income',
      amount: 12_000_000,
      category: 'salary',
    });
    expect(newFact).not.toHaveProperty('includes');
    expect(state).toEqual(before);
  });

  it('preserves absent category and housing/debt includes on an expense correction', async () => {
    const state = makeState();
    if (isMoneyFact(state.facts[1])) {
      delete state.facts[1].category;
      state.facts[1].includes = ['housing', 'debt'];
    }
    if (state.activeScenario.expenseIncludes.status !== 'known')
      throw Error('Expected known expense includes');
    state.activeScenario.expenseIncludes.value = ['housing', 'debt'];
    const before = structuredClone(state);
    const result = await commitCorrection(
      state,
      makeProposal('expenseTotal', 8_000_000),
      options,
    );
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw Error('Expected committed');
    const newFact = result.newState.facts.at(-1);
    expect(newFact).toMatchObject({
      kind: 'expense',
      amount: 8_000_000,
      includes: ['housing', 'debt'],
    });
    expect(newFact).not.toHaveProperty('category');
    expect(result.newState.activeScenario.expenseIncludes).toMatchObject({
      value: ['housing', 'debt'],
      factIds: ['new-fact'],
    });
    expect(state).toEqual(before);
  });

  it.each(['category', 'includes'] as const)(
    'rejects null %s at the fact schema boundary',
    (field) => {
      const fact = { ...makeState().facts[0], [field]: null };
      expect(ConversationFactSchema.safeParse(fact).success).toBe(false);
    },
  );
});

describe('committed duration and negation corrections', () => {
  it('commits savingsMonths 6 -> 12 -> 18 preserving the supersedes_id chain without mutating earlier states', async () => {
    const { state, sourceMessages } = adviceStateFixture();
    const before = structuredClone(state);
    const firstProposal = makeProposal('savingsMonths', 12);
    const firstResult = await commitCorrection(state, firstProposal, {
      now: options.now,
      generateFactId: () => 'months-12',
    });
    expect(firstResult.status).toBe('committed');
    if (firstResult.status !== 'committed') throw Error('Expected committed');
    expect(state).toEqual(before);
    expect(firstResult.newState.activeScenario.savingsMonths).toEqual({
      status: 'known',
      value: 12,
      factIds: ['months-12'],
      sourceMessageIds: ['current'],
      source: 'user_statement',
    });
    expect(firstResult.newState.facts.at(-1)).toEqual({
      id: 'months-12',
      kind: 'savings_months',
      months: 12,
      source_message_id: 'current',
      source: 'user_statement',
      mode: 'actual',
      supersedes_id: 'months',
    });

    const secondProposal: CorrectionProposal = {
      ...makeProposal('savingsMonths', 18),
      evidence: {
        sourceMessageId: 'current-2',
        text: 'Thực ra thời hạn 18 tháng',
        extractedAmount: 18,
        confidence: 'high',
      },
    };
    const afterFirst = structuredClone(firstResult.newState);
    const secondResult = await commitCorrection(
      firstResult.newState,
      secondProposal,
      {
        now: '2026-11-16T12:05:00.000Z',
        generateFactId: () => 'months-18',
      },
    );
    expect(secondResult.status).toBe('committed');
    if (secondResult.status !== 'committed') throw Error('Expected committed');
    expect(firstResult.newState).toEqual(afterFirst);
    expect(secondResult.newState.activeScenario.savingsMonths).toEqual({
      status: 'known',
      value: 18,
      factIds: ['months-18'],
      sourceMessageIds: ['current-2'],
      source: 'user_statement',
    });
    expect(
      secondResult.newState.facts.filter((f) => f.kind === 'savings_months'),
    ).toEqual([
      {
        id: 'months',
        source_message_id: 'm3',
        kind: 'savings_months',
        months: 6,
        source: 'user_statement',
        mode: 'actual',
      },
      {
        id: 'months-12',
        source_message_id: 'current',
        kind: 'savings_months',
        months: 12,
        source: 'user_statement',
        mode: 'actual',
        supersedes_id: 'months',
      },
      {
        id: 'months-18',
        source_message_id: 'current-2',
        kind: 'savings_months',
        months: 18,
        source: 'user_statement',
        mode: 'actual',
        supersedes_id: 'months-12',
      },
    ]);
    const allSources = [
      ...sourceMessages,
      {
        id: 'current',
        text: firstProposal.evidence.text,
        sessionId: state.sessionId,
        createdAt: options.now,
      },
      {
        id: 'current-2',
        text: secondProposal.evidence.text,
        sessionId: state.sessionId,
        createdAt: '2026-11-16T12:05:00.000Z',
      },
    ];
    expect(
      validateConversationStateFacts(
        secondResult.newState.facts,
        allSources,
        {
          sessionId: secondResult.newState.sessionId,
          scenario: secondResult.newState.activeScenario,
        },
      ),
    ).toEqual({ valid: true });
  });

  it('commits a negation correction for savingsForGoal to 0 and passes state validation', async () => {
    const { state, sourceMessages } = adviceStateFixture();
    const savedFact = state.facts.find((f) => f.id === 'saved');
    if (savedFact && isMoneyFact(savedFact)) savedFact.amount = 5_000_000;
    if (state.activeScenario.savingsForGoal.status === 'known')
      state.activeScenario.savingsForGoal.value = 5_000_000;
    sourceMessages[3].text = 'Tiền dành riêng là 5 triệu.';
    const before = structuredClone(state);
    const proposal: CorrectionProposal = {
      targetField: 'savingsForGoal',
      proposedValue: 0,
      evidence: {
        sourceMessageId: 'neg-1',
        text: 'Tôi chưa có tiền dành riêng',
        extractedAmount: 0,
        confidence: 'high',
      },
      reason: 'negation',
      ambiguous: false,
    };
    const result = await commitCorrection(state, proposal, {
      now: options.now,
      generateFactId: () => 'saved-zero',
    });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw Error('Expected committed');
    expect(state).toEqual(before);
    expect(result.newState.activeScenario.savingsForGoal).toEqual({
      status: 'known',
      value: 0,
      factIds: ['saved-zero'],
      sourceMessageIds: ['neg-1'],
      source: 'user_statement',
    });
    expect(result.newState.facts.at(-1)).toEqual({
      id: 'saved-zero',
      kind: 'savingsForGoal',
      amount: 0,
      currency: 'VND',
      period: 'one_off',
      source_message_id: 'neg-1',
      source: 'user_statement',
      mode: 'actual',
      supersedes_id: 'saved',
    });
    expect(
      validateConversationStateFacts(
        result.newState.facts,
        [
          ...sourceMessages,
          {
            id: 'neg-1',
            text: proposal.evidence.text,
            sessionId: state.sessionId,
            createdAt: options.now,
          },
        ],
        {
          sessionId: result.newState.sessionId,
          scenario: result.newState.activeScenario,
        },
      ),
    ).toEqual({ valid: true });
  });
});

describe('rejected corrections', () => {
  it.each([
    [
      'ambiguous',
      { ambiguous: true, candidateFields: ['income', 'expenseTotal'] },
    ],
    [
      'validation_failed',
      {
        targetField: 'savingsMonths',
        proposedValue: 12,
        evidence: {
          sourceMessageId: 'current',
          text: 'Thực ra thời hạn 12 triệu',
          extractedAmount: 12,
          confidence: 'high',
        },
      },
    ],
    [
      'validation_failed',
      {
        targetField: 'savingsMonths',
        proposedValue: 0,
        evidence: {
          sourceMessageId: 'current',
          text: 'Thực ra thời hạn 0 tháng',
          extractedAmount: 0,
          confidence: 'high',
        },
      },
    ],
    [
      'validation_failed',
      {
        targetField: 'savingsMonths',
        proposedValue: 1201,
        evidence: {
          sourceMessageId: 'current',
          text: 'Thực ra thời hạn 1201 tháng',
          extractedAmount: 1201,
          confidence: 'high',
        },
      },
    ],
    [
      'validation_failed',
      {
        targetField: 'savingsForGoal',
        proposedValue: 0,
        reason: 'negation',
        evidence: {
          sourceMessageId: 'current',
          text: 'Thu nhập 0',
          extractedAmount: 0,
          confidence: 'high',
        },
      },
    ],
    [
      'validation_failed',
      {
        targetField: 'savingsForGoal',
        proposedValue: 0,
        reason: 'negation',
        evidence: {
          sourceMessageId: 'current',
          text: 'Chưa để dành đủ',
          extractedAmount: 0,
          confidence: 'high',
        },
      },
    ],
    [
      'validation_failed',
      {
        targetField: 'savingsForGoal',
        proposedValue: 0,
        reason: 'negation',
        evidence: {
          sourceMessageId: 'current',
          text: 'Chưa để dành, có 2 triệu',
          extractedAmount: 0,
          confidence: 'high',
        },
      },
    ],
    ['validation_failed', { reason: 'negation' }],
    ['validation_failed', { targetField: 'monthlySavingsGoal' }],
    ['validation_failed', { targetField: 'purchasePrice' }],
    ['validation_failed', { proposedValue: -1 }],
  ] as const)('rejects %s before storage %#', async (reason, overrides) => {
    const state = makeState();
    const before = structuredClone(state);
    expect(
      await commitCorrection(
        state,
        {
          ...makeProposal(),
          ...overrides,
          candidateFields:
            'candidateFields' in overrides
              ? [...overrides.candidateFields]
              : undefined,
        },
        options,
      ),
    ).toEqual({ status: 'rejected', reason });
    expect(storage.write).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });
  it.each(['debtOutstanding', 'paymentMonths'] as const)(
    'rejects an unknown target (%s)',
    async (field) => {
      expect(
        await commitCorrection(
          makeState(),
          makeProposal(field, field === 'paymentMonths' ? 12 : 12_000_000),
          options,
        ),
      ).toEqual({ status: 'rejected', reason: 'target_unknown' });
      expect(storage.write).not.toHaveBeenCalled();
    },
  );
  it('rejects more than one fact for a slot', async () => {
    const state = makeState();
    if (state.activeScenario.income.status === 'known')
      state.activeScenario.income.factIds.push('income-2');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await commitCorrection(state, makeProposal(), options)).toEqual({
      status: 'rejected',
      reason: 'conflict',
    });
    expect(warn).toHaveBeenCalledWith('CORRECTION_SLOT_CONFLICT');
    expect(storage.write).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it('rejects a fact shared with a different numeric slot', async () => {
    const state = makeState();
    state.activeScenario.monthlySavingsGoal = {
      status: 'known',
      value: 4_000_000,
      factIds: ['goal'],
      sourceMessageIds: ['m3'],
      source: 'user_statement',
    };
    const before = structuredClone(state);
    expect(ConversationStateSchema.safeParse(state).success).toBe(true);
    expect(
      await commitCorrection(
        state,
        makeProposal('goalTarget', 30_000_000),
        options,
      ),
    ).toEqual({ status: 'rejected', reason: 'conflict' });
    expect(storage.write).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });
  it('rejects an income fact referenced by the expense slot at the schema boundary', () => {
    const state = makeState();
    if (isMoneyFact(state.facts[1])) state.facts[1].amount = 15_000_000;
    if (state.activeScenario.expenseTotal.status !== 'known')
      throw Error('Expected known expenses');
    state.activeScenario.expenseTotal.value = 15_000_000;
    state.activeScenario.expenseTotal.factIds = ['income'];
    state.activeScenario.expenseTotal.sourceMessageIds = ['m1'];
    const result = ConversationStateSchema.safeParse(state);
    expect(result.success).toBe(false);
    if (result.success) throw Error('Expected invalid shared income fact');
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['activeScenario', 'expenseTotal', 'factIds'],
        }),
      ]),
    );
  });
  it('rejects a fact also embedded in an expense item', async () => {
    const state = makeState();
    if (!isMoneyFact(state.facts[1])) throw Error('Expected MoneyFact');
    state.activeScenario.expenseItems = [state.facts[1]];
    expect(
      await commitCorrection(
        state,
        makeProposal('expenseTotal', 8_000_000),
        options,
      ),
    ).toEqual({ status: 'rejected', reason: 'conflict' });
    expect(storage.write).not.toHaveBeenCalled();
  });
  it.each(['CONVERSATION_STATE_CONFLICT', 'CONVERSATION_STATE_SOURCE_MISSING'])(
    'does not retry or mutate input after storage rejects %s',
    async (code) => {
      storage.write.mockRejectedValue(new Error(code));
      const state = makeState();
      const before = structuredClone(state);
      expect(await commitCorrection(state, makeProposal(), options)).toEqual({
        status: 'rejected',
        reason:
          code === 'CONVERSATION_STATE_CONFLICT'
            ? 'conflict'
            : 'validation_failed',
      });
      expect(storage.write).toHaveBeenCalledOnce();
      expect(state).toEqual(before);
    },
  );
  it('rejects an invalid generated fact id before writing', async () => {
    expect(
      await commitCorrection(makeState(), makeProposal(), {
        ...options,
        generateFactId: () => 'income',
      }),
    ).toEqual({ status: 'rejected', reason: 'validation_failed' });
    expect(storage.write).not.toHaveBeenCalled();
  });
});
