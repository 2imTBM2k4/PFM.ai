import { z } from 'zod';
import {
  MoneyFactSchema,
  isMoneyFact,
  type MoneyFact,
} from './conversation-fact';
import { AdviceValidationContextSchema } from './advice-validation-context';
export {
  ConversationFactSchema,
  DurationFactSchema,
  MoneyFactSchema,
  isDurationFact,
  isMoneyFact,
} from './conversation-fact';
export type {
  ConversationFact,
  DurationFact,
  MoneyFact,
} from './conversation-fact';

export const AdviceMetricSchema = z.enum([
  'monthly_income_avg',
  'monthly_expense_avg',
  'current_month_income',
  'current_month_expense',
  'current_month_projected_expense',
  'surplus_p25',
  'surplus_median',
  'surplus_p75',
  'available_for_goals',
  'liquid_balance',
  'existing_debt_monthly',
  'months_with_data',
  'emergency_fund_months',
  'purchase_remaining',
  'purchase_months_p25',
  'purchase_months_median',
  'purchase_months_p75',
  'surplus_after_payment',
  'payment_reserve_total',
  'savings_required_monthly',
  'surplus_after_savings_goal',
  'recurring_monthly_total',
  'savings_target_remaining',
  'savings_months_given',
  'savings_rate_bps',
  'dti_bps',
  'monthly_income_min',
  'monthly_income_max',
  'expense_fixed_avg',
  'expense_variable_avg',
  'essential_monthly_expense',
  'emergency_fund_months_essential',
]);
export type AdviceMetric = z.infer<typeof AdviceMetricSchema>;

const ConversationFactsSchema = z
  .array(MoneyFactSchema)
  .max(32)
  .superRefine((facts, context) => {
    const seen = new Map<string, MoneyFact>();
    const replaced = new Set<string>();
    for (const [index, fact] of facts.entries()) {
      const previous = fact.supersedes_id
        ? seen.get(fact.supersedes_id)
        : undefined;
      if (
        seen.has(fact.id) ||
        (fact.supersedes_id &&
          (!previous ||
            replaced.has(fact.supersedes_id) ||
            previous.id === fact.id ||
            previous.mode !== fact.mode ||
            previous.kind !== fact.kind ||
            (isMoneyFact(fact) &&
              isMoneyFact(previous) &&
              (previous.currency !== fact.currency ||
                previous.period !== fact.period ||
                previous.category !== fact.category))))
      )
        context.addIssue({
          code: 'custom',
          path: [index],
          message:
            'Fact IDs must be unique; corrections must replace an earlier fact in the same situation.',
        });
      seen.set(fact.id, fact);
      if (fact.supersedes_id) replaced.add(fact.supersedes_id);
    }
  });

/** Validate source ownership against only the user messages supplied for this request. */
export function validateConversationFacts(
  input: unknown,
  messages: readonly { id: string; role: string }[],
): MoneyFact[] {
  const facts = ConversationFactsSchema.parse(input);
  const users = new Set(
    messages
      .filter((message) => message.role === 'user')
      .map((message) => message.id),
  );
  if (
    new Set(messages.map((message) => message.id)).size !== messages.length ||
    facts.some((fact) => !users.has(fact.source_message_id))
  )
    throw new Error('CONVERSATION_FACT_SOURCE');
  const order = new Map(messages.map((message, index) => [message.id, index]));
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  if (
    facts.some(
      (fact) =>
        fact.supersedes_id &&
        order.get(fact.source_message_id)! <=
          order.get(byId.get(fact.supersedes_id)!.source_message_id)!,
    )
  )
    throw new Error('CONVERSATION_FACT_CORRECTION_ORDER');
  return facts;
}

