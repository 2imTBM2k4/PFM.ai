import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import { config } from '../config';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);
const bindingSchema = z
  .object({
    identity: z.union([
      z.object({ mode: z.literal('authenticated'), sub: idSchema }).strict(),
      z.object({ mode: z.literal('guest'), deviceId: idSchema }).strict(),
    ]),
    turnId: idSchema,
    userMessageId: idSchema,
    sessionId: idSchema.refine((value) => value.length <= 64),
    scenarioId: idSchema.refine((value) => value.length <= 64).nullable(),
    stateRevision: z.number().int().safe().nonnegative(),
    model: z.string().min(1).max(200),
    language: z.enum(['vi', 'en']),
    currency: z.enum(['VND', 'USD']),
    questionHash: digestSchema,
    policyHash: digestSchema,
  })
  .strict();
export type AgentTurnBinding = z.infer<typeof bindingSchema>;
const tokenSchema = z
  .object({
    v: z.literal(1),
    key: digestSchema,
    binding: digestSchema,
    prefix: digestSchema,
    nonce: z.string().regex(/^[a-f0-9]{48}$/),
    expiresAt: z.number().finite().positive(),
    selections: z.number().int().min(1).max(3),
    finals: z.number().int().min(0).max(1),
  })
  .strict();
const claimSchema = z
  .object({
    prefixHash: digestSchema,
    step: z.enum(['select', 'final', 'close']),
    successfulTools: z.number().int().min(0).max(6),
  })
  .strict();
export type AgentTurnStep = 'select' | 'final' | 'close';
export interface AgentTurnLease {
  readonly step: AgentTurnStep;
}
type Rejection = {
  status: 'rejected';
  reason:
    | 'INVALID_INPUT'
    | 'INVALID_TOKEN'
    | 'INVALID_TRANSITION'
    | 'REPLAY'
    | 'TURN_EXPIRED'
    | 'STEP_EXPIRED'
    | 'STEP_LIMIT'
    | 'NO_TOOL_RESULT'
    | 'CAPACITY'
    | 'FAILURE_LIMIT';
};
type Admission =
  | {
      status: 'accepted';
      lease: AgentTurnLease;
      deadline: number;
      timeoutMs: number;
      turnKeyHash: string;
    }
  | Rejection;
interface Entry {
  identityHash: string;
  bindingHash: string;
  prefixHash: string;
  deadline: number;
  deadlineTick: number;
  phase: 'running' | 'waiting' | 'closed';
  selections: number;
  finals: number;
  successfulTools: number;
  generation: number;
  step: AgentTurnStep;
  stepStarted: boolean;
  modelStarted: boolean;
  nonceHash?: string;
  outcome?: 'completed' | 'clarification' | 'failed';
  closedTick?: number;
  stepDeadlineTick?: number;
  stepDeadlineWall?: number;
  pendingExpiry?: boolean;
}
export interface ExpiredAgentTurn {
  turnKeyHash: string;
  identityHash: string;
  refund: true;
  modelStarted: boolean;
}
const reject = (reason: Rejection['reason']): Rejection => ({
  status: 'rejected',
  reason,
});

/** Hash strict JSON canonically without retaining its source data. */
export function hashAgentTurnValue(value: unknown): string {
  const seen = new Set<object>();
  const invalid = (): never => {
    throw new TypeError('Invalid turn fingerprint input.');
  };
  const encode = (item: unknown, depth: number): string => {
    if (depth > 32) return invalid();
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return JSON.stringify(item);
    if (typeof item === 'number')
      return Number.isFinite(item) ? JSON.stringify(item) : invalid();
    if (typeof item !== 'object' || seen.has(item)) return invalid();
    seen.add(item);
    let encoded: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) return invalid();
      encoded =
        '[' + item.map((child) => encode(child, depth + 1)).join(',') + ']';
    } else {
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        return invalid();
      encoded =
        '{' +
        Object.keys(item)
          .sort()
          .map(
            (key) =>
              JSON.stringify(key) +
              ':' +
              encode((item as Record<string, unknown>)[key], depth + 1),
          )
          .join(',') +
        '}';
    }
    seen.delete(item);
    return encoded;
  };
  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded, 'utf8') > 16_384) return invalid();
  return createHash('sha256').update(encoded).digest('hex');
}

/** Hold only security metadata; one instance belongs to one server process. */
export class AgentTurnStore {
  private readonly secret = randomBytes(32);
  private readonly entries = new Map<string, Entry>();
  private readonly leases = new WeakMap<
    AgentTurnLease,
    { key: string; entry: Entry; generation: number }
  >();
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly maxEntries: number;

  constructor(
    options: {
      wallNow?: () => number;
      monotonicNow?: () => number;
      maxEntries?: number;
    } = {},
  ) {
    this.wallNow = options.wallNow ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.maxEntries = options.maxEntries ?? 1000;
    if (
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      this.maxEntries > 100_000
    )
      throw new TypeError('Invalid turn store capacity.');
  }

