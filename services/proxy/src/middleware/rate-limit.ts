import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { RequestAuth } from './auth';
import { aiContext, isAIRequest } from './logging';
import { config } from '../config';
import { AppError } from '../errors/app-error';
import { rateLimitService } from '../services/rate-limit-service';
import { quotaService } from '../services/quota-service';
import { AgentTurnStore } from '../services/agent-turn-store';

declare module 'fastify' {
  interface FastifyInstance {
    agentTurns: AgentTurnStore;
    reserveAgentQuota(
      request: FastifyRequest,
      reply: FastifyReply,
      key: string,
    ): void;
    settleAgentQuota(key: string, success: boolean): void;
    drainAgentTurns(): void;
  }
}

interface Entry {
  time: number;
  completed: boolean;
  inFlight: number;
  stages: Set<string>;
}
type Admission =
  | { allowed: false; retryAfter: number }
  | {
      allowed: true;
      bypassUsed: boolean;
      finish(success: boolean, refund?: boolean): void;
    };

export class SlidingMessageLimit {
  private readonly windows = new Map<string, Map<string, Entry>>();
  constructor(private readonly now: () => number = Date.now) {}
  reserve(
    auth: RequestAuth,
    message: string,
    environment = {
      nodeEnv: config.nodeEnv,
      bypassSubs: process.env.RATE_LIMIT_BYPASS_SUBS ?? '',
    },
    stage = 'single',
  ): Admission {
    if (config.disableChatRateLimit)
      return { allowed: true, bypassUsed: true, finish() {} };
    if (
      auth.mode === 'authenticated' &&
      ['development', 'test'].includes(environment.nodeEnv) &&
      environment.bypassSubs
        .split(',')
        .map((value) => value.trim())
        .includes(auth.sub)
    )
      return { allowed: true, bypassUsed: true, finish() {} };
    const time = this.now();
    for (const [key, window] of this.windows) {
      for (const [id, entry] of window)
        if (time - entry.time >= 300_000) window.delete(id);
      if (!window.size) this.windows.delete(key);
    }
    const key = JSON.stringify([
      auth.mode,
      auth.mode === 'authenticated' ? auth.sub : auth.deviceId,
    ]);
    const window = this.windows.get(key) ?? new Map<string, Entry>();
    let entry = window.get(message);
    if (
      entry?.stages.has(stage) ||
      (!entry && window.size >= (auth.mode === 'authenticated' ? 3 : 1))
    )
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil(
            (Math.min(...[...window.values()].map((value) => value.time)) +
              300_000 -
              time) /
              1000,
          ),
        ),
      };
    if (!entry) {
      entry = { time, completed: false, inFlight: 0, stages: new Set() };
      window.set(message, entry);
      this.windows.set(key, window);
    }
    entry.stages.add(stage);
    entry.inFlight++;
    let finished = false;
    return {
      allowed: true,
      bypassUsed: false,
      finish: (success, refund = false) => {
        if (finished) return;
        finished = true;
        entry!.inFlight--;
        entry!.completed ||= success;
        if (!success) entry!.stages.delete(stage);
        if (refund || (!entry!.completed && entry!.inFlight === 0))
          window.delete(message);
      },
    };
  }
}

/** Reserve only immediately before the model call, after route validation has succeeded. */
export function admitModelCall(): void {
  aiContext.getStore()?.admit?.();
}

