import { z } from 'zod';
import {
  GetTransactionsParamsSchema,
  CalculateBudgetStatusParamsSchema,
  PlanSavingsGoalParamsSchema,
  GetFinancialSnapshotParamsSchema,
  isMoneyFact,
  type ConversationState,
  type ToolResult,
} from '@pfm/contracts';
import { classifyAdviceScope, isUnsafeAdviceAnswer } from '@pfm/domain';
import {
  createTransportCapture,
  readTransportBody,
  recordTransportError,
  watchTransportAborts,
  type TransportCapture,
} from './transport-diagnostics';

export const caseIds = [
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'D1',
  'D2',
  'D3',
  'C1',
  'C2',
] as const;
export type CaseId = (typeof caseIds)[number];
const schemas = {
  get_transactions: GetTransactionsParamsSchema,
  calculate_budget_status: CalculateBudgetStatusParamsSchema,
  plan_savings_goal: PlanSavingsGoalParamsSchema,
  get_financial_snapshot: GetFinancialSnapshotParamsSchema,
};
export type ToolName = keyof typeof schemas;
export interface EvalCase {
  id: CaseId;
  question: string;
  requiredTools: { name: ToolName; params: Record<string, unknown> }[];
  missing?: string;
}
export interface StepRequest {
  model: string;
  messages: Record<string, unknown>[];
  allowedTools: string[];
  allowTools: boolean;
  stream: boolean;
}
export interface RunnerOptions {
  model: string;
  step(body: StepRequest, signal: AbortSignal): Promise<Response>;
  executeTool(
    name: string,
    params: unknown,
    allowed: string[],
    context: {
      sessionId: string;
      stateRevision: number;
      state: ConversationState;
      deadline: number;
    },
  ): Promise<ToolResult>;
  now?: () => number;
  timeouts?: { modelCallMs: number; turnMs: number };
}
export interface CaseReport {
  id: CaseId;
  passed: boolean;
  correctTools: boolean;
  businessCorrect: boolean;
  validCalls: number;
  totalCalls: number;
  fallback: boolean;
  protocolError: boolean;
  needsReview: boolean;
  latencyMs: number;
  modelCalls: number;
  sseValid: boolean | null;
  sseEvents: number;
  text: string;
  clarificationFields: string[];
  error?: string;
  parameterDifferences: string[];
  rawResponses: { status: number; body: string }[];
  transport: (TransportCapture & { allowTools: boolean })[];
  observations: { name: string; params: unknown; result: ToolResult }[];
  returnedModels: string[];
  usage: { input: number | null; output: number | null; missingCalls: number };
}
const snapshot = {
  name: 'get_financial_snapshot' as const,
  params: { months: 6, fields: ['monthly_income_avg', 'monthly_expense_avg'] },
};
const budget = {
  name: 'calculate_budget_status' as const,
  params: { month: '2026-11', budget_id: 'budget-food' },
};
const saving = { name: 'plan_savings_goal' as const, params: {} };
const transactions = {
  name: 'get_transactions' as const,
  params: {
    from: '2026-11-01',
    to: '2026-11-16',
    kind: 'expense',
    category_id: 'cat-food',
    limit: 3,
  },
};
const expectations: Record<CaseId, EvalCase['requiredTools']> = {
  S1: [snapshot],
  S2: [budget],
  S3: [saving],
  S4: [transactions],
  S5: [saving],
  D1: [snapshot, budget],
  D2: [budget, transactions],
  D3: [
    saving,
    {
      name: 'get_financial_snapshot',
      params: { months: 6, fields: ['liquid_balance'] },
    },
  ],
  C1: [saving],
  C2: [saving],
};

/** Load question text verbatim from the agreed document; never silently substitute easier wording. */
export function loadToolCallingCases(markdown: string): EvalCase[] {
  return caseIds.map((id) => {
    const section = markdown.match(
      new RegExp(`### ${id} [^\\n]*\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`),
    )?.[1];
    const question = section?.match(/\*\*Câu hỏi:\*\* “([^”]+)”/)?.[1];
    if (!question) throw new Error(`MISSING_CASE_${id}`);
    return {
      id,
      question,
      requiredTools: structuredClone(expectations[id]),
      ...(id === 'C1'
        ? { missing: 'savingsForGoal' }
        : id === 'C2'
          ? { missing: 'savingsMonths' }
          : {}),
    };
  });
}

