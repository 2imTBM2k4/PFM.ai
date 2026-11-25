import {
  GetTransactionsParamsSchema,
  CalculateBudgetStatusParamsSchema,
  PlanSavingsGoalParamsSchema,
  GetFinancialSnapshotParamsSchema,
  ConversationStateSchema,
  type ConversationState,
  type ToolResult,
  type ToolErrorCode,
} from '@pfm/contracts';
import type { executeTool } from './advice-tools';
import { StaleTurnError } from './agent-errors';

const paramsSchemas = {
  get_transactions: GetTransactionsParamsSchema,
  calculate_budget_status: CalculateBudgetStatusParamsSchema,
  plan_savings_goal: PlanSavingsGoalParamsSchema,
  get_financial_snapshot: GetFinancialSnapshotParamsSchema,
};
interface AgentToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
class LoopFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
const validFields = (fields: unknown): fields is string[] =>
  Array.isArray(fields) &&
  fields.length > 0 &&
  fields.length <= 32 &&
  fields.every(
    (field) =>
      typeof field === 'string' &&
      field.trim().length > 0 &&
      field.length <= 120,
  );

function parseDenials(value: unknown): { ids: string[]; code: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2)
    throw new LoopFailure('INVALID_SELECTION');
  const ids: string[] = [];
  let code = '';
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.tool_call_id !== 'string' ||
      !item.tool_call_id ||
      item.tool_call_id.length > 128 ||
      ids.includes(item.tool_call_id) ||
      !isRecord(item.result) ||
      item.result.status !== 'error' ||
      typeof item.result.code !== 'string' ||
      !['TOOL_NOT_ALLOWED', 'INVALID_PARAMS', 'STATE_ERROR'].includes(
        item.result.code,
      ) ||
      item.result.retryable !== false ||
      (code && code !== item.result.code)
    )
      throw new LoopFailure('INVALID_SELECTION');
    ids.push(item.tool_call_id);
    code = item.result.code;
  }
  return { ids, code };
}

/** Validate the transport-neutral frame; parameter schemas remain owned by contracts. */
function parseSelection(value: unknown) {
  if (isRecord(value) && value.status === 'needs_clarification') {
    if (!validFields(value.fields)) throw new LoopFailure('INVALID_SELECTION');
    return { kind: 'clarification' as const, fields: value.fields };
  }
  if (isRecord(value) && value.status === 'error') {
    if (
      value.code !== 'TOOL_NOT_ALLOWED' ||
      'message' in value ||
      'finishReason' in value
    )
      throw new LoopFailure('INVALID_SELECTION');
    parseDenials(value.toolErrors);
    return { kind: 'denied' as const };
  }
  if (
    !isRecord(value) ||
    typeof value.finishReason !== 'string' ||
    !['tool_calls', 'stop', 'length'].includes(value.finishReason) ||
    !isRecord(value.message)
  )
    throw new LoopFailure('INVALID_SELECTION');
  const message = value.message;
  if (
    message.role !== 'assistant' ||
    (message.content !== undefined &&
      message.content !== null &&
      (typeof message.content !== 'string' || message.content.length > 8192)) ||
    (message.tool_calls !== undefined &&
      (!Array.isArray(message.tool_calls) || message.tool_calls.length > 2))
  )
    throw new LoopFailure('INVALID_SELECTION');
  const calls: AgentToolCall[] = [];
  for (const call of message.tool_calls ?? []) {
    if (
      !isRecord(call) ||
      typeof call.id !== 'string' ||
      !call.id ||
      call.id.length > 128 ||
      call.type !== 'function' ||
      !isRecord(call.function) ||
      typeof call.function.name !== 'string' ||
      !call.function.name ||
      typeof call.function.arguments !== 'string' ||
      call.function.arguments.length > 4000
    )
      throw new LoopFailure('INVALID_SELECTION');
    calls.push({
      id: call.id,
      type: 'function',
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    });
  }
  const denial =
    value.toolErrors === undefined ||
    (Array.isArray(value.toolErrors) && value.toolErrors.length === 0)
      ? undefined
      : parseDenials(value.toolErrors);
  if (
    denial &&
    (denial.ids.length !== calls.length ||
      calls.some((call) => !denial.ids.includes(call.id)))
  )
    throw new LoopFailure('INVALID_SELECTION');
  return {
    kind: 'selection' as const,
    denial,
    finishReason: value.finishReason,
    message: {
      role: 'assistant' as const,
      content: message.content as string | null | undefined,
      tool_calls: calls,
    },
  };
}