  begin(binding: AgentTurnBinding, prefixHash: string): Admission {
    const parsed = bindingSchema.safeParse(binding);
    if (!parsed.success || !digestSchema.safeParse(prefixHash).success)
      return reject('INVALID_INPUT');
    this.sweep();
    const key = hashAgentTurnValue({
      identity: parsed.data.identity,
      turnId: parsed.data.turnId,
    });
    if (this.entries.has(key)) return reject('REPLAY');
    if (this.entries.size >= this.maxEntries) return reject('CAPACITY');
    const identityHash = hashAgentTurnValue(parsed.data.identity);
    const reserved = [...this.entries.values()].filter(
      (entry) =>
        entry.identityHash === identityHash &&
        (entry.phase !== 'closed' ||
          (entry.modelStarted &&
            entry.outcome === 'failed' &&
            this.monotonicNow() - entry.closedTick! < 300_000)),
    ).length;
    if (!config.disableChatRateLimit && reserved >= 2)
      return reject('FAILURE_LIMIT');
    const entry: Entry = {
      identityHash,
      bindingHash: hashAgentTurnValue(parsed.data),
      prefixHash,
      deadline: this.wallNow() + 30_000,
      deadlineTick: this.monotonicNow() + 30_000,
      phase: 'running',
      selections: 1,
      finals: 0,
      successfulTools: 0,
      generation: 0,
      step: 'select',
      stepStarted: false,
      modelStarted: false,
    };
    this.entries.set(key, entry);
    return this.admit(key, entry, 'select');
  }

  markModelStarted(
    lease: AgentTurnLease,
  ): { status: 'started'; timeoutMs: number } | Rejection {
    const current = this.running(lease);
    if (!current) return reject('INVALID_TRANSITION');
    const expired = this.expire(current.entry);
    if (expired) return reject(expired);
    if (current.entry.step === 'close' || current.entry.stepStarted)
      return reject('INVALID_TRANSITION');
    current.entry.stepStarted = true;
    current.entry.modelStarted = true;
    const timeoutMs = Math.min(15_000, this.remaining(current.entry));
    current.entry.stepDeadlineTick = this.monotonicNow() + timeoutMs;
    current.entry.stepDeadlineWall = this.wallNow() + timeoutMs;
    return { status: 'started', timeoutMs };
  }

