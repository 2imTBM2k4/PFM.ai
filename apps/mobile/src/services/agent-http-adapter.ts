import {
  GetTransactionsParamsSchema,
  CalculateBudgetStatusParamsSchema,
  PlanSavingsGoalParamsSchema,
  GetFinancialSnapshotParamsSchema,
  GetSpendingBreakdownParamsSchema,
  GetUpcomingObligationsParamsSchema,
  GetSavingsGoalsParamsSchema,
  type AdviceValidationContext,
} from '@pfm/contracts';
import { checkAdviceToolBatch, type AdviceToolPolicy } from '@pfm/domain';
import type { AgentLoopDependencies, AgentMessage } from './advice-agent-loop';
import {
  StaleTurnError,
  AgentMessageShapeError,
  AgentPolicyError,
  AgentAuthError,
  AgentTurnInvalidError,
  AgentRateLimitError,
  AgentServerError,
  AgentNetworkError,
} from './agent-errors';
import { readAgentFinalSse, type AgentVerifiedDelta } from './agent-sse-reader';

export interface AgentTurnMetadata {
  version: 1;
  turnId: string;
  userMessageId: string;
  sessionId: string;
  scenarioId: string | null;
  stateRevision: number;
  language: 'vi' | 'en';
  currency: 'VND' | 'USD';
  context?: AdviceValidationContext;
  categories?: { id: string; name: string }[];
  budgets?: { id: string; name: string }[];
}
export interface AgentTurnTransportConfig {
  baseUrl: string;
  authHeaders?: Record<string, string>;
  fetchFn?: typeof fetch;
  turn: AgentTurnMetadata;
  getCurrentMetadata?: () =>
    | Promise<{ stateRevision: number; scenarioId: string | null }>
    | { stateRevision: number; scenarioId: string | null };
  closeTimeoutMs?: number;
  onDelta?: (delta: AgentVerifiedDelta) => void;
}
export interface AgentTurnTransport {
  selectTools: AgentLoopDependencies['selectTools'];
  finalize: AgentLoopDependencies['finalize'];
  onTurnEnd: NonNullable<AgentLoopDependencies['onTurnEnd']>;
  getLastDeadline(): number | null;
}
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const identifier = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new AgentMessageShapeError();
  return value.trim();
};
const schemas = {
  get_transactions: GetTransactionsParamsSchema,
  calculate_budget_status: CalculateBudgetStatusParamsSchema,
  plan_savings_goal: PlanSavingsGoalParamsSchema,
  get_financial_snapshot: GetFinancialSnapshotParamsSchema,
  get_spending_breakdown: GetSpendingBreakdownParamsSchema,
  get_upcoming_obligations: GetUpcomingObligationsParamsSchema,
  get_savings_goals: GetSavingsGoalsParamsSchema,
};

function normalizeMessages(messages: AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 32)
    throw new AgentMessageShapeError();
  return messages.map((message) => {
    if (!record(message)) throw new AgentMessageShapeError();
    const keys = Object.keys(message).filter(
      (key) => message[key] !== undefined,
    );
    const only = (allowed: string[]) =>
      keys.every((key) => allowed.includes(key));
    if (
      message.role === 'user' &&
      only(['role', 'content']) &&
      typeof message.content === 'string' &&
      message.content.length > 0 &&
      message.content.length <= 500
    )
      return { role: 'user', content: message.content };
    if (
      message.role === 'tool' &&
      only(['role', 'content', 'tool_call_id']) &&
      typeof message.content === 'string' &&
      message.content.length > 0 &&
      message.content.length <= 8192
    )
      return {
        role: 'tool',
        tool_call_id: identifier(message.tool_call_id, 128),
        content: message.content,
      };
    if (
      message.role === 'assistant' &&
      only(['role', 'content', 'tool_calls']) &&
      (message.content == null ||
        (typeof message.content === 'string' &&
          message.content.length <= 8192)) &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length >= 1 &&
      message.tool_calls.length <= 2
    ) {
      const calls = message.tool_calls.map((call) => {
        if (
          !record(call) ||
          Object.entries(call).some(
            ([key, value]) =>
              !['id', 'type', 'function'].includes(key) && value !== undefined,
          ) ||
          call.type !== 'function' ||
          !record(call.function) ||
          Object.entries(call.function).some(
            ([key, value]) =>
              !['name', 'arguments'].includes(key) && value !== undefined,
          ) ||
          typeof call.function.arguments !== 'string' ||
          call.function.arguments.length > 4000
        )
          throw new AgentMessageShapeError();
        return {
          id: identifier(call.id, 128),
          type: 'function' as const,
          function: {
            name: identifier(call.function.name, 128),
            arguments: call.function.arguments,
          },
        };
      });
      return {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: calls,
      };
    }
    throw new AgentMessageShapeError();
  });
}