/** Reject malformed adapter outcomes before treating them as verified local observations. */
function parseToolResult(value: unknown): ToolResult {
  if (isRecord(value)) {
    if (
      value.status === 'ok' &&
      typeof value.stateRevision === 'number' &&
      Number.isSafeInteger(value.stateRevision) &&
      value.stateRevision >= 0 &&
      typeof value.calculationVersion === 'number' &&
      Number.isSafeInteger(value.calculationVersion) &&
      value.calculationVersion > 0 &&
      value.data !== undefined &&
      (value.truncated === undefined || typeof value.truncated === 'boolean')
    ) {
      return JSON.parse(
        JSON.stringify({
          status: 'ok',
          data: value.data,
          stateRevision: value.stateRevision,
          calculationVersion: value.calculationVersion,
          ...(value.truncated === undefined
            ? {}
            : { truncated: value.truncated }),
        }),
      );
    }
    if (
      value.status === 'needs_clarification' &&
      Array.isArray(value.fields) &&
      value.fields.length > 0 &&
      value.fields.length <= 32 &&
      value.fields.every(
        (field) =>
          typeof field === 'string' &&
          field.trim().length > 0 &&
          field.length <= 120,
      )
    )
      return { status: 'needs_clarification', fields: [...value.fields] };
    if (
      value.status === 'error' &&
      typeof value.retryable === 'boolean' &&
      typeof value.code === 'string' &&
      [
        'INVALID_PARAMS',
        'TIMEOUT',
        'TOOL_NOT_ALLOWED',
        'DATA_ERROR',
        'STATE_ERROR',
      ].includes(value.code)
    )
      return {
        status: 'error',
        code: value.code as ToolErrorCode,
        retryable: value.retryable,
      };
  }
  throw new LoopFailure('DATA_ERROR');
}

export interface AgentLoopInput {
  turnId?: string;
  sessionId: string;
  userMessageId: string;
  question: string;
  state: ConversationState | null;
  allowedTools: string[];
}
export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: AgentToolCall[];
  tool_call_id?: string;
}
export interface AgentObservation {
  name: string;
  params: unknown;
  result: ToolResult;
}
export interface AgentStepInput {
  turnId?: string;
  sessionId: string;
  userMessageId: string;
  question: string;
  stateRevision: number;
  allowedTools: string[];
  messages: AgentMessage[];
  timeoutMs: number;
}
export interface AgentLoopDependencies {
  now(): number;
  selectTools(input: AgentStepInput, signal: AbortSignal): Promise<unknown>;
  executeTool: typeof executeTool;
  readRevision(sessionId: string): Promise<number | null>;
  /** Resolve only after the final response has been verified; never return unchecked prose. */
  finalize(
    input: AgentStepInput & {
      observations: AgentObservation[];
      onVerifiedSegment?: (segment: string) => void;
    },
    signal: AbortSignal,
  ): Promise<AgentFinalizeResult>;
  onTurnEnd?(params: {
    turnId: string;
    outcome: 'completed' | 'incomplete' | 'needs_clarification' | 'fallback';
    fallbackReason?: string;
    messages: AgentMessage[];
  }): Promise<void>;
}
export type AgentFinalizeResult =
  | { verification: 'passed'; text?: string; incomplete?: false }
  | {
      verification: 'failed' | 'incomplete';
      text?: string;
      incomplete: true;
      errorCode?: string;
    };
export type AgentLoopResult =
  | { status: 'completed'; text?: string; observations: AgentObservation[] }
  | {
      status: 'incomplete';
      text: string;
      incomplete: true;
      verification: 'failed' | 'incomplete';
      reason: string;
      observations: AgentObservation[];
    }
  | {
      status: 'needs_clarification';
      fields: string[];
      observations: AgentObservation[];
    }
  | { status: 'fallback'; reason: string; observations: AgentObservation[] };