  checkpoint(
    lease: AgentTurnLease,
    prefixHash: string,
  ): { status: 'issued'; token: string; deadline: number } | Rejection {
    const current = this.running(lease);
    if (!current) return reject('INVALID_TRANSITION');
    const { entry, key } = current;
    const expired = this.expire(entry);
    if (expired) return reject(expired);
    if (entry.step !== 'select' || !entry.stepStarted)
      return reject('INVALID_TRANSITION');
    if (!digestSchema.safeParse(prefixHash).success)
      return reject('INVALID_INPUT');
    const nonce = randomBytes(24).toString('hex');
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        key,
        binding: entry.bindingHash,
        prefix: prefixHash,
        nonce,
        expiresAt: entry.deadline,
        selections: entry.selections,
        finals: entry.finals,
      }),
    ).toString('base64url');
    const token = `${payload}.${this.sign(payload).toString('base64url')}`;
    entry.prefixHash = prefixHash;
    entry.nonceHash = hashAgentTurnValue(nonce);
    entry.phase = 'waiting';
    entry.stepStarted = false;
    delete entry.stepDeadlineTick;
    delete entry.stepDeadlineWall;
    this.leases.delete(lease);
    return { status: 'issued', token, deadline: entry.deadline };
  }

  claim(
    token: string,
    binding: AgentTurnBinding,
    input: z.infer<typeof claimSchema>,
  ): Admission {
    const claims = this.verify(token);
    const parsed = bindingSchema.safeParse(binding);
    const request = claimSchema.safeParse(input);
    if (
      !claims ||
      !parsed.success ||
      !request.success ||
      claims.binding !== hashAgentTurnValue(parsed.data)
    )
      return reject('INVALID_TOKEN');
    const entry = this.entries.get(claims.key);
    if (
      !entry ||
      entry.bindingHash !== claims.binding ||
      entry.prefixHash !== claims.prefix ||
      request.data.prefixHash !== claims.prefix
    )
      return reject('INVALID_TOKEN');
    const expired = this.expire(entry);
    if (expired) return reject(expired);
    if (
      entry.phase !== 'waiting' ||
      entry.nonceHash !== hashAgentTurnValue(claims.nonce)
    )
      return reject('REPLAY');
    if (
      claims.selections !== entry.selections ||
      claims.finals !== entry.finals ||
      claims.expiresAt !== entry.deadline
    )
      return reject('INVALID_TOKEN');
    const { step, successfulTools } = request.data;
    if (successfulTools < entry.successfulTools) return reject('INVALID_INPUT');
    if (
      (step === 'select' && entry.selections >= 3) ||
      (step === 'final' && entry.finals >= 1)
    )
      return reject('STEP_LIMIT');
    if (step === 'final' && !successfulTools) return reject('NO_TOOL_RESULT');
    entry.successfulTools = successfulTools;
    if (step === 'select') entry.selections++;
    if (step === 'final') entry.finals++;
    delete entry.nonceHash;
    return this.admit(claims.key, entry, step);
  }

  finish(
    lease: AgentTurnLease,
    outcome: 'completed' | 'clarification' | 'failed',
  ):
    | {
        status: 'closed';
        outcome: 'completed' | 'clarification' | 'failed';
        refund: boolean;
      }
    | Rejection {
    const current = this.running(lease);
    if (!current) return reject('INVALID_TRANSITION');
    const { entry } = current;
    if (!['completed', 'clarification', 'failed'].includes(outcome))
      return reject('INVALID_INPUT');
    if (this.expiryReason(entry)) outcome = 'failed';
    else if (
      (outcome === 'completed' &&
        (entry.step !== 'final' || !entry.stepStarted)) ||
      (outcome === 'clarification' && entry.step !== 'close')
    )
      return reject('INVALID_TRANSITION');
    this.close(entry, outcome);
    this.leases.delete(lease);
    return { status: 'closed', outcome, refund: outcome === 'failed' };
  }

  private close(
    entry: Entry,
    outcome: 'completed' | 'clarification' | 'failed',
    pendingExpiry = false,
  ): void {
    entry.phase = 'closed';
    entry.outcome = outcome;
    entry.generation++;
    entry.closedTick = Math.min(
      this.monotonicNow(),
      entry.deadlineTick,
      entry.stepDeadlineTick ?? Infinity,
    );
    entry.pendingExpiry = pendingExpiry;
    delete entry.nonceHash;
  }

  private expiryReason(entry: Entry): 'TURN_EXPIRED' | 'STEP_EXPIRED' | null {
    if (this.remaining(entry) <= 0) return 'TURN_EXPIRED';
    if (
      entry.phase === 'running' &&
      entry.stepStarted &&
      Math.min(
        entry.stepDeadlineTick! - this.monotonicNow(),
        entry.stepDeadlineWall! - this.wallNow(),
      ) <= 0
    )
      return 'STEP_EXPIRED';
    return null;
  }

  private expire(entry: Entry): 'TURN_EXPIRED' | 'STEP_EXPIRED' | null {
    const reason = this.expiryReason(entry);
    if (reason && entry.phase !== 'closed') this.close(entry, 'failed', true);
    return reason;
  }

  /** Deliver automatic expirations once; the quota adapter must apply them synchronously. */
  drainExpiredTurns(): ExpiredAgentTurn[] {
    this.sweep();
    const events: ExpiredAgentTurn[] = [];
    for (const [turnKeyHash, entry] of this.entries) {
      if (!entry.pendingExpiry) continue;
      events.push({
        turnKeyHash,
        identityHash: entry.identityHash,
        refund: true,
        modelStarted: entry.modelStarted,
      });
      entry.pendingExpiry = false;
    }
    this.sweep();
    return events;
  }

  private sweep(): void {
    const now = this.monotonicNow();
    for (const [key, entry] of this.entries) {
      if (entry.phase !== 'closed') this.expire(entry);
      if (
        entry.phase === 'closed' &&
        !entry.pendingExpiry &&
        now - entry.closedTick! >= 300_000
      )
        this.entries.delete(key);
    }
  }

  private remaining(entry: Entry): number {
    return Math.floor(
      Math.min(
        entry.deadline - this.wallNow(),
        entry.deadlineTick - this.monotonicNow(),
      ),
    );
  }

  private admit(key: string, entry: Entry, step: AgentTurnStep): Admission {
    entry.phase = 'running';
    entry.generation++;
    entry.step = step;
    entry.stepStarted = false;
    delete entry.stepDeadlineTick;
    delete entry.stepDeadlineWall;
    const lease: AgentTurnLease = Object.freeze({ step });
    this.leases.set(lease, { key, entry, generation: entry.generation });
    return {
      status: 'accepted',
      lease,
      deadline: entry.deadline,
      timeoutMs: step === 'close' ? 0 : Math.min(15_000, this.remaining(entry)),
      turnKeyHash: key,
    };
  }

  private running(lease: AgentTurnLease): { key: string; entry: Entry } | null {
    const active = this.leases.get(lease);
    if (!active) return null;
    const entry = this.entries.get(active.key);
    return entry === active.entry &&
      entry.phase === 'running' &&
      entry.generation === active.generation
      ? { key: active.key, entry }
      : null;
  }

  private sign(payload: string): Buffer {
    return createHmac('sha256', this.secret).update(payload).digest();
  }

  private verify(token: string): z.infer<typeof tokenSchema> | null {
    if (
      typeof token !== 'string' ||
      token.length > 4096 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)
    )
      return null;
    const [payload, signature] = token.split('.');
    const actual = Buffer.from(signature, 'base64url');
    const expected = this.sign(payload);
    if (
      actual.toString('base64url') !== signature ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return null;
    try {
      const parsed = tokenSchema.safeParse(
        JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
