import { describe, expect, it } from 'vitest';
import type {
  ConversationFact,
  DurationFact,
  MoneyFact,
} from '../../contracts/src/advice-flow';
import {
  normalizeAdviceInputs,
  calculateAdviceInputs,
  type AdviceInputContext,
} from './advice-inputs';

const fact = (
  id: string,
  kind: MoneyFact['kind'],
  amount: number,
  extra: Partial<MoneyFact> = {},
): MoneyFact => ({
  id,
  source_message_id: id,
  kind,
  amount,
  currency: 'VND',
  period: 'monthly',
  source: 'user_statement',
  mode: 'actual',
  ...extra,
});
const durationFact = (
  id: string,
  kind: DurationFact['kind'],
  months: number,
  extra: Partial<DurationFact> = {},
): DurationFact => ({
  id,
  source_message_id: id,
  kind,
  months,
  source: 'user_statement',
  mode: 'actual',
  ...extra,
});
const context: AdviceInputContext = {
  period: { kind: 'month', from: '2026-11-01', to: '2026-11-30' },
  mode: 'actual',
  currency: 'VND',
  savingsForGoal: 0,
  savingsMonths: 6,
};
const example = [
  fact('income', 'income', 15_000_000),
  fact('housing', 'expense', 3_000_000, { category: 'housing' }),
  fact('food', 'expense', 3_000_000, { category: 'food' }),
  fact('debt', 'debt', 2_000_000),
  fact('goal', 'saving_goal', 30_000_000, { period: 'one_off' }),
];
const resolve = (facts: readonly ConversationFact[] = example, ctx = context) =>
  normalizeAdviceInputs(facts, null, ctx);

