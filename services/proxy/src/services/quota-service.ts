import { config } from '../config';
import { aiContext } from '../middleware/logging';

export interface QuotaStatus {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: string;
}

export class QuotaService {
  private counters = new Map<string, number>();
  private completed = new Set<string>();

  // Determine current date in Asia/Ho_Chi_Minh timezone
  private getVietnamDateKey(): string {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(new Date()); // YYYY-MM-DD
  }

  // Calculate midnight ISO timestamp for the next day in Asia/Ho_Chi_Minh
  private getNextResetIso(): string {
    const now = new Date();
    const vnTomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const dateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(vnTomorrow);
    return `${dateStr}T00:00:00+07:00`;
  }

  checkQuota(
    deviceId: string,
    mode: 'guest' | 'authenticated' = 'guest',
  ): QuotaStatus {
    if (config.unlimitedAiTesting)
      return {
        allowed: true,
        remaining: Number.MAX_SAFE_INTEGER,
        limit: Number.MAX_SAFE_INTEGER,
        resetAt: this.getNextResetIso(),
      };
    const dateKey = this.getVietnamDateKey();
    const key = JSON.stringify([mode, deviceId, dateKey]);
    const used = this.counters.get(key) ?? 0;
    const remaining = Math.max(0, config.dailyLimitPerDevice - used);

    return {
      allowed: remaining > 0,
      remaining,
      limit: config.dailyLimitPerDevice,
      resetAt: this.getNextResetIso(),
    };
  }

  consumeQuota(
    deviceId: string,
    mode: 'guest' | 'authenticated' = 'guest',
  ): void {
    if (aiContext.getStore()?.consumeReservedQuota?.()) return;
    if (config.unlimitedAiTesting) return;
    const dateKey = this.getVietnamDateKey();
    const key = JSON.stringify([mode, deviceId, dateKey]);
    const used = this.counters.get(key) ?? 0;
    this.counters.set(key, used + 1);
  }

  /** Reserve before calling a model; settle once against the original day's counter. */
  reserveQuota(
    deviceId: string,
    mode: 'guest' | 'authenticated' = 'guest',
    requestId?: string,
  ): { allowed: false } | { allowed: true; finish(success: boolean): void } {
    const day = this.getVietnamDateKey();
    const completedKey = requestId
      ? JSON.stringify([mode, deviceId, day, requestId])
      : null;
    if (
      config.unlimitedAiTesting ||
      (completedKey && this.completed.has(completedKey))
    )
      return { allowed: true, finish() {} };
    const key = JSON.stringify([mode, deviceId, day]);
    const used = this.counters.get(key) ?? 0;
    if (used >= config.dailyLimitPerDevice) return { allowed: false };
    this.counters.set(key, used + 1);
    let settled = false;
    return {
      allowed: true,
      finish: (success) => {
        if (settled) return;
        settled = true;
        if (!success)
          this.counters.set(
            key,
            Math.max(0, (this.counters.get(key) ?? 0) - 1),
          );
      },
    };
  }

  consumeQuestionOnce(
    deviceId: string,
    requestId: string,
    mode: 'guest' | 'authenticated' = 'guest',
  ): void {
    if (config.unlimitedAiTesting) return;
    const key = JSON.stringify([
      mode,
      deviceId,
      this.getVietnamDateKey(),
      requestId,
    ]);
    if (this.completed.has(key)) return;
    this.completed.add(key);
    this.consumeQuota(deviceId, mode);
  }

  resetForTesting(): void {
    this.counters.clear();
    this.completed.clear();
  }
}

export const quotaService = new QuotaService();