/** Create a transport whose state belongs to one server turn. */
export function createAgentTurnTransport(
  config: AgentTurnTransportConfig,
): AgentTurnTransport {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new TypeError('INVALID_BASE_URL');
  const turn: AgentTurnMetadata = JSON.parse(JSON.stringify(config.turn));
  try {
    turn.turnId = identifier(turn.turnId, 128);
    turn.userMessageId = identifier(turn.userMessageId, 128);
    turn.sessionId = identifier(turn.sessionId, 64);
    if (turn.scenarioId !== null)
      turn.scenarioId = identifier(turn.scenarioId, 64);
    for (const refs of [turn.categories, turn.budgets])
      refs?.forEach((item) => {
        item.id = identifier(item.id, 128);
      });
  } catch {
    throw new TypeError('INVALID_TURN_METADATA');
  }
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const headers = { 'Content-Type': 'application/json', ...config.authHeaders };
  let continuationToken: string | null = null;
  let initialAllowedTools: string[] | null = null;
  let latestSignedPrefix: AgentMessage[] | null = null;
  let lastDeadline: number | null = null;
  let closedOnServer = false;
  const send = async (
    body: unknown,
    signal: AbortSignal,
    acceptSse = false,
  ) => {
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}/v1/advice/step`, {
        method: 'POST',
        headers: acceptSse
          ? { ...headers, Accept: 'text/event-stream' }
          : headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted || (record(error) && error.name === 'AbortError'))
        throw error;
      throw new AgentNetworkError();
    }
    if (!response.ok) {
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      const code =
        record(data) && typeof data.code === 'string' ? data.code : undefined;
      if (response.status === 401)
        throw code === 'INVALID_TOKEN'
          ? new AgentTurnInvalidError()
          : new AgentAuthError();
      if (response.status === 429) throw new AgentRateLimitError(code);
      throw new AgentServerError(response.status, code);
    }
    return response;
  };
  const request = async (body: unknown, signal: AbortSignal) => {
    const response = await send(body, signal);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AgentServerError(response.status);
    }
    const bodyData = record(data) ? data : {};
    return bodyData;
  };
  const validateTurn = async (
    input: Parameters<AgentLoopDependencies['selectTools']>[0],
  ) => {
    if (
      input.sessionId !== turn.sessionId ||
      input.userMessageId !== turn.userMessageId ||
      input.stateRevision !== turn.stateRevision ||
      (input.turnId !== undefined && input.turnId !== turn.turnId)
    )
      throw new StaleTurnError(input.stateRevision, turn.stateRevision);
    if (continuationToken && config.getCurrentMetadata) {
      const current = await config.getCurrentMetadata();
      if (
        current.stateRevision !== turn.stateRevision ||
        current.scenarioId !== turn.scenarioId
      )
        throw new StaleTurnError(current.stateRevision, turn.stateRevision);
    }
    if (closedOnServer) throw new AgentTurnInvalidError();
    if (
      initialAllowedTools &&
      (initialAllowedTools.length !== input.allowedTools.length ||
        initialAllowedTools.some((name, i) => name !== input.allowedTools[i]))
    )
      throw new AgentPolicyError();
  };
  const selectTools: AgentTurnTransport['selectTools'] = async (
    input,
    signal,
  ) => {
    await validateTurn(input);
    initialAllowedTools ??= [...input.allowedTools];
    const sentMessages = normalizeMessages(input.messages);
    const data = await request(
      {
        turn,
        messages: sentMessages,
        allowedTools: initialAllowedTools,
        allowTools: true,
        stream: false,
        ...(continuationToken ? { continuationToken } : {}),
      },
      signal,
    );
    if (
      data.status === 'needs_clarification' &&
      Array.isArray(data.fields) &&
      !continuationToken
    )
      return { status: data.status, fields: data.fields };
    if (
      data.status === 'error' &&
      data.code === 'TOOL_NOT_ALLOWED' &&
      Array.isArray(data.toolErrors)
    ) {
      closedOnServer = true;
      continuationToken = null;
      return {
        status: data.status,
        code: data.code,
        toolErrors: data.toolErrors,
      };
    }
    const choices = data.choices;
    const choice =
      Array.isArray(choices) && choices.length === 1 && record(choices[0])
        ? choices[0]
        : null;
    const message = choice && record(choice.message) ? choice.message : null;
    const calls =
      message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
    let prefix: AgentMessage[] | null = null;
    try {
      prefix = calls.length
        ? [
            ...sentMessages,
            ...normalizeMessages([
              {
                role: 'assistant',
                content: null,
                tool_calls: calls,
              } as AgentMessage,
            ]),
          ]
        : sentMessages;
    } catch {
      /* Keep the last confirmed prefix. */
    }
    if (
      typeof data.continuationToken === 'string' &&
      data.continuationToken.length > 0 &&
      data.continuationToken.length <= 4096 &&
      prefix
    ) {
      continuationToken = data.continuationToken;
      latestSignedPrefix = prefix;
    }
    const p = data.policy;
    const validPolicy =
      record(p) &&
      p.sessionId === turn.sessionId &&
      p.scenarioId === turn.scenarioId &&
      p.stateRevision === turn.stateRevision &&
      Array.isArray(p.grants) &&
      p.grants.length > 0 &&
      p.grants.every(
        (grant: unknown) =>
          record(grant) &&
          typeof grant.name === 'string' &&
          initialAllowedTools!.includes(grant.name) &&
          Object.hasOwn(schemas, grant.name) &&
          schemas[grant.name as keyof typeof schemas].safeParse(grant.params)
            .success,
      );
    if (
      !choice ||
      !message ||
      message.role !== 'assistant' ||
      !['tool_calls', 'stop'].includes(String(choice.finish_reason)) ||
      !prefix ||
      typeof data.continuationToken !== 'string' ||
      !data.continuationToken ||
      data.continuationToken.length > 4096 ||
      !Number.isSafeInteger(data.deadline) ||
      (data.deadline as number) <= 0 ||
      !validPolicy
    )
      throw new AgentPolicyError();
    lastDeadline = data.deadline as number;
    const normalizedCalls = calls.length
      ? prefix[prefix.length - 1].tool_calls!
      : [];
    if (
      (!Array.isArray(data.toolErrors) || !data.toolErrors.length) &&
      normalizedCalls.length
    ) {
      const mapped = normalizedCalls.map((call) => {
        let params: unknown;
        try {
          params = JSON.parse(call.function.arguments);
        } catch {
          params = null;
        }
        return { id: call.id, name: call.function.name, params };
      });
      if (
        !checkAdviceToolBatch(
          p as unknown as AdviceToolPolicy,
          {
            sessionId: turn.sessionId,
            scenarioId: turn.scenarioId,
            stateRevision: turn.stateRevision,
          },
          mapped,
        ).allowed
      )
        throw new AgentPolicyError();
    }
    return {
      finishReason: choice.finish_reason,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: normalizedCalls,
      },
      ...(Array.isArray(data.toolErrors) && data.toolErrors.length
        ? { toolErrors: data.toolErrors }
        : {}),
    };
  };
  return {
    selectTools,
    finalize: async (input, signal) => {
      await validateTurn(input);
      if (!continuationToken || !initialAllowedTools)
        throw new AgentTurnInvalidError();
      const messages = normalizeMessages(input.messages);
      const response = await send(
        {
          turn,
          messages,
          allowedTools: initialAllowedTools,
          allowTools: false,
          stream: true,
          continuationToken,
        },
        signal,
        true,
      );
      closedOnServer = true;
      continuationToken = null;
      if (
        !response.headers
          .get('content-type')
          ?.toLowerCase()
          .startsWith('text/event-stream')
      ) {
        try {
          void response.body?.cancel().catch(() => {});
        } catch {
          /* Cancellation is best-effort. */
        }
        throw new AgentServerError(response.status, 'INVALID_CONTENT_TYPE');
      }
      const result = await readAgentFinalSse(response, {
        signal,
        onDelta: (delta) => {
          input.onVerifiedSegment?.(delta.text);
          config.onDelta?.(delta);
        },
      });
      return result.status === 'completed'
        ? { verification: 'passed', text: result.text, incomplete: false }
        : {
            verification: result.verification,
            text: result.text,
            incomplete: true,
            errorCode: result.errorCode,
          };
    },
    getLastDeadline: () => lastDeadline,
    onTurnEnd: async ({ outcome, messages }) => {
      if (closedOnServer || !continuationToken || !initialAllowedTools) return;
      const token = continuationToken;
      const allowed = initialAllowedTools;
      const prefix = latestSignedPrefix;
      closedOnServer = true;
      continuationToken = null;
      if (outcome === 'completed') return;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const body =
          outcome === 'needs_clarification'
            ? {
                turn,
                messages: normalizeMessages(messages),
                allowedTools: allowed,
                allowTools: false,
                stream: true,
                continuationToken: token,
              }
            : prefix
              ? {
                  turn,
                  messages: prefix,
                  allowedTools: allowed,
                  allowTools: false,
                  stream: false,
                  continuationToken: token,
                  action: 'cancel',
                }
              : null;
        if (!body) return;
        await Promise.race([
          request(body, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('CLOSE_TIMEOUT'));
            }, config.closeTimeoutMs ?? 2000);
          }),
        ]);
      } catch {
        /* Closing is best-effort. */
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
