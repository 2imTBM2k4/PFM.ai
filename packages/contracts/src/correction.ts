import { z } from 'zod';

export interface CorrectionProposal {
  targetField:
    | 'income'
    | 'expenseTotal'
    | 'goalTarget'
    | 'savingsForGoal'
    | 'savingsMonths'
    | 'debtOutstanding'
    | 'monthlySavingsGoal'
    | 'monthlyPayment'
    | 'purchasePrice'
    | 'paymentMonths';
  /** Money uses integer minor units; durations use integer months. */
  proposedValue: number;
  evidence: {
    sourceMessageId: string;
    text: string;
    extractedAmount: number;
    confidence: 'high' | 'medium';
  };
  reason: 'explicit_correction' | 'negation';
  ambiguous: boolean;
  candidateFields?: string[];
}

const FieldSchema = z.enum([
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
]);
const ValueSchema = z.number().int().safe().min(0).max(100_000_000_000);

export const CorrectionProposalSchema: z.ZodType<CorrectionProposal> = z
  .object({
    targetField: FieldSchema,
    proposedValue: ValueSchema,
    evidence: z
      .object({
        sourceMessageId: z.string().trim().min(1).max(120),
        text: z.string().trim().min(1).max(500),
        extractedAmount: ValueSchema,
        confidence: z.enum(['high', 'medium']),
      })
      .strict(),
    reason: z.enum(['explicit_correction', 'negation']),
    ambiguous: z.boolean(),
    candidateFields: z.array(FieldSchema).min(2).optional(),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    if (proposal.evidence.extractedAmount !== proposal.proposedValue)
      ctx.addIssue({
        code: 'custom',
        message: 'Evidence must equal the proposed value.',
      });
    if (
      proposal.ambiguous
        ? !proposal.candidateFields?.includes(proposal.targetField) ||
          new Set(proposal.candidateFields).size !==
            proposal.candidateFields.length
        : proposal.candidateFields !== undefined
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Ambiguity must include unique candidate fields containing the target.',
      });
    if (
      ['savingsMonths', 'paymentMonths'].includes(proposal.targetField) &&
      proposal.proposedValue === 0
    )
      ctx.addIssue({ code: 'custom', message: 'A duration must be positive.' });
  });
