import { z } from 'zod';
import { validateDate } from '@pfm/domain';
import {
  ConversationFactSchema,
  MoneyFactSchema,
  isMoneyFact,
  type ConversationFact,
} from './conversation-fact';

export type Slot<T> =
  | { status: 'unknown' }
  | {
      status: 'known';
      value: T;
      factIds: string[];
      sourceMessageIds: string[];
      source: 'user_statement' | 'app';
    };

const IdSchema = z.string().min(1).max(120);
const AmountSchema = z
  .number()
  .finite()
  .int()
  .safe()
  .min(0)
  .max(100_000_000_000);
const DurationSchema = z.number().int().safe().min(1).max(1200);
const DateSchema = z.string().superRefine((value, ctx) => {
  try {
    validateDate(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid calendar date.' });
  }
});
const RangeSchema = z
  .object({ from: DateSchema, to: DateSchema })
  .strict()
  .refine(({ from, to }) => from <= to, 'Date range is reversed.');

function slot<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('unknown') }).strict(),
    z
      .object({
        status: z.literal('known'),
        value,
        factIds: z.array(IdSchema).min(1),
        sourceMessageIds: z.array(IdSchema),
        source: z.enum(['user_statement', 'app']),
      })
      .strict(),
  ]);
}

export const ScenarioSchema = z
  .object({
    id: IdSchema,
    topic: z.string().min(1).max(120),
    mode: z.enum(['actual', 'hypothetical']),
    currency: z.enum(['VND', 'USD']),
    cashFlowBasis: slot(z.literal('monthly')),
    observationRange: slot(RangeSchema),
    income: slot(AmountSchema),
    expenseTotal: slot(AmountSchema),
    expenseIncludes: slot(z.array(z.enum(['housing', 'debt', 'food'])).max(3)),
    expenseItems: z.array(MoneyFactSchema),
    debtMonthlyPayments: z.array(MoneyFactSchema),
    debtOutstanding: slot(AmountSchema),
    goalTarget: slot(AmountSchema),
    monthlySavingsGoal: slot(AmountSchema),
    savingsForGoal: slot(AmountSchema),
    savingsMonths: slot(DurationSchema),
    purchasePrice: slot(AmountSchema),
    monthlyPayment: slot(AmountSchema),
    paymentMonths: slot(DurationSchema),
  })
  .strict();

export interface ConversationState {
  version: 1;
  sessionId: string;
  revision: number;
  activeScenario: z.infer<typeof ScenarioSchema>;
  facts: ConversationFact[];
  pendingFields: string[];
  updatedAt: string;
}

const slotFactKinds: Readonly<
  Record<string, ConversationFact['kind'] | undefined>
> = {
  income: 'income',
  expenseTotal: 'expense',
  expenseIncludes: 'expense',
  debtOutstanding: 'debtOutstanding',
  goalTarget: 'saving_goal',
  monthlySavingsGoal: 'saving_goal',
  savingsForGoal: 'savingsForGoal',
  savingsMonths: 'savings_months',
  purchasePrice: 'one_off',
  monthlyPayment: 'debt',
  paymentMonths: 'payment_months',
};

/** Validate local state without imposing the legacy request's 32-fact limit. */
export const ConversationStateSchema: z.ZodType<ConversationState> = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1).max(64),
    revision: z.number().int().safe().min(0),
    activeScenario: ScenarioSchema,
    facts: z.array(ConversationFactSchema),
    pendingFields: z.array(IdSchema),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((state, ctx) => {
    const seen = new Map<string, ConversationFact>();
    const replaced = new Set<string>();
    for (const [index, fact] of state.facts.entries()) {
      const previous = fact.supersedes_id
        ? seen.get(fact.supersedes_id)
        : undefined;
      if (
        seen.has(fact.id) ||
        (fact.supersedes_id &&
          (!previous ||
            replaced.has(previous.id) ||
            previous.kind !== fact.kind ||
            previous.mode !== fact.mode ||
            (isMoneyFact(fact) &&
              isMoneyFact(previous) &&
              (previous.currency !== fact.currency ||
                previous.period !== fact.period ||
                previous.category !== fact.category))))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['facts', index],
          message: 'Invalid fact correction chain.',
        });
      }
      seen.set(fact.id, fact);
      if (fact.supersedes_id) replaced.add(fact.supersedes_id);
    }
    for (const [key, value] of Object.entries(state.activeScenario)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        'status' in value &&
        value.status === 'known'
      ) {
        for (const id of value.factIds) {
          const fact = seen.get(id);
          const expectedKind = slotFactKinds[key];
          // Temporal slots lack dedicated fact kinds; still require active evidence.
          if (
            !fact ||
            replaced.has(id) ||
            (expectedKind && fact.kind !== expectedKind)
          ) {
            ctx.addIssue({
              code: 'custom',
              path: ['activeScenario', key, 'factIds'],
              message:
                'Slot must reference an active local fact of the expected kind.',
            });
          }
        }
      }
    }
    for (const [key, kind] of [
      ['expenseItems', 'expense'],
      ['debtMonthlyPayments', 'debt'],
    ] as const) {
      for (const [index, fact] of state.activeScenario[key].entries()) {
        if (
          fact.kind !== kind ||
          fact.mode !== state.activeScenario.mode ||
          fact.currency !== state.activeScenario.currency ||
          (key === 'debtMonthlyPayments' && fact.period !== 'monthly') ||
          replaced.has(fact.id) ||
          JSON.stringify(seen.get(fact.id)) !== JSON.stringify(fact)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['activeScenario', key, index],
            message:
              'Scenario item must match an active fact with the expected kind and period.',
          });
        }
      }
    }
  });

/** Convert legacy scenario major USD units to integer minor units without guessing precision. */
export function scenarioAmountToMinor(
  value: number | undefined,
  currency: 'VND' | 'USD',
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError('INVALID_SCENARIO_AMOUNT');
  const scale = currency === 'USD' ? 100 : 1;
  const scaled = value * scale;
  const minor = Math.round(scaled);
  if (
    Math.abs(scaled - minor) >
    Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2
  ) {
    throw new RangeError('INVALID_SCENARIO_PRECISION');
  }
  return AmountSchema.parse(minor);
}

/** Convert stored integer minor units to the legacy scenario representation. */
export function minorToScenario(
  value: number | undefined,
  currency: 'VND' | 'USD',
): number | undefined {
  if (value === undefined) return undefined;
  return AmountSchema.parse(value) / (currency === 'USD' ? 100 : 1);
}