/** Coordinate local tools without owning transport, storage, or user-visible prose. */
export async function runAgentLoop(
  input: AgentLoopInput,
  deps: AgentLoopDependencies,
): Promise<AgentLoopResult> {
  let result: AgentLoopResult | undefined;
  const messages: AgentMessage[] = [];
  try {
    result = await runAgentTurn(input, deps, messages);
    return result;
  } finally {
    if (input.turnId !== undefined && deps.onTurnEnd) {
      try {
        await deps.onTurnEnd({
          turnId: input.turnId,
          outcome: result?.status ?? 'fallback',
          messages: JSON.parse(JSON.stringify(messages)),
          ...(result?.status === 'fallback'
            ? { fallbackReason: result.reason }
            : result === undefined
              ? { fallbackReason: 'UNKNOWN' }
              : {}),
        });
      } catch {
        try {
          console.warn('Agent turn cleanup failed');
        } catch {
          // Logging must not change the turn result.
        }
      }
    }
  }
}

async function runAgentTurn(
  input: AgentLoopInput,
  deps: AgentLoopDependencies,
  messages: AgentMessage[],
): Promise<AgentLoopResult> {
  const observations: AgentObservation[] = [];
  const deadline = deps.now() + 30_000;
  const bounded = async <T>(
    cap: number,
    reason: string,
    task: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
  ): Promise<T> => {
    const started = deps.now();
    const remaining = deadline - started;
    if (remaining <= 0) throw new LoopFailure('TURN_TIMEOUT');
    const timeoutMs = Math.min(cap, remaining);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new LoopFailure(timeoutMs === remaining ? 'TURN_TIMEOUT' : reason),
          );
          controller.abort();
        }, timeoutMs);
      });
      const result = await Promise.race([
        task(controller.signal, timeoutMs),
        timeout,
      ]);
      if (deps.now() >= deadline) throw new LoopFailure('TURN_TIMEOUT');
      if (deps.now() - started >= timeoutMs) throw new LoopFailure(reason);
      return result;
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const allowed = [...input.allowedTools];
    if (
      !input.question.trim() ||
      input.question.length > 500 ||
      !input.sessionId ||
      input.sessionId.length > 64 ||
      !input.userMessageId ||
      !allowed.length ||
      allowed.length > 4 ||
      new Set(allowed).size !== allowed.length ||
      allowed.some((name) => !Object.hasOwn(paramsSchemas, name))
    )
      throw new LoopFailure('INVALID_INPUT');
    const parsedState =
      input.state === null
        ? null
        : ConversationStateSchema.safeParse(input.state);
    if (
      parsedState &&
      (!parsedState.success || parsedState.data.sessionId !== input.sessionId)
    )
      throw new LoopFailure('STATE_ERROR');
    const state = parsedState?.success ? parsedState.data : null;
    const revision = state?.revision ?? null;
    const checkRevision = async () => {
      if (
        (await bounded(1_500, 'TOOL_TIMEOUT', () =>
          deps.readRevision(input.sessionId),
        )) !== revision
      )
        throw new LoopFailure('STATE_ERROR');
    };
    await checkRevision();
    messages.push({ role: 'user', content: input.question });
    const step = (): AgentStepInput => ({
      ...(input.turnId ? { turnId: input.turnId } : {}),
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      question: input.question,
      stateRevision: revision ?? 0,
      allowedTools: [...allowed],
      messages: JSON.parse(JSON.stringify(messages)),
      timeoutMs: 15_000,
    });
    const ids = new Set<string>();
    const cache = new Map<string, ToolResult>();
    const completed = new Set<string>();
    let disallowedStreak = 0;
    for (let round = 0; round < 3; round++) {
      const selected = parseSelection(
        await bounded(15_000, 'MODEL_TIMEOUT', (signal, timeoutMs) =>
          deps.selectTools({ ...step(), timeoutMs }, signal),
        ),
      );
      if (selected.kind === 'denied') throw new LoopFailure('TOOL_NOT_ALLOWED');
      if (selected.kind === 'clarification') {
        if (round !== 0) throw new LoopFailure('INVALID_SELECTION');
        return {
          status: 'needs_clarification',
          fields: [...selected.fields],
          observations,
        };
      }
      const calls = selected.message.tool_calls;
      if (
        selected.finishReason === 'length' ||
        (calls.length
          ? selected.finishReason !== 'tool_calls'
          : selected.finishReason !== 'stop')
      )
        throw new LoopFailure('INVALID_SELECTION');
      if (!calls.length) {
        if (!completed.size) throw new LoopFailure('NO_TOOL_RESULT');
        break;
      }
      for (const call of calls) {
        if (ids.has(call.id)) throw new LoopFailure('DUPLICATE_CALL_ID');
        ids.add(call.id);
      }
      // Tool-selection prose is not evidence and must not become final-answer context.
      messages.push({ ...selected.message, content: null });
      if (
        selected.denial ||
        calls.some((call) => !allowed.includes(call.function.name))
      ) {
        for (const call of calls)
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              status: 'error',
              code: selected.denial?.code ?? 'TOOL_NOT_ALLOWED',
              retryable: false,
            }),
          });
        disallowedStreak++;
        if (disallowedStreak >= 2) throw new LoopFailure('TOOL_NOT_ALLOWED');
        if (round === 2) throw new LoopFailure('ROUND_LIMIT');
        continue;
      }
      disallowedStreak = 0;
      const validated = calls.map((call) => {
        const name = call.function.name as keyof typeof paramsSchemas;
        try {
          return {
            name,
            params: paramsSchemas[name].parse(
              JSON.parse(call.function.arguments),
            ),
          };
        } catch {
          throw new LoopFailure('INVALID_PARAMS');
        }
      });
      if (!state && validated.some(({ name }) => name === 'plan_savings_goal'))
        throw new LoopFailure('STATE_ERROR');
      const clarificationFields = new Set<string>();
      for (const [index, { name, params }] of validated.entries()) {
        const key = JSON.stringify([name, params, revision]);
        let result = cache.get(key);
        if (!result) {
          // SQLite may finish later; bounded rejects the wait and that result is never observed.
          result = parseToolResult(
            await bounded(1_500, 'TOOL_TIMEOUT', (_signal, timeoutMs) =>
              deps.executeTool(name, params, [...allowed], {
                sessionId: input.sessionId,
                stateRevision: revision ?? 0,
                ...(state ? { state } : {}),
                deadline: Date.now() + timeoutMs,
              }),
            ),
          );
          if (
            result.status === 'ok' &&
            result.stateRevision !== (revision ?? 0)
          )
            throw new LoopFailure('STATE_ERROR');
          observations.push({ name, params, result });
          if (result.status === 'error') throw new LoopFailure(result.code);
          if (result.status === 'needs_clarification')
            result.fields.forEach((field) => clarificationFields.add(field));
          else cache.set(key, result);
        }
        if (result.status === 'ok') completed.add(name);
        messages.push({
          role: 'tool',
          tool_call_id: calls[index].id,
          content: JSON.stringify(result),
        });
      }
      if (clarificationFields.size)
        return {
          status: 'needs_clarification',
          fields: [...clarificationFields],
          observations,
        };
    }
    if (!completed.size) throw new LoopFailure('NO_TOOL_RESULT');
    await checkRevision();
    let verifiedPrefix = '';
    let receiving = true;
    let final: AgentFinalizeResult;
    try {
      final = await bounded(15_000, 'MODEL_TIMEOUT', (signal, timeoutMs) =>
        deps.finalize(
          {
            ...step(),
            timeoutMs,
            observations: JSON.parse(JSON.stringify(observations)),
            onVerifiedSegment: (segment) => {
              if (receiving) verifiedPrefix += segment;
            },
          },
          signal,
        ),
      );
    } catch (error) {
      if (
        error instanceof LoopFailure &&
        ['MODEL_TIMEOUT', 'TURN_TIMEOUT'].includes(error.reason) &&
        verifiedPrefix.length
      )
        return {
          status: 'incomplete',
          text: verifiedPrefix,
          incomplete: true,
          verification: 'incomplete',
          reason: error.reason,
          observations,
        };
      throw error;
    } finally {
      receiving = false;
    }
    if (final.verification !== 'passed') {
      const retained = final.text ?? verifiedPrefix;
      if (!retained.length)
        throw new LoopFailure(final.errorCode ?? 'UNVERIFIED_FINAL');
      await checkRevision();
      return {
        status: 'incomplete',
        text: retained,
        incomplete: true,
        verification: final.verification,
        reason: final.errorCode ?? 'UNVERIFIED_FINAL',
        observations,
      };
    }
    await checkRevision();
    return {
      status: 'completed',
      ...(final.text !== undefined ? { text: final.text } : {}),
      observations,
    };
  } catch (error) {
    return {
      status: 'fallback',
      reason:
        error instanceof StaleTurnError
          ? 'STALE_TURN'
          : error instanceof LoopFailure
            ? error.reason
            : 'DATA_ERROR',
      observations,
    };
  }
}
