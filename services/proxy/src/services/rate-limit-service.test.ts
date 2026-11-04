import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config';
import { QuotaService } from './quota-service';
import { RateLimitService } from './rate-limit-service';

const originalUnlimitedAiTesting = config.unlimitedAiTesting;

describe('RateLimitService', () => {
  let service: RateLimitService;

  beforeEach(() => {
    config.unlimitedAiTesting = false;
    // 3 requests per 1000ms window for testing
    service = new RateLimitService({
      maxRequests: 3,
      windowMs: 1000,
    });
  });

  afterEach(() => {
    config.unlimitedAiTesting = originalUnlimitedAiTesting;
  });

  it('allows requests within the limit', () => {
    const status1 = service.checkRateLimit('192.168.1.10');
    expect(status1.allowed).toBe(true);
    expect(status1.remaining).toBe(3);

    service.consumeRateLimit('192.168.1.10');

    const status2 = service.checkRateLimit('192.168.1.10');
    expect(status2.allowed).toBe(true);
    expect(status2.remaining).toBe(2);

    service.consumeRateLimit('192.168.1.10');
    service.consumeRateLimit('192.168.1.10');

    const status3 = service.checkRateLimit('192.168.1.10');
    expect(status3.allowed).toBe(false);
    expect(status3.remaining).toBe(0);
    expect(status3.resetInMs).toBeGreaterThan(0);
  });

  it('tracks different IP addresses independently', () => {
    service.consumeRateLimit('10.0.0.1');
    service.consumeRateLimit('10.0.0.1');
    service.consumeRateLimit('10.0.0.1');

    expect(service.checkRateLimit('10.0.0.1').allowed).toBe(false);
    expect(service.checkRateLimit('10.0.0.2').allowed).toBe(true);
    expect(service.checkRateLimit('10.0.0.2').remaining).toBe(3);
  });

  it('resets counters after window expires', () => {
    let fakeTime = 10000;
    const timeService = new RateLimitService({
      maxRequests: 2,
      windowMs: 500,
      clock: () => fakeTime,
    });

    timeService.consumeRateLimit('10.0.0.5');
    timeService.consumeRateLimit('10.0.0.5');
    expect(timeService.checkRateLimit('10.0.0.5').allowed).toBe(false);

    // Fast-forward time past 500ms
    fakeTime += 501;

    const afterWindow = timeService.checkRateLimit('10.0.0.5');
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.remaining).toBe(2);
  });

  it('resets correctly for testing', () => {
    service.consumeRateLimit('1.2.3.4');
    service.consumeRateLimit('1.2.3.4');
    service.consumeRateLimit('1.2.3.4');
    expect(service.checkRateLimit('1.2.3.4').allowed).toBe(false);

    service.resetForTesting();
    expect(service.checkRateLimit('1.2.3.4').allowed).toBe(true);
    expect(service.checkRateLimit('1.2.3.4').remaining).toBe(3);
  });
});

describe('unlimited local AI testing', () => {
  const previous = config.unlimitedAiTesting;
  afterEach(() => {
    config.unlimitedAiTesting = previous;
  });

  it('does not consume device or IP allowance while testing', () => {
    config.unlimitedAiTesting = true;
    const quota = new QuotaService();
    const rate = new RateLimitService({ maxRequests: 1 });
    for (let index = 0; index < 3; index++) {
      expect(quota.checkQuota('device').allowed).toBe(true);
      expect(rate.checkRateLimit('127.0.0.1').allowed).toBe(true);
      quota.consumeQuestionOnce('device', `question-${index}`);
      quota.consumeQuota('device');
      rate.consumeRateLimit('127.0.0.1');
    }
    expect(quota.checkQuota('device').remaining).toBeGreaterThan(100);
  });

  it('keeps the normal allowance when testing is disabled', () => {
    config.unlimitedAiTesting = false;
    const quota = new QuotaService();
    const rate = new RateLimitService({ maxRequests: 1 });
    rate.consumeRateLimit('127.0.0.1');
    expect(rate.checkRateLimit('127.0.0.1').allowed).toBe(false);
    for (let index = 0; index < config.dailyLimitPerDevice; index++)
      quota.consumeQuota('device');
    expect(quota.checkQuota('device').allowed).toBe(false);
  });
});