export function installAIRateLimit(app: FastifyInstance): void {
  const messages = new SlidingMessageLimit();
  const permits = new WeakMap<object, Extract<Admission, { allowed: true }>>();
  const dailyPermits = new WeakMap<
    object,
    { finish(success: boolean): void }
  >();
  const turnPermits = new Map<string, (success: boolean) => void>();
  const turns = new AgentTurnStore();
  app.decorate('agentTurns', turns);
  app.decorate('settleAgentQuota', (key: string, success: boolean) => {
    const finish = turnPermits.get(key);
    turnPermits.delete(key);
    finish?.(success);
  });
  app.decorate('drainAgentTurns', () => {
    for (const expired of turns.drainExpiredTurns())
      app.settleAgentQuota(expired.turnKeyHash, false);
  });
  const reserve = (
    request: FastifyRequest,
    reply: FastifyReply,
    key: string,
    stage: string,
  ) => {
    const permit = messages.reserve(request.auth, key, undefined, stage);
    if (!permit.allowed) {
      reply.header('Retry-After', permit.retryAfter);
      throw new AppError(
        429,
        request.auth.mode === 'guest'
          ? 'GUEST_RATE_LIMIT_EXCEEDED'
          : 'RATE_LIMIT_EXCEEDED',
        'Vui lòng đợi trước khi hỏi tiếp.',
      );
    }
    request.aiAudit!.bypass_used = permit.bypassUsed;
    return permit;
  };
  app.decorate(
    'reserveAgentQuota',
    (request: FastifyRequest, reply: FastifyReply, key: string) => {
      if (request.aiAudit?.byok) {
        request.aiAudit.bypass_used = true;
        return;
      }
      const permit = reserve(request, reply, key, 'agent-turn');
      const identity =
        request.auth.mode === 'authenticated'
          ? request.auth.sub
          : request.auth.deviceId;
      const daily = quotaService.reserveQuota(identity, request.auth.mode);
      if (!daily.allowed) {
        permit.finish(false);
        throw AppError.quotaExceeded('Bạn đã hết hạn mức tư vấn hôm nay.');
      }
      turnPermits.set(key, (success) => {
        permit.finish(success, !success);
        daily.finish(success);
      });
    },
  );
  app.addHook('onRequest', async (request, reply) => {
    app.drainAgentTurns();
    if (!isAIRequest(request)) return;
    if (config.disableChatRateLimit) return;
    const ip = rateLimitService.checkRateLimit(request.ip);
    if (!ip.allowed) {
      reply.header('Retry-After', Math.max(1, Math.ceil(ip.resetInMs / 1000)));
      throw AppError.rateLimitExceeded();
    }
    rateLimitService.consumeRateLimit(request.ip);
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!request.aiAudit) return;
    request.aiAudit.admit = () => {
      if (request.aiAudit?.byok) {
        request.aiAudit.bypass_used = true;
        return;
      }
      if (permits.has(request)) return;
      const body = request.body as Record<string, unknown>;
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            body.requestId ?? randomUUID(),
            body.question,
            body.history ?? [],
            body.language ?? 'vi',
            body.currency ?? 'VND',
          ]),
        )
        .digest('hex');
      const permit = reserve(
        request,
        reply,
        key,
        request.routeOptions.url ?? 'single',
      );
      const identity =
        request.auth.mode === 'authenticated'
          ? request.auth.sub
          : request.auth.deviceId;
      const daily = quotaService.reserveQuota(
        identity,
        request.auth.mode,
        typeof body.requestId === 'string' ? body.requestId : undefined,
      );
      if (!daily.allowed) {
        permit.finish(false);
        throw AppError.quotaExceeded('Bạn đã hết hạn mức tư vấn hôm nay.');
      }
      dailyPermits.set(request, daily);
      request.aiAudit!.consumeReservedQuota = () => {
        daily.finish(true);
        return true;
      };
      permits.set(request, permit);
      request.aiAudit!.bypass_used = permit.bypassUsed;
    };
  });
  app.addHook('onResponse', async (request, reply) => {
    // Legacy routes explicitly consume only verified replies; otherwise release their daily hold.
    dailyPermits.get(request)?.finish(false);
    permits
      .get(request)
      ?.finish(
        !!request.aiAudit?.modelResponded && reply.statusCode < 500,
        reply.statusCode >= 500,
      );
  });
  app.addHook('onClose', async () => {
    for (const finish of turnPermits.values()) finish(false);
    turnPermits.clear();
  });
}
