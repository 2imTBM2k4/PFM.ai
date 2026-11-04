import { config } from '../config';

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

  checkQuota(deviceId: string): QuotaStatus {
    if (config.unlimitedAiTesting)
      return {
        allowed: true,
        remaining: Number.MAX_SAFE_INTEGER,
        limit: Number.MAX_SAFE_INTEGER,
        resetAt: this.getNextResetIso(),
      };
    const dateKey = this.getVietnamDateKey();
    const key = `${deviceId}:${dateKey}`;
    const used = this.counters.get(key) ?? 0;
    const remaining = Math.max(0, config.dailyLimitPerDevice - used);

    return {
      allowed: remaining > 0,
      remaining,
      limit: config.dailyLimitPerDevice,
      resetAt: this.getNextResetIso(),
    };
  }

  consumeQuota(deviceId: string): void {
    if (config.unlimitedAiTesting) return;
    const dateKey = this.getVietnamDateKey();
    const key = `${deviceId}:${dateKey}`;
    const used = this.counters.get(key) ?? 0;
    this.counters.set(key, used + 1);
  }

  consumeQuestionOnce(deviceId: string, requestId: string): void {
    if (config.unlimitedAiTesting) return;
    const key = `${deviceId}:${this.getVietnamDateKey()}:${requestId}`;
    if (this.completed.has(key)) return;
    this.completed.add(key);
    this.consumeQuota(deviceId);
  }

  resetForTesting(): void {
    this.counters.clear();
    this.completed.clear();
  }
}

export const quotaService = new QuotaService();
