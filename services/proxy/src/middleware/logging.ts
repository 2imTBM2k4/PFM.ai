import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config';
import { parseByokHeaders, type ByokConfig } from '../services/byok';

interface AuditState {
  request_id: string;
  model: string | null;
  latency_ms: number;
  intent: 'advice' | 'entry' | 'unknown';
  tool_calls: string[];
  fallback_used: boolean;
  bypass_used: boolean;
  auth_mode: 'guest' | 'authenticated';
  error_code: string | null;
  started: number;
  modelResponded: boolean;
  admit?: () => void;
  consumeReservedQuota?: () => boolean;
  byok?: ByokConfig | null;
}
export const aiContext = new AsyncLocalStorage<AuditState>();

/** Returns the request-scoped BYOK provider config when present, never persisted or logged. */
export function getActiveByok(): ByokConfig | null {
  return aiContext.getStore()?.byok ?? null;
}
const auditKeys = [
  'request_id',
  'model',
  'latency_ms',
  'intent',
  'tool_calls',
  'fallback_used',
  'bypass_used',
  'auth_mode',
  'error_code',
] as const;

/** Remove the logger's envelope before writing the fixed audit schema to its existing destination. */
export function auditDestination(destination: {
  write(line: string): unknown;
}) {
  return {
    write(line: string) {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (auditKeys.every((key) => Object.hasOwn(record, key)))
        destination.write(
          JSON.stringify(
            Object.fromEntries(auditKeys.map((key) => [key, record[key]])),
          ) + '\n',
        );
    },
  };
}
declare module 'fastify' {
  interface FastifyRequest {
    aiAudit?: AuditState;
  }
}
export const isAIRequest = (request: FastifyRequest) =>
  request.method === 'POST' &&
  [
    '/v1/advice',
    '/v1/advice/plan',
    '/v1/advice/complete',
    '/v1/advice/step',
    '/v1/advice/coach',
    '/v1/receipts/scan',
  ].includes(request.routeOptions.url ?? '');

/** Record provider metadata only after a real response, never payloads or model-generated labels. */
export function recordModelResponse(model: string | null): void {
  const audit = aiContext.getStore();
  if (!audit) return;
  audit.modelResponded = true;
  audit.model =
    model &&
    [
      ...config.modelChainFree,
      ...config.agentModelAllowlist,
      config.receiptVisionModel,
    ].includes(model)
      ? model
      : null;
}

/** Emit one allowlisted JSON object for every AI request, including rejected requests. */
export function installAILogging(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    if (!isAIRequest(request)) return done();
    const audit: AuditState = {
      request_id: randomUUID(),
      model: null,
      latency_ms: 0,
      intent:
        request.routeOptions.url === '/v1/receipts/scan' ? 'entry' : 'advice',
      tool_calls: [],
      fallback_used: false,
      bypass_used: false,
      auth_mode: 'guest',
      error_code: null,
      started: performance.now(),
      modelResponded: false,
    };
    try {
      audit.byok = parseByokHeaders(
        request.headers as Record<string, string | string[] | undefined>,
      );
    } catch (error) {
      request.aiAudit = audit;
      aiContext.run(audit, () => done(error as Error));
      return;
    }
    request.aiAudit = audit;
    aiContext.run(audit, done);
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const audit = request.aiAudit;
    if (!audit) return payload;
    audit.auth_mode = request.auth?.mode ?? 'guest';
    const body = request.body as { requestId?: unknown } | null;
    if (
      typeof body?.requestId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(body.requestId)
    )
      audit.request_id = body.requestId;
    let response: {
      code?: unknown;
      error?: unknown;
      model?: unknown;
      fallbackTemplate?: unknown;
    } = {};
    if (typeof payload === 'string')
      try {
        response = JSON.parse(payload);
      } catch {
        /* Only fixed status codes are used for non-JSON failures. */
      }
    const allowed = [
      'INVALID_TOKEN',
      'BAD_REQUEST',
      'PII_DETECTED',
      'ADVICE_OUT_OF_SCOPE',
      'ADVICE_RESTRICTED',
      'ADVICE_AMBIGUOUS',
      'QUOTA_EXCEEDED_DEVICE',
      'QUOTA_EXCEEDED_GLOBAL',
      'RATE_LIMIT_EXCEEDED',
      'GUEST_RATE_LIMIT_EXCEEDED',
      'ANSWER_UNVERIFIED',
      'RECEIPT_UNVERIFIED',
      'UPSTREAM_UNAVAILABLE',
      'INTERNAL_ERROR',
    ];
    const code = response.code ?? response.error;
    audit.error_code =
      reply.statusCode < 400
        ? null
        : typeof code === 'string' && allowed.includes(code)
          ? code
          : reply.statusCode >= 500
            ? 'INTERNAL_ERROR'
            : 'BAD_REQUEST';
    audit.fallback_used =
      !!response.fallbackTemplate ||
      response.model === 'deterministic-fallback' ||
      reply.statusCode >= 500 ||
      code === 'ANSWER_UNVERIFIED';
    return payload;
  });
  app.addHook('onResponse', async (request) => {
    const a = request.aiAudit;
    if (!a) return;
    app.log.info({
      request_id: a.request_id,
      model: a.model,
      latency_ms: Math.max(0, Math.round(performance.now() - a.started)),
      intent: a.intent,
      tool_calls: a.tool_calls,
      fallback_used: a.fallback_used,
      bypass_used: a.bypass_used,
      auth_mode: a.auth_mode,
      error_code: a.error_code,
    });
  });
}