/** Model extraction is not under test: preload verified synthetic facts, including the S5 chain. */
export function createEvalState(testCase: EvalCase): ConversationState {
  const unknown = { status: 'unknown' as const };
  const facts: ConversationState['facts'] = [
    {
      id: 'fact-income-15m',
      kind: 'income',
      amount: 15_000_000,
      period: 'monthly',
      currency: 'VND',
      mode: 'actual',
      source: 'user_statement',
      source_message_id: testCase.id === 'S5' ? 'before' : 'current',
    },
    {
      id: 'fact-expense',
      kind: 'expense',
      amount: 10_000_000,
      period: 'monthly',
      currency: 'VND',
      mode: 'actual',
      source: 'user_statement',
      source_message_id: 'current',
      includes: ['debt'],
    },
    {
      id: 'fact-goal',
      kind: 'saving_goal',
      amount: 24_000_000,
      period: 'one_off',
      currency: 'VND',
      mode: 'actual',
      source: 'user_statement',
      source_message_id: 'current',
    },
    ...(testCase.id === 'C1'
      ? []
      : [
          {
            id: 'fact-saved',
            kind: 'savingsForGoal' as const,
            amount: 0,
            period: 'one_off' as const,
            currency: 'VND' as const,
            mode: 'actual' as const,
            source: 'user_statement' as const,
            source_message_id: 'current',
          },
        ]),
    ...(testCase.id === 'C2'
      ? []
      : [
          {
            id: 'fact-months',
            kind: 'savings_months' as const,
            months: 6,
            mode: 'actual' as const,
            source: 'user_statement' as const,
            source_message_id: 'current',
          },
        ]),
  ];
  const known = <T,>(value: T, id: string) => ({
    status: 'known' as const,
    value,
    factIds: [id],
    sourceMessageIds: [
      facts.find((fact) => fact.id === id)?.source_message_id ?? 'current',
    ],
    source: 'user_statement' as const,
  });
  if (testCase.id === 'S5' && isMoneyFact(facts[0]))
    facts.push({
      ...facts[0],
      id: 'fact-income-12m',
      amount: 12_000_000,
      source_message_id: 'current',
      supersedes_id: 'fact-income-15m',
    });
  const incomeId = testCase.id === 'S5' ? 'fact-income-12m' : 'fact-income-15m';
  return {
    version: 1,
    sessionId: `eval-${testCase.id}`,
    revision: testCase.id === 'S5' ? 2 : 1,
    facts,
    pendingFields: testCase.missing ? [testCase.missing] : [],
    updatedAt: '2026-11-16T00:00:00.000Z',
    activeScenario: {
      id: 'scenario-save',
      topic: 'savings_plan',
      mode: 'actual',
      currency: 'VND',
      cashFlowBasis: known<'monthly'>('monthly', incomeId),
      observationRange: unknown,
      income: known(testCase.id === 'S5' ? 12_000_000 : 15_000_000, incomeId),
      expenseTotal: known(10_000_000, 'fact-expense'),
      expenseIncludes: known<('housing' | 'debt' | 'food')[]>(
        ['debt'],
        'fact-expense',
      ),
      expenseItems: [],
      debtMonthlyPayments: [],
      debtOutstanding: unknown,
      goalTarget: known(24_000_000, 'fact-goal'),
      monthlySavingsGoal: unknown,
      savingsForGoal: testCase.id === 'C1' ? unknown : known(0, 'fact-saved'),
      savingsMonths: testCase.id === 'C2' ? unknown : known(6, 'fact-months'),
      purchasePrice: unknown,
      monthlyPayment: unknown,
      paymentMonths: unknown,
    },
  };
}
function messagesFor(
  testCase: EvalCase,
  state: ConversationState,
): Record<string, unknown>[] {
  const context = {
    referenceDate: '2026-11-16',
    timeZone: 'Asia/Ho_Chi_Minh',
    currency: 'VND',
    defaultSnapshotMonths: 6,
    categories: { 'cat-food': 'Ăn uống' },
    budgets: { 'budget-food': 'Ăn uống' },
  };
  const messages: Record<string, unknown>[] = [
    { role: 'user', content: JSON.stringify(context) },
  ];
  if (testCase.id === 'S5')
    messages.push(
      {
        role: 'user',
        content: 'Thu nhập 15tr, chi 10tr, mục tiêu 24tr trong 6 tháng',
      },
      {
        role: 'assistant',
        content:
          'Kế hoạch tiết kiệm trước đó đã được tính từ dữ kiện bạn cung cấp.',
      },
    );
  if (
    testCase.requiredTools.some((tool) => tool.name === 'plan_savings_goal')
  ) {
    const slots = state.activeScenario;
    messages.push({
      role: 'user',
      content: `Dữ kiện đã xác minh cho công cụ tiết kiệm: ${JSON.stringify(
        Object.fromEntries(
          [
            'income',
            'expenseTotal',
            'goalTarget',
            'savingsForGoal',
            'savingsMonths',
          ].map((key) => {
            const slot = slots[key as 'income'];
            return [key, slot.status === 'known' ? slot.value : 'unknown'];
          }),
        ),
      )}. Cơ sở tháng, chi đã gồm trả nợ. Không tự điền trường unknown.`,
    });
  }
  messages.push({ role: 'user', content: testCase.question });
  return messages;
}
function equalParams(actual: unknown, expected: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? [...value].sort()
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, val]) => [key, canonical(val)]),
          )
        : value;
  return (
    JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected))
  );
}
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/(?<=\d)[.,](?=\d{3}(?:[.,]\d{3})*(?!\d))/g, '')
    .replace(/(\d),(\d)/g, '$1.$2');
