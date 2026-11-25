import { describe, expect, it } from 'vitest';
import {
  ConversationStateSchema,
  CorrectionProposalSchema,
  type ConversationState,
} from '@pfm/contracts';
import { adviceStateFixture } from './advice-context.fixtures';
import { detectCorrection } from './correction-detection';

type Field =
  | 'income'
  | 'expenseTotal'
  | 'goalTarget'
  | 'savingsForGoal'
  | 'debtOutstanding'
  | 'monthlyPayment'
  | 'monthlySavingsGoal'
  | 'purchasePrice'
  | 'savingsMonths'
  | 'paymentMonths';
const fields: Field[] = [
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
const context = { language: 'vi' as const, currency: 'VND' as const };

/** Build valid state with only the requested correctable slots known; insertion order controls fact recency. */
function makeState(
  values: Partial<Record<Field, number>> = {},
  currency: 'VND' | 'USD' = 'VND',
): ConversationState {
  const { state } = adviceStateFixture();
  state.activeScenario.currency = currency;
  for (const key of [...fields, 'cashFlowBasis', 'expenseIncludes'] as const)
    state.activeScenario[key] = { status: 'unknown' };
  state.facts = [];
  const kinds = {
    income: 'income',
    expenseTotal: 'expense',
    goalTarget: 'saving_goal',
    savingsForGoal: 'savingsForGoal',
    debtOutstanding: 'debtOutstanding',
    monthlyPayment: 'debt',
    monthlySavingsGoal: 'saving_goal',
    purchasePrice: 'one_off',
  } as const;
  const durationKinds = {
    savingsMonths: 'savings_months',
    paymentMonths: 'payment_months',
  } as const;
  for (const field of fields
    .filter((field) => values[field] !== undefined)
    .sort(
      (a, b) => Object.keys(values).indexOf(a) - Object.keys(values).indexOf(b),
    )) {
    const value = values[field]!;
    const fact =
      field === 'savingsMonths' || field === 'paymentMonths'
        ? {
            id: field,
            source_message_id: `source-${field}`,
            kind: durationKinds[field],
            months: value,
            source: 'user_statement' as const,
            mode: 'actual' as const,
          }
        : {
            id: field,
            source_message_id: `source-${field}`,
            kind: kinds[field],
            amount: value,
            currency,
            period: 'monthly' as const,
            source: 'user_statement' as const,
            mode: 'actual' as const,
          };
    state.facts.push(fact);
    state.activeScenario[field] = {
      status: 'known',
      value,
      factIds: [fact.id],
      sourceMessageIds: [fact.source_message_id],
      source: 'user_statement',
    };
  }
  return ConversationStateSchema.parse(state);
}

describe('A — explicit corrections', () => {
  it('proposes a corrected income with original evidence, without writing state', () => {
    const input = '  Thực ra thu nhập của tôi là 12 triệu  ';
    expect(
      detectCorrection(
        input,
        'current',
        makeState({ income: 15_000_000 }),
        context,
      ),
    ).toEqual({
      targetField: 'income',
      proposedValue: 12_000_000,
      evidence: {
        sourceMessageId: 'current',
        text: input.trim(),
        extractedAmount: 12_000_000,
        confidence: 'high',
      },
      reason: 'explicit_correction',
      ambiguous: false,
    });
  });

  it.each([
    ['expenseTotal', 'Sửa lại: chi tiêu 8 triệu', 8_000_000],
    ['goalTarget', 'À nhầm, mục tiêu là 30 triệu', 30_000_000],
    ['income', 'Đính chính: thu nhập 12 triệu', 12_000_000],
    ['income', 'Quên, thu nhập là 12 triệu', 12_000_000],
    ['income', 'Actually, income is 12,000,000', 12_000_000],
    ['income', 'Thực ra thu nhập là 12tr', 12_000_000],
    ['income', 'Thực ra thu nhập là 12.000.000 đồng', 12_000_000],
    ['savingsForGoal', 'Thực ra dành riêng 0 đồng', 0],
  ] as const)('corrects %s from %s', (field, message, value) => {
    expect(
      detectCorrection(
        message,
        'current',
        makeState({ [field]: 15_000_000 }),
        context,
      ),
    ).toMatchObject({
      targetField: field,
      proposedValue: value,
      reason: 'explicit_correction',
      ambiguous: false,
    });
  });
});

describe('B — negation', () => {
  it.each([
    ['savingsForGoal', 0, 'Thực ra tôi chưa dành riêng đồng nào'],
    ['savingsForGoal', 5_000_000, 'Không phải, tôi chưa để dành gì cả'],
    ['income', 15_000_000, 'Thực ra tôi chưa có gì'],
  ] as const)(
    'recognizes explicit absence: %s / %s / %s',
    (field, oldValue, message) => {
      expect(
        detectCorrection(
          message,
          'current',
          makeState({ [field]: oldValue }),
          context,
        ),
      ).toMatchObject({
        targetField: field,
        proposedValue: 0,
        reason: 'negation',
        ambiguous: false,
        evidence: { extractedAmount: 0, confidence: 'high' },
      });
    },
  );
});

describe('C — ambiguity', () => {
  it('keeps both candidates and uses the newest fact only as a placeholder', () => {
    expect(
      detectCorrection(
        'Thực ra 12 triệu',
        'current',
        makeState({ expenseTotal: 10_000_000, income: 15_000_000 }),
        context,
      ),
    ).toMatchObject({
      targetField: 'income',
      ambiguous: true,
      candidateFields: ['income', 'expenseTotal'],
    });
  });
  it('does not silently choose between income and a goal', () => {
    expect(
      detectCorrection(
        'À nhầm 30 triệu',
        'current',
        makeState({ income: 15_000_000, goalTarget: 24_000_000 }),
        context,
      ),
    ).toMatchObject({
      targetField: 'goalTarget',
      ambiguous: true,
      candidateFields: ['income', 'goalTarget'],
    });
  });
});

describe('D — no correction', () => {
  it.each([
    'Cho tôi xem thu nhập tháng này',
    'Thu nhập của tôi là 12 triệu',
    '12 triệu',
    'Tôi muốn tiết kiệm 12 triệu',
  ])('does not infer an implicit correction: %s', (message) => {
    expect(
      detectCorrection(
        message,
        'current',
        makeState({ income: 15_000_000 }),
        context,
      ),
    ).toBeNull();
  });
  it('ignores a correction without state', () => {
    expect(
      detectCorrection('Thực ra 12 triệu', 'current', null, context),
    ).toBeNull();
  });
  it('ignores a correction when no correctable slot is known', () => {
    expect(
      detectCorrection('Thực ra 12 triệu', 'current', makeState(), context),
    ).toBeNull();
  });
});

describe('E — safe rejection', () => {
  it.each([
    'Thực ra âm 12 triệu',
    'Thực ra 2 lít',
    'Thực ra ' + 'a'.repeat(501),
    'Thực ra 12 triệu và chi 8 triệu',
    'Thực ra 12 triệu 30 triệu',
  ])('rejects uncertain values: %s', (message) => {
    expect(
      detectCorrection(
        message,
        'current',
        makeState({ income: 15_000_000 }),
        context,
      ),
    ).toBeNull();
  });
  it('accepts medium confidence monetary slang', () => {
    expect(
      detectCorrection(
        'Thực ra 2 chai',
        'current',
        makeState({ income: 15_000_000 }),
        context,
      ),
    ).toMatchObject({
      targetField: 'income',
      proposedValue: 2_000_000,
      evidence: { confidence: 'medium' },
    });
  });
  it('does not treat VND as USD', () => {
    expect(
      detectCorrection(
        'Thực ra 12 triệu VND',
        'current',
        makeState({ income: 1500 }, 'USD'),
        { ...context, currency: 'USD' },
      ),
    ).toBeNull();
  });
});

describe('G — purity and legacy safety', () => {
  it('is a no-op with null state', () => {
    expect(
      detectCorrection('Thực ra 12 triệu', 'current', null, context),
    ).toBeNull();
  });
  it('preserves the complete state, including revision and scenario identity', () => {
    const state = makeState({ income: 15_000_000 });
    const before = structuredClone(state);
    detectCorrection('Thực ra 12 triệu', 'current', state, context);
    expect(state).toEqual(before);
  });
});

describe('E — additional safety boundaries', () => {
  it.each(['Sửa lại thời hạn 0.9 tháng', 'Sửa lại thời hạn 1,5 tháng'])(
    'does not read the fractional part as whole months: %s',
    (message) => {
      expect(
        detectCorrection(
          message,
          'current',
          makeState({ savingsMonths: 6 }),
          context,
        ),
      ).toBeNull();
    },
  );
  it.each([
    'Thực ra tôi chưa để dành đủ',
    'Thực ra tôi chưa dành riêng hết',
    'Thực ra không phải là chưa dành riêng',
  ])(
    'does not equate insufficient or doubly negated savings with zero: %s',
    (message) => {
      expect(
        detectCorrection(
          message,
          'current',
          makeState({ savingsForGoal: 5_000_000 }),
          context,
        ),
      ).toBeNull();
    },
  );
  it.each([
    'Thực ra 0k0001',
    'Actually $0.001',
    'Thực ra -12 triệu',
    'Thực ra thu nhập và chi tiêu 12 triệu',
    'Thực ra tôi chưa dành riêng 2 triệu',
    'Thực ra tôi chưa có gì',
    'Actually, income is 12 million',
    'Thực ra 2 xị và 12 triệu',
    'Actually, income is 12 EUR',
    'Thực ra thu nhập 12 triệu?',
  ])(
    'rejects contradictory, ambiguous, or unsupported evidence: %s',
    (message) => {
      expect(
        detectCorrection(
          message,
          'current',
          makeState({ income: 15_000_000, savingsForGoal: 5_000_000 }),
          context,
        ),
      ).toBeNull();
    },
  );
  it('does not propose a value for an unknown target', () => {
    expect(
      detectCorrection(
        'Sửa lại chi tiêu 8 triệu',
        'current',
        makeState({ income: 15_000_000 }),
        context,
      ),
    ).toBeNull();
  });
  it('rejects unsupported currency units even when USD numeric parsing has high confidence', () => {
    expect(
      detectCorrection(
        'Actually, income is 12 EUR',
        'current',
        makeState({ income: 1500 }, 'USD'),
        { ...context, currency: 'USD' },
      ),
    ).toBeNull();
  });
  it('does not silently parse million as twelve USD', () => {
    expect(
      detectCorrection(
        'Actually, income is 12 million',
        'current',
        makeState({ income: 1500 }, 'USD'),
        { ...context, currency: 'USD' },
      ),
    ).toBeNull();
  });
  it('keeps USD values in cents exactly once', () => {
    expect(
      detectCorrection(
        'Actually, income is $12.50',
        'current',
        makeState({ income: 1500 }, 'USD'),
        { ...context, language: 'en', currency: 'USD' },
      ),
    ).toMatchObject({
      proposedValue: 1250,
      evidence: { extractedAmount: 1250 },
    });
  });
  it('uses deterministic field order when two slots reference the same newest fact', () => {
    const state = makeState({
      goalTarget: 24_000_000,
      monthlySavingsGoal: 3_000_000,
    });
    if (state.activeScenario.monthlySavingsGoal.status === 'known')
      state.activeScenario.monthlySavingsGoal.factIds = ['goalTarget'];
    state.facts.pop();
    expect(
      detectCorrection('À nhầm 30 triệu', 'current', state, context),
    ).toMatchObject({
      targetField: 'goalTarget',
      ambiguous: true,
      candidateFields: ['goalTarget', 'monthlySavingsGoal'],
    });
  });
});

describe('A — vocabulary and month units', () => {
  it.each([
    'Thật ra',
    'Hóa ra',
    'Không phải',
    'Sửa thành',
    'Điều chỉnh',
    'À mà',
    'Mà thôi',
    'Đúng ra là',
    'Lẽ ra',
    'Correction',
    'I mean',
    'Wait',
    'Sorry',
    'Oops',
  ])(
    'recognizes an explicit signal without implicit inference: %s',
    (signal) => {
      expect(
        detectCorrection(
          `${signal}, income 12,000,000`,
          'current',
          makeState({ income: 15_000_000 }),
          context,
        ),
      ).toMatchObject({ targetField: 'income', proposedValue: 12_000_000 });
    },
  );
  it('recognizes case-insensitive accent-free correction text', () => {
    expect(
      detectCorrection(
        'THUC RA THU NHAP 12 TRIEU',
        'current',
        makeState({ income: 15_000_000 }),
        context,
      ),
    ).toMatchObject({ proposedValue: 12_000_000 });
  });
  it('reads an explicit integer duration in months without money conversion', () => {
    expect(
      detectCorrection(
        'Sửa lại thời hạn 9 tháng',
        'current',
        makeState({ savingsMonths: 6 }),
        context,
      ),
    ).toMatchObject({
      targetField: 'savingsMonths',
      proposedValue: 9,
      evidence: { extractedAmount: 9 },
    });
  });
  it('rejects a monetary amount for a duration slot', () => {
    expect(
      detectCorrection(
        'Sửa lại thời hạn 9 triệu',
        'current',
        makeState({ savingsMonths: 6 }),
        context,
      ),
    ).toBeNull();
  });
});

describe('B — negation vocabulary', () => {
  it.each([
    'Chưa để dành gì cả',
    'Chưa có tiền dành riêng',
    'Không có tiền để dành',
    'No savings yet',
    "Haven't saved",
    "Haven't reserved",
    'No money set aside',
  ])('recognizes a scoped assertion of no savings: %s', (message) => {
    expect(
      detectCorrection(
        message,
        'current',
        makeState({ savingsForGoal: 5_000_000 }),
        context,
      ),
    ).toMatchObject({
      targetField: 'savingsForGoal',
      proposedValue: 0,
      reason: 'negation',
    });
  });
});

describe('CorrectionProposal contract', () => {
  const proposal = {
    targetField: 'income',
    proposedValue: 0,
    evidence: {
      sourceMessageId: 'current',
      text: 'Thực ra thu nhập 0 đồng',
      extractedAmount: 0,
      confidence: 'high',
    },
    reason: 'explicit_correction',
    ambiguous: false,
  };
  it('accepts explicit zero without dropping evidence', () => {
    expect(CorrectionProposalSchema.safeParse(proposal).success).toBe(true);
  });
  it.each([
    { ...proposal, proposedValue: -1 },
    { ...proposal, evidence: { ...proposal.evidence, confidence: 'low' } },
    { ...proposal, evidence: { ...proposal.evidence, extractedAmount: 1 } },
    { ...proposal, ambiguous: true },
    { ...proposal, candidateFields: ['income', 'expenseTotal'] },
    { ...proposal, ambiguous: true, candidateFields: ['income', 'income'] },
    { ...proposal, targetField: 'savingsMonths' },
  ])('rejects an inconsistent proposal %#', (invalid) => {
    expect(CorrectionProposalSchema.safeParse(invalid).success).toBe(false);
  });
});