export const EntryDraftSchema = z
  .object({
    amount: z
      .number()
      .finite()
      .int()
      .safe()
      .min(0)
      .max(100_000_000_000)
      .nullable(),
    currency: z.enum(['VND', 'USD']).nullable(),
    type: z.enum(['income', 'expense']).nullable(),
    category: z.string().trim().min(1).max(120).nullable(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    wallet_id: z.string().trim().min(1).max(120).nullable(),
    note: z.string().trim().max(500).nullable(),
    merchant: z.string().trim().min(1).max(120).nullable(),
    confidence: z
      .object({
        amount: z.enum(['high', 'low']),
        currency: z.enum(['high', 'low']),
        type: z.enum(['high', 'low']),
        category: z.enum(['high', 'low']),
        date: z.enum(['high', 'low']),
        wallet_id: z.enum(['high', 'low']),
        note: z.enum(['high', 'low']),
        merchant: z.enum(['high', 'low']),
      })
      .strict(),
    missing_fields: z
      .array(
        z.enum(['amount', 'currency', 'type', 'category', 'date', 'wallet_id']),
      )
      .max(6)
      .refine(
        (fields) => new Set(fields).size === fields.length,
        'Missing fields must be unique.',
      ),
  })
  .strict();
export type EntryDraft = z.infer<typeof EntryDraftSchema>;

export const AdviceScenarioSchema = z
  .object({
    conversationFacts: ConversationFactsSchema.optional(),
    price: z.number().finite().safe().min(0).max(1_000_000_000_000).optional(),
    monthlyPayment: z
      .number()
      .finite()
      .safe()
      .min(0)
      .max(1_000_000_000_000)
      .optional(),
    paymentMonths: z.number().int().min(1).max(600).optional(),
    /** A recurring monthly saving amount, distinct from a total target. */
    monthlySavingsGoal: z
      .number()
      .finite()
      .safe()
      .min(0)
      .max(1_000_000_000_000)
      .optional(),
    /** A total amount the user wants to reach, paired with savingsMonths. */
    savingsTarget: z
      .number()
      .finite()
      .safe()
      .min(0)
      .max(1_000_000_000_000)
      .optional(),
    savingsMonths: z.number().int().min(1).max(600).optional(),
    /** Money explicitly reserved for this goal, in the selected currency. */
    savingsForGoal: z
      .number()
      .finite()
      .safe()
      .min(0)
      .max(1_000_000_000_000)
      .optional(),
  })
  .strict();
export type AdviceScenario = z.infer<typeof AdviceScenarioSchema>;

/** Supported windows only, matching the periods the device can resolve. */
export const AdviceRangeKindSchema = z.enum([
  'last_7_days',
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_30_days',
]);
export type AdviceRangeKindName = z.infer<typeof AdviceRangeKindSchema>;

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD.')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    if (month < 1 || month > 12) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
      month - 1
    ];
    return day >= 1 && day <= days;
  }, 'Not a calendar date.');

const AdviceCategoryNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'Category names may not contain control characters.',
  });

const AdviceMoneySchema = z.number().int().safe().min(0).max(100_000_000_000);

export const AdviceExpenseGroupSchema = z
  .object({
    kind: z.literal('expense_by_category'),
    rangeKind: AdviceRangeKindSchema,
    from: IsoDateSchema,
    to: IsoDateSchema,
    totalExpense: AdviceMoneySchema,
    topCategories: z
      .array(
        z
          .object({
            name: AdviceCategoryNameSchema,
            amount: AdviceMoneySchema,
          })
          .strict(),
      )
      .max(5),
    otherAmount: AdviceMoneySchema,
    uncategorizedAmount: AdviceMoneySchema,
  })
  .strict();
export type AdviceExpenseGroup = z.infer<typeof AdviceExpenseGroupSchema>;