function amountPattern(amount: number): string {
  const positive = Math.abs(amount);
  const number = (value: number) => String(value).replace('.', '\\.');
  const alternatives = [
    String(positive),
    `${number(positive / 1_000_000)}\\s*(?:trieu|tr)\\b`,
    `${number(positive / 1000)}\\s*(?:nghin|ngan|k)\\b`,
  ];
  // Accept sentence punctuation while rejecting a partial numeric match.
  const pattern = `(?:${alternatives.join('|')})(?!\\d|\\.\\d)`;
  return amount < 0
    ? `(?:-\\s*|am\\s+|thieu(?:\\s+hut)?\\s+)${pattern}`
    : pattern;
}
const valueRules = {
  income: ['thu nhap|thu', 15_000_000],
  expense: ['chi tieu|chi', 10_000_000],
  limit: ['han muc|ngan sach', 3_000_000],
  spent: ['da chi|da dung|chi thuc te|da tieu', 3_500_000],
  zero: ['con lai|con trong han muc|con', 0],
  over: ['vuot|boi chi', 500_000],
  available: [
    'du truoc muc tieu|du truoc tiet kiem|kha dung hang thang',
    5_000_000,
  ],
  required: [
    'can danh|can de danh|can tiet kiem|muc tiet kiem can|tiet kiem can thiet',
    4_000_000,
  ],
  remaining: ['con lai sau|con sau|con lai', 1_000_000],
  liquid: ['so du kha dung|so du hien tai|so du vi', 12_000_000],
} as const;

