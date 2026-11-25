import { z } from 'zod';
import { AdviceValidationContextSchema } from '@pfm/contracts';
import {
  CALCULATION_VERSION,
  checkAdviceToolBatch,
  classifyAdviceScope,
  resolveAdviceToolPolicy,
  today,
  validateDate,
  type AdviceToolPolicy,
  type AgentVerifiedToolRecord,
} from '@pfm/domain';
import { AppError } from '../errors/app-error';
import { scanPii } from './pii-scanner';
import { checkQuestionWithState } from './check-question-with-state';

const id = z.string().trim().min(1).max(128);
const reference = z.object({ id, name: z.string().min(1).max(120) }).strict();
export const AgentTurnMetadataSchema = z
  .object({
    version: z.literal(1),
    turnId: id,
    userMessageId: id,
    sessionId: id.max(64),
    scenarioId: id.max(64).nullable(),
    stateRevision: z.number().int().safe().nonnegative(),
    language: z.enum(['vi', 'en']),
    currency: z.enum(['VND', 'USD']),
    context: AdviceValidationContextSchema.optional(),
    categories: z.array(reference).max(32).optional(),
    budgets: z.array(reference).max(32).optional(),
  })
  .strict();
export const AgentCallSchema = z
  .object({
    id,
    type: z.literal('function'),
    function: z.object({ name: id, arguments: z.string().max(4000) }).strict(),
  })
  .strict();
export const AgentMessageSchema = z.discriminatedUnion('role', [
  z
    .object({ role: z.literal('user'), content: z.string().min(1).max(500) })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string().max(8192).nullable().optional(),
      tool_calls: z.array(AgentCallSchema).min(1).max(2),
    })
    .strict(),
  z
    .object({
      role: z.literal('tool'),
      tool_call_id: id,
      content: z.string().min(1).max(8192),
    })
    .strict(),
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type AgentCall = z.infer<typeof AgentCallSchema>;
export type AgentTurnMetadata = z.infer<typeof AgentTurnMetadataSchema>;

/** Safety checks precede context-based topic resolution and permission selection. */
export async function resolveTurnPolicy(
  question: string,
  turn: AgentTurnMetadata,
  requestedTools: string[],
) {
  const context = turn.context ?? null;
  if (
    context &&
    (context.sessionId !== turn.sessionId ||
      context.revision !== turn.stateRevision ||
      context.activeScenario.id !== turn.scenarioId ||
      context.activeScenario.currency !== turn.currency)
  )
    throw AppError.badRequest('Bối cảnh không khớp lượt.');
  for (const text of [
    question,
    ...(context?.sourceMessages.map((message) => message.text) ?? []),
    ...(turn.categories?.map((item) => item.name) ?? []),
    ...(turn.budgets?.map((item) => item.name) ?? []),
  ]) {
    if (scanPii(text).hasPii) throw AppError.piiDetected();
    const scope = classifyAdviceScope(text);
    if (scope.status === 'out_of_scope') throw AppError.outOfScope();
    if (scope.status === 'restricted') throw AppError.restricted();
  }
  const check = await checkQuestionWithState(question, context, {
    language: turn.language,
  });
  if (check.status === 'rejected') {
    if (check.reason === 'PII') throw AppError.piiDetected();
    if (check.reason === 'OUT_OF_SCOPE') throw AppError.outOfScope();
    if (check.reason === 'RESTRICTED') throw AppError.restricted();
    throw AppError.badRequest('Bối cảnh không hợp lệ.');
  }
  if (check.status !== 'allowed') throw AppError.ambiguous();
  const scenarioTopic = z
    .enum([
      'savings_plan',
      'spending_overview',
      'purchase_affordability',
      'loan_estimate',
      'budget_review',
      'general',
    ])
    .safeParse(context?.activeScenario.topic);
  return resolveAdviceToolPolicy({
    question,
    today: today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' }),
    sessionId: turn.sessionId,
    scenarioId: turn.scenarioId,
    stateRevision: turn.stateRevision,
    ...(turn.categories ? { categories: turn.categories } : {}),
    ...(turn.budgets ? { budgets: turn.budgets } : {}),
    ...(scenarioTopic.success ? { scenarioTopic: scenarioTopic.data } : {}),
    requestedTools,
  });
}