export const AdviceBudgetGroupSchema = z
  .object({
    kind: z.literal('budget_status'),
    month: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM.'),
    items: z
      .array(
        z
          .object({
            name: AdviceCategoryNameSchema,
            limitAmount: AdviceMoneySchema,
            spentAmount: AdviceMoneySchema,
            remainingAmount: AdviceMoneySchema,
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export type AdviceBudgetGroup = z.infer<typeof AdviceBudgetGroupSchema>;

const AdviceCountSchema = z.number().int().min(0).max(100_000);
const AdvicePercentSchema = z.number().int().min(0).max(100);

export const AdviceHabitChildSchema = z
  .object({
    name: AdviceCategoryNameSchema,
    amount: AdviceMoneySchema,
    count: AdviceCountSchema,
    avgTicket: AdviceMoneySchema,
  })
  .strict();
export type AdviceHabitChild = z.infer<typeof AdviceHabitChildSchema>;

export const AdviceHabitParentSchema = z
  .object({
    name: AdviceCategoryNameSchema,
    amount: AdviceMoneySchema,
    /** Same-length window immediately before `from`; null when unavailable. */
    previousAmount: AdviceMoneySchema.nullable(),
    count: AdviceCountSchema,
    avgTicket: AdviceMoneySchema,
    largestTicket: AdviceMoneySchema,
    /** False for housing, utilities, health and other committed costs. */
    isFlexible: z.boolean(),
    children: z.array(AdviceHabitChildSchema).max(5),
  })
  .strict();
export type AdviceHabitParent = z.infer<typeof AdviceHabitParentSchema>;

export const AdviceSpendingHabitsGroupSchema = z
  .object({
    kind: z.literal('spending_habits'),
    rangeKind: AdviceRangeKindSchema,
    from: IsoDateSchema,
    to: IsoDateSchema,
    /** Length of the window in days, so frequency wording stays verifiable. */
    daysInRange: z.number().int().min(1).max(366),
    transactionCount: AdviceCountSchema,
    totalExpense: AdviceMoneySchema,
    flexibleAmount: AdviceMoneySchema,
    /** Transactions below the small-spend threshold in flexible categories. */
    smallFrequentCount: AdviceCountSchema,
    smallFrequentAmount: AdviceMoneySchema,
    parents: z.array(AdviceHabitParentSchema).max(4),
  })
  .strict();
export type AdviceSpendingHabitsGroup = z.infer<
  typeof AdviceSpendingHabitsGroupSchema
>;

export const AdviceBaselineRowSchema = z
  .object({
    name: AdviceCategoryNameSchema,
    currentAmount: AdviceMoneySchema,
    currentPercent: AdvicePercentSchema,
    /** Monthly average over the completed months before the current month. */
    baselineMonthlyAvg: AdviceMoneySchema,
    baselinePercent: AdvicePercentSchema,
  })
  .strict();
export type AdviceBaselineRow = z.infer<typeof AdviceBaselineRowSchema>;

export const AdvicePersonalBaselineGroupSchema = z
  .object({
    kind: z.literal('personal_baseline'),
    monthsWithData: z.number().int().min(0).max(12),
    rows: z.array(AdviceBaselineRowSchema).max(5),
  })
  .strict();
export type AdvicePersonalBaselineGroup = z.infer<
  typeof AdvicePersonalBaselineGroupSchema
>;

export const AdviceGoalRowSchema = z
  .object({
    name: AdviceCategoryNameSchema,
    targetAmount: AdviceMoneySchema,
    savedAmount: AdviceMoneySchema,
    /** Share of the target already funded, 0-100. */
    progressPercent: AdvicePercentSchema,
    monthsLeft: z.number().int().min(0).max(600).nullable(),
    requiredPerMonth: AdviceMoneySchema.nullable(),
  })
  .strict();
export type AdviceGoalRow = z.infer<typeof AdviceGoalRowSchema>;

export const AdviceGoalsGroupSchema = z
  .object({
    kind: z.literal('goals_status'),
    activeCount: z.number().int().min(0).max(50),
    /** Sum of what every goal needs each month, when deadlines are known. */
    totalRequiredPerMonth: AdviceMoneySchema,
    rows: z.array(AdviceGoalRowSchema).max(5),
  })
  .strict();
export type AdviceGoalsGroup = z.infer<typeof AdviceGoalsGroupSchema>;

export const AdviceIncomeSourceSchema = z
  .object({
    name: AdviceCategoryNameSchema,
    amount: AdviceMoneySchema,
    count: AdviceCountSchema,
    /** Share of income in the same window, 0-100. */
    percentPercent: AdvicePercentSchema,
  })
  .strict();
export type AdviceIncomeSource = z.infer<typeof AdviceIncomeSourceSchema>;

export const AdviceIncomeSourcesGroupSchema = z
  .object({
    kind: z.literal('income_sources'),
    rangeKind: AdviceRangeKindSchema,
    from: IsoDateSchema,
    to: IsoDateSchema,
    monthsWithData: z.number().int().min(0).max(12),
    totalIncome: AdviceMoneySchema,
    sources: z.array(AdviceIncomeSourceSchema).max(5),
  })
  .strict();
export type AdviceIncomeSourcesGroup = z.infer<
  typeof AdviceIncomeSourcesGroupSchema
>;

export const AdviceRiskFlagSchema = z.enum([
  'DEBT_STRESS',
  'NO_INCOME_RECORDED',
]);
export type AdviceRiskFlag = z.infer<typeof AdviceRiskFlagSchema>;
export const AdviceDataQualityFlagSchema = z.enum([
  'FEW_MONTHS',
  'LESS_THAN_3_MONTHS',
  'MANY_UNCATEGORIZED',
  'HIGH_VARIANCE',
]);
export type AdviceDataQualityFlag = z.infer<typeof AdviceDataQualityFlagSchema>;

export const AdviceRiskContextGroupSchema = z
  .object({
    kind: z.literal('risk_context'),
    monthsWithData: z.number().int().min(0).max(12),
    riskFlags: z.array(AdviceRiskFlagSchema).max(4),
    dataQuality: z.array(AdviceDataQualityFlagSchema).max(4),
  })
  .strict();
export type AdviceRiskContextGroup = z.infer<
  typeof AdviceRiskContextGroupSchema
>;

const AdviceScheduledDueGroupSchema = z
  .object({
    kind: z.literal('scheduled_due'),
    asOf: IsoDateSchema,
    through: IsoDateSchema,
    totalCount: AdviceCountSchema,
    items: z
      .array(
        z
          .object({
            kind: z.enum(['income', 'expense', 'transfer']),
            amount: AdviceMoneySchema,
            dueOn: IsoDateSchema,
            status: z.literal('scheduled'),
            paymentStatus: z.literal('unknown'),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();

const AdviceClassificationGroupSchema = z
  .object({
    kind: z.literal('classification_status'),
    rangeKind: AdviceRangeKindSchema,
    from: IsoDateSchema,
    to: IsoDateSchema,
    expenseCount: AdviceCountSchema,
    expenseAmount: AdviceMoneySchema,
    incomeCount: AdviceCountSchema,
    incomeAmount: AdviceMoneySchema,
  })
  .strict();

export const AdviceDataGroupSchema = z.discriminatedUnion('kind', [
  AdviceExpenseGroupSchema,
  AdviceBudgetGroupSchema,
  AdviceSpendingHabitsGroupSchema,
  AdvicePersonalBaselineGroupSchema,
  AdviceGoalsGroupSchema,
  AdviceIncomeSourcesGroupSchema,
  AdviceRiskContextGroupSchema,
  AdviceScheduledDueGroupSchema,
  AdviceClassificationGroupSchema,
]);
export type AdviceDataGroup = z.infer<typeof AdviceDataGroupSchema>;

/**
 * The plan stage only picks which groups the device should compute; it never
 * carries amounts. The complete stage returns the filled shapes above.
 */
export const AdviceGroupSelectionSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('scheduled_due'), through: IsoDateSchema })
    .strict(),
  z
    .object({
      kind: z.literal('classification_status'),
      rangeKind: AdviceRangeKindSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('expense_by_category'),
      rangeKind: AdviceRangeKindSchema,
    })
    .strict(),
  z.object({ kind: z.literal('budget_status') }).strict(),
  z
    .object({
      kind: z.literal('spending_habits'),
      rangeKind: AdviceRangeKindSchema,
    })
    .strict(),
  z.object({ kind: z.literal('personal_baseline') }).strict(),
  z.object({ kind: z.literal('goals_status') }).strict(),
  z
    .object({
      kind: z.literal('income_sources'),
      rangeKind: AdviceRangeKindSchema,
    })
    .strict(),
  /** Always signed by the proxy so data quality and stress flags always travel. */
  z.object({ kind: z.literal('risk_context') }).strict(),
]);
export type AdviceGroupSelection = z.infer<typeof AdviceGroupSelectionSchema>;

export const AdvicePlanSelectionSchema = z
  .object({
    metrics: z
      .array(AdviceMetricSchema)
      .max(8)
      .refine((items) => new Set(items).size === items.length),
    scenario: AdviceScenarioSchema,
    groups: z
      .array(AdviceGroupSelectionSchema)
      .max(3)
      .refine(
        (items) =>
          new Set(items.map((item) => item.kind)).size === items.length,
      )
      .optional(),
  })
  .strict()
  .refine(
    (selection) =>
      selection.metrics.length > 0 ||
      !!selection.groups?.length ||
      selection.scenario.conversationFacts !== undefined,
    {
      message: 'Select at least one metric or one data group.',
    },
  );
export type AdvicePlanSelection = z.infer<typeof AdvicePlanSelectionSchema>;

const AdviceLocaleSchema = {
  language: z.enum(['vi', 'en']).default('vi'),
  currency: z.enum(['VND', 'USD']).default('VND'),
};

export const AdvicePlanRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    question: z.string().trim().min(1).max(500),
    ...AdviceLocaleSchema,
    context: AdviceValidationContextSchema.nullish(),
    /**
     * Older app builds cannot fill the risk context group, so the proxy only
     * signs it when the client says it can return it.
     */
    supportsRiskContext: z.boolean().default(false),
    history: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120).optional(),
            role: z.enum(['user', 'assistant']),
            text: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
export type AdvicePlanRequest = z.infer<typeof AdvicePlanRequestSchema>;

export const AdvicePlanResponseSchema = z.object({
  success: z.literal(true),
  requestId: z.string().uuid(),
  planToken: z.string().min(1),
  selection: AdvicePlanSelectionSchema,
});
export type AdvicePlanResponse = z.infer<typeof AdvicePlanResponseSchema>;

export const AdviceCompleteRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    question: z.string().trim().min(1).max(500),
    ...AdviceLocaleSchema,
    context: AdviceValidationContextSchema.nullish(),
    history: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120).optional(),
            role: z.enum(['user', 'assistant']),
            text: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    planToken: z.string().min(1).max(4096),
    results: z.record(z.string(), z.number().finite().safe().nullable()),
    /** Structured groups the device filled for this plan, signed by the token. */
    dataGroups: z.array(AdviceDataGroupSchema).max(3).optional(),
  })
  .strict();
export type AdviceCompleteRequest = z.infer<typeof AdviceCompleteRequestSchema>;
