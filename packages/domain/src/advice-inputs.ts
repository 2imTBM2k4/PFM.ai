import {
  isDurationFact,
  isMoneyFact,
  type ConversationFact,
  type MoneyFact,
} from '../../contracts/src/advice-flow';
import type { AnalysisSummaryOutput } from './analysis';
import { MAX_AMOUNT_VND, convertMoney } from './money';
import { validateDate } from './dates';
import { requiredMonthlySaving } from './financial-calculations';

export interface AdviceInputContext {
  cashFlowBasis?: 'monthly';
  observationRange?: { from: string; to: string };
  period?: {
    kind: 'month' | 'week' | 'day' | 'custom';
    from: string;
    to: string;
  };
  mode: 'actual' | 'hypothetical';
  currency: 'VND' | 'USD';
  vndPerUsd?: number | null;
  savingsForGoal?: number;
  savingsMonths?: number;
}
export interface AdviceInputAmount {
  amount: number;
  source: 'conversation' | 'app';
  factIds: string[];
}
export interface AdviceInputs {
  context: AdviceInputContext;
  income: AdviceInputAmount;
  expense: AdviceInputAmount;
  goal: AdviceInputAmount | null;
  savingsForGoal: AdviceInputAmount | null;
  inputFacts: readonly ConversationFact[];
  appData: AnalysisSummaryOutput | null;
}
export type AdviceInputsResult =
  | { ok: true; result: AdviceInputs }
  | { ok: false; needsClarification: string[] };