/** Conservative labelled-number rubric: uncertain prose is reviewed, never automatically passed. */
export function gradeFinalBusiness(testCase: EvalCase, text: string): boolean {
  const normalized = fold(text);
  const scope = classifyAdviceScope(text);
  if (
    scope.status === 'restricted' ||
    scope.status === 'out_of_scope' ||
    isUnsafeAdviceAnswer(text) ||
    /%|\busd\b|\$/.test(normalized)
  )
    return false;
  const groups: Record<CaseId, (keyof typeof valueRules)[]> = {
    S1: ['income', 'expense'],
    S2: ['limit', 'spent', 'zero', 'over'],
    S3: ['available', 'required', 'remaining'],
    S4: [],
    S5: ['required'],
    D1: ['income', 'expense', 'limit', 'spent', 'over'],
    D2: ['over'],
    D3: ['required', 'remaining', 'liquid'],
    C1: [],
    C2: [],
  };
  const labelled = (label: string, amount: number) => {
    const match = new RegExp(
      `(?:${label})([^\\d.!?;\\n]{0,45})${amountPattern(amount)}`,
      'i',
    ).exec(normalized);
    return !!match && (amount < 0 || !/\bam\b|\bthieu\b|-/.test(match[1]));
  };
  if (
    !groups[testCase.id].every((key) =>
      labelled(valueRules[key][0], valueRules[key][1]),
    )
  )
    return false;
  if (
    ['S1', 'D1'].includes(testCase.id) &&
    !(
      /trung binh/.test(normalized) &&
      /6\s+thang|2026-05-01.*2026-10-31/.test(normalized)
    )
  )
    return false;
  if (['S3', 'S5', 'D3'].includes(testCase.id) && !/thang/.test(normalized))
    return false;
  if (
    testCase.id === 'S5' &&
    !(
      labelled(
        'du truoc muc tieu|du truoc tiet kiem|(?:so tien )?kha dung (?:moi|hang) thang',
        2_000_000,
      ) && labelled('con lai sau|con sau|con lai', -2_000_000)
    )
  )
    return false;
  if (['S4', 'D2'].includes(testCase.id)) {
    const patterns = [500_000, 2_000_000, 1_000_000].map(amountPattern);
    if (!new RegExp(patterns.join('[\\s\\S]*?')).test(normalized)) return false;
    if (testCase.id === 'S4' && /\btong\b/.test(normalized)) return false;
  }
  const moneyByCase: Record<CaseId, number[]> = {
    S1: [15_000_000, 10_000_000],
    S2: [3_000_000, 3_500_000, 0, 500_000],
    S3: [
      15_000_000, 10_000_000, 24_000_000, 0, 5_000_000, 4_000_000, 1_000_000,
    ],
    S4: [500_000, 2_000_000, 1_000_000],
    S5: [12_000_000, 10_000_000, 24_000_000, 0, 2_000_000, 4_000_000],
    D1: [15_000_000, 10_000_000, 3_000_000, 3_500_000, 0, 500_000],
    D2: [3_000_000, 3_500_000, 0, 500_000, 2_000_000, 1_000_000],
    D3: [
      15_000_000, 10_000_000, 24_000_000, 0, 5_000_000, 4_000_000, 1_000_000,
      12_000_000,
    ],
    C1: [],
    C2: [],
  };
  const allowed = new Set(moneyByCase[testCase.id]);
  for (const match of normalized.matchAll(
    /(-?\d+(?:\.\d+)?)\s*(trieu|tr|nghin|ngan|k|dong|vnd)\b/g,
  )) {
    const multiplier = /^(trieu|tr)$/.test(match[2])
      ? 1_000_000
      : /^(nghin|ngan|k)$/.test(match[2])
        ? 1000
        : 1;
    if (!allowed.has(Math.abs(Number(match[1]) * multiplier))) return false;
  }
  return text.trim().length > 0;
}

const EnvelopeSchema = z.object({
  model: z.string().optional(),
  usage: z
    .object({ prompt_tokens: z.number(), completion_tokens: z.number() })
    .optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.literal('tool_calls'),
        message: z.object({
          role: z.literal('assistant'),
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1).max(128),
                type: z.literal('function'),
                function: z.object({
                  name: z.string(),
                  arguments: z.string().max(4000),
                }),
              }),
            )
            .min(1)
            .max(2),
        }),
      }),
    )
    .min(1),
});