describe('advice input normalization', () => {
  it('separates monthly calculation basis, observation dates and goal horizon', () => {
    const ctx = {
      ...context,
      period: undefined,
      cashFlowBasis: 'monthly' as const,
    };
    const inputs = resolve(example, ctx);
    expect(inputs.ok).toBe(true);
    if (inputs.ok) {
      expect(inputs.result.context.period).toBeUndefined();
      expect(inputs.result.context.observationRange).toBeUndefined();
      expect(calculateAdviceInputs(inputs.result).requiredMonthlySaving).toBe(
        5_000_000,
      );
    }
    expect(resolve(example, { ...ctx, savingsMonths: undefined })).toEqual({
      ok: false,
      needsClarification: ['savingsMonths'],
    });
    expect(resolve(example, { ...ctx, cashFlowBasis: undefined })).toEqual({
      ok: false,
      needsClarification: ['cashFlowBasis'],
    });
    expect(
      resolve(example, {
        ...ctx,
        savingsMonths: undefined,
        observationRange: { from: '2026-05-01', to: '2026-10-31' },
      }),
    ).toEqual({ ok: false, needsClarification: ['savingsMonths'] });
  });

  it.each([
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-11-30', to: '2026-11-01' },
    { from: 'invalid', to: '2026-11-30' },
  ])('rejects invalid supplied observation dates %j', (observationRange) => {
    expect(
      resolve(example, {
        ...context,
        period: undefined,
        cashFlowBasis: 'monthly',
        observationRange,
      }),
    ).toEqual({ ok: false, needsClarification: ['observationRange'] });
  });

  it('keeps legacy monthly callers and rejects conflicting legacy and new dates', () => {
    expect(resolve().ok).toBe(true);
    expect(
      resolve(example, {
        ...context,
        cashFlowBasis: 'monthly',
        observationRange: { from: '2026-11-01', to: '2026-11-30' },
      }).ok,
    ).toBe(true);
    expect(
      resolve(example, {
        ...context,
        cashFlowBasis: 'monthly',
        observationRange: { from: '2026-05-01', to: '2026-10-31' },
      }),
    ).toEqual({ ok: false, needsClarification: ['observationRange'] });
    for (const kind of ['week', 'day', 'custom'] as const)
      expect(
        resolve(example, {
          ...context,
          cashFlowBasis: 'monthly',
          period: { ...context.period!, kind },
        }),
      ).toEqual({ ok: false, needsClarification: ['period'] });
    expect(
      resolve(
        example.map((f) =>
          f.kind === 'income' ? { ...f, period: 'yearly' } : f,
        ),
        { ...context, period: undefined, cashFlowBasis: 'monthly' },
      ),
    ).toEqual({ ok: false, needsClarification: ['cashFlowBasis'] });
  });
  it('computes the stated example with provenance and a conditional remainder', () => {
    const inputs = resolve();
    expect(inputs.ok).toBe(true);
    if (!inputs.ok) return;
    expect(inputs.result.income).toMatchObject({
      amount: 15_000_000,
      source: 'conversation',
    });
    expect(calculateAdviceInputs(inputs.result)).toMatchObject({
      requiredMonthlySaving: 5_000_000,
      remainingAfterGoal: 2_000_000,
      remainderMeaning: 'after_goal_allocation',
      goalReached: false,
    });
  });
  it('distinguishes explicit zero income and missing income or savings', () => {
    expect(
      resolve(
        example.map((f) => (f.kind === 'income' ? { ...f, amount: 0 } : f)),
      ).ok,
    ).toBe(true);
    expect(resolve(example.filter((f) => f.kind !== 'income'))).toMatchObject({
      ok: false,
      needsClarification: ['income'],
    });
    expect(
      resolve(example, { ...context, savingsForGoal: undefined }),
    ).toMatchObject({ ok: false, needsClarification: ['savingsForGoal'] });
  });
  it('does not recommend contributions with a deficit; recognizes an achieved goal', () => {
    for (const [income, savings, reached, contribution] of [
      [1_000_000, 0, false, null],
      [15_000_000, 30_000_000, true, 0],
    ] as const) {
      const inputs = resolve(
        example.map((f) =>
          f.kind === 'income' ? { ...f, amount: income } : f,
        ),
        { ...context, savingsForGoal: savings },
      );
      expect(inputs.ok).toBe(true);
      if (inputs.ok)
        expect(calculateAdviceInputs(inputs.result)).toMatchObject({
          goalReached: reached,
          proposedMonthlyContribution: contribution,
        });
    }
  });
  it('does not double count included housing/debt and asks when inclusion is unknown', () => {
    const total = fact('total', 'expense', 10_000_000, {
      includes: ['housing', 'debt'],
    });
    const facts = example.filter((f) => f.id !== 'food').concat(total);
    const inputs = resolve(facts);
    expect(inputs.ok && inputs.result.expense.amount).toBe(10_000_000);
    expect(
      resolve([
        ...facts.filter((f) => f.id !== 'total'),
        { ...total, includes: undefined },
      ]),
    ).toMatchObject({ ok: false, needsClarification: ['expense.includes'] });
  });

  it('asks about ambiguous category membership before adding a subtotal to an inclusive total', () => {
    const facts = [
      fact('income', 'income', 15_000_000),
      fact('total', 'expense', 10_000_000, { includes: ['housing'] }),
      fact('rent', 'expense', 3_000_000, { category: 'Tiền nhà' }),
    ];
    expect(resolve(facts)).toMatchObject({
      ok: false,
      needsClarification: ['expense.category'],
    });
  });
  it('uses the last correction in a chain without modifying the supplied facts', () => {
    const facts = [
      ...example,
      fact('correction', 'income', 12_000_000, { supersedes_id: 'income' }),
      fact('correction2', 'income', 11_000_000, {
        supersedes_id: 'correction',
      }),
    ];
    const before = JSON.stringify(facts);
    const inputs = resolve(facts);
    expect(inputs.ok && inputs.result.income.amount).toBe(11_000_000);
    expect(JSON.stringify(facts)).toBe(before);
  });
  it('separates hypothetical from actual and refuses missing hypothetical inputs', () => {
    const hypothetical = example.map((f) => ({
      ...f,
      id: `h-${f.id}`,
      mode: 'hypothetical' as const,
      amount: f.kind === 'income' ? 20_000_000 : f.amount,
    }));
    const facts = [...example, ...hypothetical];
    const actual = resolve(facts);
    const simulated = resolve(facts, { ...context, mode: 'hypothetical' });
    expect(actual.ok && actual.result.income.amount).toBe(15_000_000);
    expect(simulated.ok && simulated.result.income.amount).toBe(20_000_000);
    expect(
      resolve([hypothetical[0]], { ...context, mode: 'hypothetical' }).ok,
    ).toBe(false);
  });
  it('asks rather than silently rescaling periods or mixing currencies', () => {
    for (const kind of ['week', 'day', 'custom'] as const)
      expect(
        resolve(example, { ...context, period: { ...context.period!, kind } })
          .ok,
      ).toBe(false);
    expect(resolve(example.map((f) => ({ ...f, currency: 'USD' }))).ok).toBe(
      false,
    );
  });
  it('rejects duplicate IDs, broken corrections, and more than 32 facts', () => {
    expect(resolve([...example, example[0]]).ok).toBe(false);
    expect(
      resolve([fact('a', 'income', 1, { supersedes_id: 'missing' })]).ok,
    ).toBe(false);
    expect(
      resolve(Array.from({ length: 33 }, (_, i) => fact(`${i}`, 'income', i)))
        .ok,
    ).toBe(false);
  });

  it('does not treat an app with only expenses as proof of explicit zero income', () => {
    const summary = {
      window: { monthsRequested: 1, monthsWithData: 1 },
      income: { monthlyAvg: 0, monthlyMin: 0, monthlyMax: 0 },
      expense: {
        monthlyAvg: 1,
        monthlyMin: 1,
        monthlyMax: 1,
        fixedMonthlyAvg: 1,
        variableMonthlyAvg: 0,
        essentialMonthlyAvg: null,
      },
      riskFlags: ['NO_INCOME_RECORDED'],
    };
    const resolved = normalizeAdviceInputs(
      [],
      summary as Parameters<typeof normalizeAdviceInputs>[1],
      context,
    );
    expect(resolved).toMatchObject({
      ok: false,
      needsClarification: ['income'],
    });
  });

  it('accepts valid DurationFact chains alongside MoneyFact without altering monetary totals and rejects invalid durations or broken chains', () => {
    const withDuration: ConversationFact[] = [
      ...example,
      durationFact('months-1', 'savings_months', 6),
      durationFact('months-2', 'savings_months', 12, {
        supersedes_id: 'months-1',
      }),
    ];
    const valid = resolve(withDuration);
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.result.income.amount).toBe(15_000_000);
      expect(valid.result.expense.amount).toBe(8_000_000);
      expect(valid.result.goal?.amount).toBe(30_000_000);
      expect(valid.result.inputFacts).toHaveLength(withDuration.length);
    }

    for (const bad of [
      durationFact('m0', 'savings_months', 0),
      durationFact('m-neg', 'savings_months', -3),
      durationFact('m-max', 'savings_months', 1201),
      durationFact('m-float', 'savings_months', 1.5),
      durationFact('m-missing', 'savings_months', 6, {
        supersedes_id: 'missing',
      }),
      durationFact('m-cross', 'savings_months', 6, {
        supersedes_id: 'goal',
      }),
      durationFact('m-kind', 'payment_months', 12, {
        supersedes_id: 'months-1',
      }),
      durationFact('m-mode', 'savings_months', 12, {
        mode: 'hypothetical',
        supersedes_id: 'months-1',
      }),
    ]) {
      expect(
        resolve([...example, durationFact('months-1', 'savings_months', 6), bad]),
      ).toEqual({
        ok: false,
        needsClarification: ['conversationFacts'],
      });
    }
  });
});