/** Normalize already source-verified facts; never infer missing amounts or merge situations. */
export function normalizeAdviceInputs(
  facts: readonly ConversationFact[],
  summary: AnalysisSummaryOutput | null,
  context: AdviceInputContext,
): AdviceInputsResult {
  const missing = new Set<string>();
  const fail = (field: string): AdviceInputsResult => ({
    ok: false,
    needsClarification: [field],
  });
  const validAmount = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 && value <= MAX_AMOUNT_VND;
  const validDuration = (value: number) =>
    Number.isSafeInteger(value) && value >= 1 && value <= 1200;
  for (const [field, range] of [
    ['period', context.period],
    ['observationRange', context.observationRange],
  ] as const) {
    if (!range) continue;
    try {
      validateDate(range.from);
      validateDate(range.to);
    } catch {
      return fail(field);
    }
    if (range.from > range.to) return fail(field);
  }
  // Monthly conversation facts cannot be silently prorated into another window.
  if (context.period && context.period.kind !== 'month') return fail('period');
  if (
    context.period &&
    context.observationRange &&
    (context.period.from !== context.observationRange.from ||
      context.period.to !== context.observationRange.to)
  )
    return fail('observationRange');
  const cashFlowBasis =
    context.cashFlowBasis ??
    (context.period?.kind === 'month' ? 'monthly' : undefined);
  if (cashFlowBasis !== 'monthly') return fail('cashFlowBasis');
  const byId = new Map<string, ConversationFact>();
  const replaced = new Set<string>();
  if (facts.length > 32) return fail('conversationFacts');
  for (const fact of facts) {
    const previous = fact.supersedes_id
      ? byId.get(fact.supersedes_id)
      : undefined;
    const validValue = isDurationFact(fact)
      ? validDuration(fact.months)
      : validAmount(fact.amount);
    const validChain =
      !fact.supersedes_id ||
      (!!previous &&
        !replaced.has(fact.supersedes_id) &&
        previous.kind === fact.kind &&
        previous.mode === fact.mode &&
        (!isMoneyFact(fact) ||
          !isMoneyFact(previous) ||
          (previous.currency === fact.currency &&
            previous.period === fact.period &&
            previous.category === fact.category)));
    if (
      !validValue ||
      fact.source !== 'user_statement' ||
      byId.has(fact.id) ||
      !validChain
    )
      return fail('conversationFacts');
    byId.set(fact.id, fact);
    if (fact.supersedes_id) replaced.add(fact.supersedes_id);
  }
  const current = facts.filter(
    (f) => !replaced.has(f.id) && f.mode === context.mode,
  );
  const currentMoney = current.filter(isMoneyFact);
  const money = (fact: MoneyFact): number => {
    if (fact.currency === context.currency) return fact.amount;
    if (
      !context.vndPerUsd ||
      !Number.isFinite(context.vndPerUsd) ||
      context.vndPerUsd <= 0
    ) {
      missing.add('exchangeRate');
      return 0;
    }
    try {
      return convertMoney(
        fact.amount,
        fact.currency,
        context.currency,
        context.vndPerUsd,
      );
    } catch {
      missing.add('amount');
      return 0;
    }
  };
  const monthly = currentMoney.filter(
    (f) => f.kind === 'income' || f.kind === 'expense' || f.kind === 'debt',
  );
  if (monthly.some((f) => f.period !== 'monthly'))
    missing.add(context.period ? 'period' : 'cashFlowBasis');
  const amount = (rows: MoneyFact[]): AdviceInputAmount => ({
    amount: rows.reduce((n, f) => n + money(f), 0),
    source: 'conversation',
    factIds: rows.map((f) => f.id),
  });
  const appMoney = (value: number): AdviceInputAmount => {
    let converted = value;
    if (context.currency === 'USD') {
      if (!context.vndPerUsd) missing.add('exchangeRate');
      else
        try {
          converted = convertMoney(value, 'VND', 'USD', context.vndPerUsd);
        } catch {
          missing.add('exchangeRate');
        }
    }
    return { amount: converted, source: 'app', factIds: [] };
  };
  const useApp =
    context.mode === 'actual' && !!summary && summary.window.monthsWithData > 0;
  const incomes = currentMoney.filter((f) => f.kind === 'income');
  const income = incomes.length
    ? amount(incomes)
    : useApp && summary!.income.monthlyAvg > 0
      ? appMoney(summary!.income.monthlyAvg)
      : null;
  if (!income) missing.add('income');
  const expenses = currentMoney.filter(
    (f) => f.kind === 'expense' || f.kind === 'debt',
  );
  const totals = expenses.filter(
    (f) => f.kind === 'expense' && (!f.category || f.category === 'total'),
  );
  if (totals.length > 1) missing.add('expense.total');
  const total = totals[0];
  const parts = expenses.filter((f) => !totals.includes(f));
  if (useApp && !total && parts.length) missing.add('expense.appOverlap');
  if (total && parts.length && total.includes === undefined)
    missing.add('expense.includes');
  if (
    total?.includes?.length &&
    parts.some(
      (f) =>
        f.kind !== 'debt' &&
        !['housing', 'debt', 'food'].includes(f.category ?? ''),
    )
  )
    missing.add('expense.category');
  const covered = new Set<string>(total?.includes ?? []);
  const unaccounted = parts.filter(
    (f) => !covered.has(f.kind === 'debt' ? 'debt' : (f.category ?? '')),
  );
  // Category subtotals are a stated-cost floor, not proof that every expense is known.
  const expense = expenses.length
    ? amount(total ? [total, ...unaccounted] : parts)
    : useApp
      ? appMoney(summary!.expense.monthlyAvg)
      : null;
  if (!expense) missing.add('expense');
  const goals = currentMoney.filter((f) => f.kind === 'saving_goal');
  if (goals.length > 1) missing.add('goal');
  const goal = goals.length === 1 ? amount(goals) : null;
  let savingsForGoal: AdviceInputAmount | null = null;
  if (goal) {
    if (context.savingsForGoal === undefined) missing.add('savingsForGoal');
    else if (!validAmount(context.savingsForGoal))
      missing.add('savingsForGoal');
    else
      savingsForGoal = {
        amount: context.savingsForGoal,
        source: 'conversation',
        factIds: [],
      };
    if (
      !Number.isSafeInteger(context.savingsMonths) ||
      context.savingsMonths! < 1 ||
      context.savingsMonths! > 600
    )
      missing.add('savingsMonths');
  }
  for (const value of [income, expense, goal])
    if (value && !validAmount(value.amount)) missing.add('amount');
  if (missing.size) return { ok: false, needsClarification: [...missing] };
  return {
    ok: true,
    result: {
      context: {
        ...context,
        cashFlowBasis,
        ...(context.period ? { period: { ...context.period } } : {}),
        ...(context.observationRange
          ? { observationRange: { ...context.observationRange } }
          : {}),
      },
      income: income!,
      expense: expense!,
      goal,
      savingsForGoal,
      inputFacts: facts.map((f) => ({
        ...f,
        ...(isMoneyFact(f) && f.includes ? { includes: [...f.includes] } : {}),
      })),
      appData: summary
        ? (JSON.parse(JSON.stringify(summary)) as AnalysisSummaryOutput)
        : null,
    },
  };
}

/** Return only arithmetic results; the remainder is conditional on the supplied costs. */
export function calculateAdviceInputs(inputs: AdviceInputs) {
  const surplusBeforeGoal = inputs.income.amount - inputs.expense.amount;
  const goalReached =
    inputs.goal !== null && inputs.savingsForGoal!.amount >= inputs.goal.amount;
  const required = inputs.goal
    ? requiredMonthlySaving(
        inputs.goal.amount,
        inputs.savingsForGoal!.amount,
        inputs.context.savingsMonths!,
      )
    : null;
  return {
    surplusBeforeGoal,
    requiredMonthlySaving: required,
    proposedMonthlyContribution: goalReached
      ? 0
      : surplusBeforeGoal < 0
        ? null
        : required,
    remainingAfterGoal: required === null ? null : surplusBeforeGoal - required,
    remainderMeaning: 'after_goal_allocation' as const,
    goalReached,
  };
}