export function checkTurnBatch(policy: AdviceToolPolicy, calls: AgentCall[]) {
  return checkAdviceToolBatch(
    policy,
    policy,
    calls.map((call) => {
      let params: unknown;
      try {
        params = JSON.parse(call.function.arguments);
      } catch {
        params = null;
      }
      return { id: call.id, name: call.function.name, params };
    }),
  );
}

const amount = z.number().int().safe();
const nonnegative = amount.nonnegative();
const date = z.string().refine((value) => {
  try {
    validateDate(value);
    return true;
  } catch {
    return false;
  }
});
const dataSchemas = {
  plan_savings_goal: z
    .object({
      monthlyAvailable: amount,
      requiredMonthlySaving: nonnegative,
      remainingAfterSaving: amount,
      months: z.number().int().positive().safe(),
      goalAmount: nonnegative,
      savingsForGoal: nonnegative,
    })
    .strict(),
  get_transactions: z
    .object({
      transactions: z
        .array(
          z
            .object({
              id,
              date,
              amount,
              currency: z.literal('VND'),
              kind: z.string().min(1).max(32),
              category_id: id.nullable(),
            })
            .strict(),
        )
        .max(20),
      truncated: z.boolean(),
    })
    .strict(),
  calculate_budget_status: z
    .object({
      budgets: z.array(
        z
          .object({
            id,
            category_id: id.nullable(),
            limit_amount: nonnegative,
            spent_amount: nonnegative,
            remaining_amount: nonnegative,
            overspent_amount: nonnegative,
          })
          .strict(),
      ),
    })
    .strict(),
  get_financial_snapshot: z
    .object({
      indicators: z.record(
        z.string(),
        z
          .number()
          .finite()
          .min(-Number.MAX_SAFE_INTEGER)
          .max(Number.MAX_SAFE_INTEGER)
          .nullable(),
      ),
      period: z.object({ from: date, to: date }).strict(),
      currency: z.enum(['VND', 'USD']),
      dataQuality: z.enum(['complete', 'partial', 'insufficient']),
    })
    .strict(),
};
const resultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      data: z.unknown(),
      stateRevision: z.number().int().safe().nonnegative(),
      calculationVersion: z.literal(CALCULATION_VERSION),
      truncated: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('needs_clarification'),
      fields: z.array(id).min(1).max(32),
    })
    .strict(),
  z
    .object({
      status: z.literal('error'),
      code: z.enum([
        'INVALID_PARAMS',
        'TIMEOUT',
        'TOOL_NOT_ALLOWED',
        'DATA_ERROR',
        'STATE_ERROR',
      ]),
      retryable: z.boolean(),
    })
    .strict(),
]);

/** Validate structure and the granted read bounds, never claim to verify local SQLite truth. */
function validateResult(
  call: AgentCall,
  raw: string,
  policy: AdviceToolPolicy,
) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw AppError.badRequest('Kết quả công cụ không hợp lệ.');
  }
  const result = resultSchema.safeParse(value);
  if (!result.success)
    throw AppError.badRequest('Kết quả công cụ không hợp lệ.');
  if (result.data.status !== 'ok') return result.data;
  if (
    result.data.stateRevision !== policy.stateRevision ||
    !Object.hasOwn(dataSchemas, call.function.name)
  )
    throw AppError.badRequest('Phiên bản kết quả công cụ không hợp lệ.');
  const parsed = dataSchemas[
    call.function.name as keyof typeof dataSchemas
  ].safeParse(result.data.data);
  if (!parsed.success)
    throw AppError.badRequest('Dữ liệu công cụ không hợp lệ.');
  const params = JSON.parse(call.function.arguments);
  if (call.function.name === 'get_transactions') {
    const data = dataSchemas.get_transactions.parse(parsed.data);
    if (
      data.transactions.length > (params.limit ?? 20) ||
      data.transactions.some(
        (row) =>
          row.date < params.from ||
          row.date > params.to ||
          (params.kind != null && row.kind !== params.kind) ||
          (params.category_id != null &&
            row.category_id !== params.category_id),
      )
    )
      throw AppError.badRequest('Giao dịch vượt quyền đã cấp.');
  }
  if (
    call.function.name === 'calculate_budget_status' &&
    params.budget_id != null &&
    dataSchemas.calculate_budget_status
      .parse(parsed.data)
      .budgets.some((row) => row.id !== params.budget_id)
  )
    throw AppError.badRequest('Ngân sách vượt quyền đã cấp.');
  if (call.function.name === 'get_financial_snapshot') {
    const data = dataSchemas.get_financial_snapshot.parse(parsed.data);
    if (
      Object.keys(data.indicators).length !== params.fields.length ||
      Object.keys(data.indicators).some(
        (field) => !params.fields.includes(field),
      ) ||
      data.period.from > data.period.to
    )
      throw AppError.badRequest('Chỉ số vượt quyền đã cấp.');
  }
  return result.data;
}

