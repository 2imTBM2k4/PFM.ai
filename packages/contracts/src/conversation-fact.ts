import { z } from 'zod';

export const MoneyFactSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    source_message_id: z.string().trim().min(1).max(120),
    kind: z.enum([
      'income',
      'expense',
      'saving_goal',
      'debt',
      'one_off',
      'savingsForGoal',
      'debtOutstanding',
    ]),
    amount: z.number().finite().int().safe().min(0).max(100_000_000_000),
    currency: z.enum(['VND', 'USD']),
    period: z.enum(['monthly', 'yearly', 'one_off']),
    category: z.string().trim().min(1).max(120).optional(),
    includes: z
      .array(z.enum(['housing', 'debt', 'food']))
      .max(3)
      .optional(),
    source: z.literal('user_statement'),
    mode: z.enum(['actual', 'hypothetical']),
    supersedes_id: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type MoneyFact = z.infer<typeof MoneyFactSchema>;

export const DurationFactSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    source_message_id: z.string().trim().min(1).max(120),
    kind: z.enum(['savings_months', 'payment_months']),
    months: z.number().finite().int().safe().min(1).max(1200),
    source: z.literal('user_statement'),
    mode: z.enum(['actual', 'hypothetical']),
    supersedes_id: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type DurationFact = z.infer<typeof DurationFactSchema>;

export const ConversationFactSchema = z.union([
  MoneyFactSchema,
  DurationFactSchema,
]);
export type ConversationFact = z.infer<typeof ConversationFactSchema>;

/** Narrow a conversation fact to a monetary statement. */
export function isMoneyFact(fact: ConversationFact): fact is MoneyFact {
  return 'amount' in fact;
}

/** Narrow a conversation fact to a goal or payment duration statement. */
export function isDurationFact(fact: ConversationFact): fact is DurationFact {
  return 'months' in fact;
}
