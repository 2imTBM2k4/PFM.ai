import { config } from '../config';

export interface RateLimitStatus {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetInMs: number;
}

interface WindowRecord {
  count: number;
  windowStart: number;
}

export class RateLimitService {
  private readonly records = new Map<string, WindowRecord>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options?: {
    maxRequests?: number;
    windowMs?: number;
    clock?: () => number;
  }) {
    this.maxRequests = options?.maxRequests ?? config.ipRateLimitMax;
    this.windowMs = options?.windowMs ?? config.ipRateLimitWindowMs;
    this.now = options?.clock ?? Date.now;
  }

  checkRateLimit(ip: string): RateLimitStatus {
    if (config.unlimitedAiTesting)
      return {
        allowed: true,
        remaining: Number.MAX_SAFE_INTEGER,
        limit: Number.MAX_SAFE_INTEGER,
        resetInMs: 0,
      };
    const currentTime = this.now();
    const record = this.records.get(ip);

    if (!record || currentTime - record.windowStart >= this.windowMs) {
      return {
        allowed: true,
        remaining: this.maxRequests,
        limit: this.maxRequests,
        resetInMs: this.windowMs,
      };
    }

    const remaining = Math.max(0, this.maxRequests - record.count);
    const resetInMs = Math.max(
      0,
      this.windowMs - (currentTime - record.windowStart),
    );

    return {
      allowed: remaining > 0,
      remaining,
      limit: this.maxRequests,
      resetInMs,
    };
  }

  consumeRateLimit(ip: string): void {
    if (config.unlimitedAiTesting) return;
    const currentTime = this.now();
    const record = this.records.get(ip);

    if (!record || currentTime - record.windowStart >= this.windowMs) {
      this.records.set(ip, {
        count: 1,
        windowStart: currentTime,
      });
      this.pruneStale(currentTime);
      return;
    }

    record.count += 1;
  }

  private pruneStale(currentTime: number): void {
    if (this.records.size > 1000) {
      for (const [ip, rec] of this.records.entries()) {
        if (currentTime - rec.windowStart >= this.windowMs) {
          this.records.delete(ip);
        }
      }
    }
  }

  resetForTesting(): void {
    this.records.clear();
  }
}

export const rateLimitService = new RateLimitService();