/** Run one bounded turn against /step, executing only validated, permitted local tools. */
export async function runToolCallingCase(
  testCase: EvalCase,
  options: RunnerOptions,
): Promise<CaseReport> {
  const now = options.now ?? (() => performance.now());
  const start = now();
  const timeouts = options.timeouts ?? { modelCallMs: 15_000, turnMs: 30_000 };
  if (
    ![timeouts.modelCallMs, timeouts.turnMs].every(
      (ms) => Number.isSafeInteger(ms) && ms > 0,
    )
  )
    throw new RangeError('Invalid measurement timeouts');
  const deadline = start + timeouts.turnMs;
  const state = createEvalState(testCase);
  const messages = messagesFor(testCase, state);
  const allowed = testCase.requiredTools.map((tool) => tool.name);
  const report: CaseReport = {
    id: testCase.id,
    passed: false,
    correctTools: false,
    businessCorrect: false,
    validCalls: 0,
    totalCalls: 0,
    fallback: false,
    protocolError: false,
    needsReview: false,
    latencyMs: 0,
    modelCalls: 0,
    sseValid: null,
    sseEvents: 0,
    text: '',
    clarificationFields: [],
    parameterDifferences: [],
    rawResponses: [],
    transport: [],
    observations: [],
    returnedModels: [],
    usage: { input: 0, output: 0, missingCalls: 0 },
  };
  const stop = (error: string, protocol = false) => {
    report.error = error;
    report.protocolError = protocol;
    report.fallback = true;
    return report;
  };
  const recordUsage = (usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  }) => {
    if (usage) {
      report.usage.input = (report.usage.input ?? 0) + usage.prompt_tokens;
      report.usage.output =
        (report.usage.output ?? 0) + usage.completion_tokens;
      report.usage.missingCalls--;
    }
  };
  const send = async (allowTools: boolean) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('TURN_TIMEOUT');
    report.modelCalls++;
    report.usage.missingCalls++;
    const capture = { ...createTransportCapture(now), allowTools };
    report.transport.push(capture);
    const signal = AbortSignal.timeout(
      Math.max(1, Math.min(timeouts.modelCallMs, Math.floor(remaining))),
    );
    const cleanup = watchTransportAborts(
      capture,
      [{ source: 'runner', signal }],
      now,
    );
    try {
      const response = await options.step(
        {
          model: options.model,
          messages,
          allowedTools: allowed,
          allowTools,
          stream: !allowTools,
        },
        signal,
      );
      const body = await readTransportBody(response, capture, now);
      report.rawResponses.push({ status: response.status, body });
      if (now() >= deadline) throw new Error('TURN_TIMEOUT');
      return { response, body };
    } catch (error) {
      if (!capture.error) recordTransportError(capture, error, now);
      throw error;
    } finally {
      cleanup();
    }
  };
  try {
    const completed = new Set<string>();
    const seenIds = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const { response, body } = await send(true);
      if (!response.ok) return stop(`HTTP_${response.status}`, true);
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        return stop('INVALID_JSON', true);
      }
      const metadata = EnvelopeSchema.pick({
        model: true,
        usage: true,
      }).safeParse(raw);
      if (metadata.success) {
        recordUsage(metadata.data.usage);
        if (metadata.data.model)
          report.returnedModels.push(metadata.data.model);
      }
      const parsed = EnvelopeSchema.safeParse(raw);
      if (!parsed.success) return stop('NON_STANDARD_TOOL_CALLS', true);
      const data = parsed.data;
      const message = data.choices[0].message;
      const calls = message.tool_calls;
      report.totalCalls += calls.length;
      const validated = calls.map((call) => {
        if (!Object.hasOwn(schemas, call.function.name)) return null;
        try {
          const parsed = schemas[call.function.name as ToolName].safeParse(
            JSON.parse(call.function.arguments),
          );
          return parsed.success ? parsed.data : null;
        } catch {
          return null;
        }
      });
      report.validCalls += validated.filter((value) => value !== null).length;
      if (
        calls.some((call) => !allowed.includes(call.function.name as ToolName))
      )
        return stop('TOOL_NOT_ALLOWED');
      if (validated.some((value) => value === null))
        return stop('INVALID_PARAMS');
      if (
        calls.some((call) => seenIds.has(call.id)) ||
        new Set(calls.map((call) => call.id)).size !== calls.length
      )
        return stop('DUPLICATE_CALL_ID', true);
      // Validate every expected parameter before reading any data from the batch.
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index];
        const name = call.function.name as ToolName;
        const expected = testCase.requiredTools.find(
          (tool) => tool.name === name,
        )!;
        const params = validated[index]!;
        const actualForComparison =
          testCase.id === 'D3' && name === 'get_financial_snapshot'
            ? { ...params, months: 6 }
            : params;
        if (
          !equalParams(
            actualForComparison,
            schemas[name].parse(expected.params),
          )
        )
          return stop('WRONG_PARAMS');
        if (!equalParams(params, schemas[name].parse(expected.params)))
          report.parameterDifferences.push(name);
      }
      messages.push(message);
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index];
        seenIds.add(call.id);
        const name = call.function.name as ToolName;
        if (completed.has(name)) return stop('REPEATED_TOOL');
        const params = validated[index]!;
        if (now() >= deadline) return stop('TURN_TIMEOUT');
        const toolResult = await options.executeTool(name, params, allowed, {
          sessionId: state.sessionId,
          stateRevision: state.revision,
          state,
          deadline: Date.now() + Math.min(1500, deadline - now()),
        });
        report.observations.push({ name, params, result: toolResult });
        if (now() >= deadline) return stop('TURN_TIMEOUT');
        if (toolResult.status === 'error') return stop(toolResult.code);
        completed.add(name);
        if (toolResult.status === 'needs_clarification') {
          report.clarificationFields = toolResult.fields;
          report.correctTools = completed.size === allowed.length;
          report.businessCorrect =
            !!testCase.missing &&
            equalParams(toolResult.fields, [testCase.missing]);
          report.passed = report.correctTools && report.businessCorrect;
          report.fallback = !report.passed;
          report.text =
            testCase.missing === 'savingsForGoal'
              ? 'Bạn đã dành riêng bao nhiêu tiền cho mục tiêu này? Nếu chưa có, bạn có thể trả lời 0 đồng.'
              : 'Bạn muốn đạt mục tiêu này trong bao nhiêu tháng?';
          return report;
        }
        if (testCase.missing) return stop('MISSING_FACT_WAS_GUESSED');
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(toolResult),
        });
      }
      if (completed.size !== allowed.length) continue;
      report.correctTools = true;
      const final = await send(false);
      if (!final.response.ok)
        return stop(`HTTP_${final.response.status}`, true);
      let done = false;
      let finished = false;
      let finalUsage:
        { prompt_tokens: number; completion_tokens: number } | undefined;
      try {
        if (
          !final.response.headers
            .get('content-type')
            ?.startsWith('text/event-stream')
        )
          throw new Error();
        for (const event of final.body
          .split(/\r?\n\r?\n/)
          .filter((entry) => entry.trim())) {
          const payload = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!payload) continue;
          if (done) throw new Error();
          if (payload === '[DONE]') {
            done = true;
            continue;
          }
          const chunk = JSON.parse(payload);
          report.sseEvents++;
          if (chunk.error) throw new Error();
          if (chunk.usage) finalUsage = chunk.usage;
          for (const choice of chunk.choices ?? []) {
            if (
              choice.delta?.tool_calls ||
              choice.finish_reason === 'tool_calls' ||
              choice.finish_reason === 'length'
            )
              throw new Error();
            if (choice.finish_reason === 'stop') finished = true;
            if (typeof choice.delta?.content === 'string')
              report.text += choice.delta.content;
          }
        }
        if (!done || !finished || !report.text.trim()) throw new Error();
        report.sseValid = true;
      } catch {
        report.sseValid = false;
        return stop('INVALID_SSE', true);
      }
      recordUsage(finalUsage);
      report.businessCorrect = gradeFinalBusiness(testCase, report.text);
      report.needsReview = !report.businessCorrect;
      report.passed = report.businessCorrect;
      return report;
    }
    return stop('ROUND_LIMIT');
  } catch (error) {
    return stop(
      error instanceof Error && error.message === 'TURN_TIMEOUT'
        ? 'TURN_TIMEOUT'
        : 'TRANSPORT_ERROR',
      true,
    );
  } finally {
    if (report.usage.missingCalls) {
      report.usage.input = null;
      report.usage.output = null;
    }
    report.latencyMs = Math.max(0, now() - start);
  }
}
export async function runToolCallingSuite(
  cases: EvalCase[],
  options: RunnerOptions,
): Promise<CaseReport[]> {
  const reports: CaseReport[] = [];
  for (const testCase of cases) {
    const report = await runToolCallingCase(testCase, options);
    reports.push(report);
    if (report.protocolError) break;
  }
  return reports;
}
export function summarizeToolCalling(reports: CaseReport[]) {
  const turns = reports.length;
  const totalCalls = reports.reduce((sum, item) => sum + item.totalCalls, 0);
  const validCalls = reports.reduce((sum, item) => sum + item.validCalls, 0);
  const percent = (count: number, total = turns) =>
    total ? (100 * count) / total : 0;
  const latencies = reports
    .map((report) => report.latencyMs)
    .sort((a, b) => a - b);
  return {
    turns,
    totalCalls,
    validCalls,
    schemaPercent: percent(validCalls, totalCalls),
    correctToolPercent: percent(
      reports.filter((item) => item.correctTools).length,
    ),
    businessPercent: percent(
      reports.filter((item) => item.businessCorrect).length,
    ),
    fallbackPercent: percent(reports.filter((item) => item.fallback).length),
    averageLatencyMs: turns
      ? latencies.reduce((sum, time) => sum + time, 0) / turns
      : 0,
    p95LatencyMs: turns ? latencies[Math.ceil(turns * 0.95) - 1] : null,
  };
}