/** Only append the complete result batch following the last server-signed assistant message. */
export function inspectTurnTranscript(
  messages: AgentMessage[],
  policy: AdviceToolPolicy,
  continuing: boolean,
  cancelling = false,
) {
  if (
    messages[0]?.role !== 'user' ||
    messages.slice(1).some((message) => message.role === 'user')
  )
    throw AppError.badRequest('Mỗi lượt chỉ có một câu người dùng.');
  if (!continuing && messages.length !== 1)
    throw AppError.badRequest('Lượt mới không nhận lịch sử có sẵn.');
  const ids = new Set<string>();
  let successfulTools = 0;
  const verifiedTools: AgentVerifiedToolRecord[] = [];
  let deniedBatches = 0;
  let prefixEnd = 1;
  let pendingFields: string[] = [];
  let failureCode: string | null = null;
  for (let index = 1; index < messages.length;) {
    const message = messages[index];
    if (message.role !== 'assistant')
      throw AppError.badRequest('Thiếu lời gọi công cụ.');
    if (message.content && scanPii(message.content).hasPii)
      throw AppError.piiDetected();
    const calls = message.tool_calls;
    const decision = checkTurnBatch(policy, calls);
    prefixEnd = index + 1;
    // A signed pending assistant batch is sufficient to cancel; no tool must execute to close it.
    if (cancelling && prefixEnd === messages.length) break;
    const results = messages.slice(prefixEnd, prefixEnd + calls.length);
    if (
      results.length !== calls.length ||
      results.some((result) => result.role !== 'tool') ||
      new Set(
        results.map((result) =>
          result.role === 'tool' ? result.tool_call_id : '',
        ),
      ).size !== calls.length
    )
      throw AppError.badRequest('Kết quả batch thiếu hoặc trùng.');
    for (const call of calls) {
      if (ids.has(call.id)) throw AppError.badRequest('Mã công cụ bị trùng.');
      ids.add(call.id);
      const result = results.find(
        (result) => result.role === 'tool' && result.tool_call_id === call.id,
      );
      if (!result || result.role !== 'tool')
        throw AppError.badRequest('Mã kết quả không khớp.');
      if (!decision.allowed) {
        const expected = {
          status: 'error',
          code: decision.code,
          retryable: false,
        };
        let actual: unknown;
        try {
          actual = JSON.parse(result.content);
        } catch {
          throw AppError.badRequest('Batch bị từ chối.');
        }
        if (
          !actual ||
          typeof actual !== 'object' ||
          Array.isArray(actual) ||
          Object.keys(actual).length !== 3 ||
          Object.entries(expected).some(
            ([key, value]) =>
              (actual as Record<string, unknown>)[key] !== value,
          )
        )
          throw AppError.badRequest(
            'Batch bị từ chối không được trả thành công.',
          );
      } else {
        const validated = validateResult(call, result.content, policy);
        if (validated.status === 'error') failureCode ??= validated.code;
        if (validated.status === 'ok') {
          successfulTools++;
          verifiedTools.push({
            name: call.function.name,
            params: JSON.parse(call.function.arguments),
            data: dataSchemas[
              call.function.name as keyof typeof dataSchemas
            ].parse(validated.data),
          } as AgentVerifiedToolRecord);
        }
        if (validated.status === 'needs_clarification')
          pendingFields.push(...validated.fields);
      }
    }
    deniedBatches = decision.allowed ? 0 : deniedBatches + 1;
    if (
      (pendingFields.length || failureCode) &&
      prefixEnd + calls.length !== messages.length
    )
      throw AppError.badRequest('Lượt cần làm rõ phải đóng ngay.');
    index = prefixEnd + calls.length;
  }
  if (continuing && prefixEnd === 1)
    throw AppError.badRequest('Thiếu tiền tố để tiếp tục.');
  return {
    prefix: messages.slice(0, prefixEnd),
    successfulTools,
    verifiedTools,
    deniedBatches,
    pendingFields: [...new Set(pendingFields)],
    failureCode,
  };
}
