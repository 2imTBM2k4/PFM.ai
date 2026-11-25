import { afterEach, beforeEach, expect, it } from 'vitest';
import { config } from '../config';
import { QuotaService } from './quota-service';

const previous = { ...config };
let quota: QuotaService;
beforeEach(() => {
  config.unlimitedAiTesting = false;
  config.dailyLimitPerDevice = 1;
  quota = new QuotaService();
});
afterEach(() => Object.assign(config, previous));

it('reserves the last daily slot atomically against a second admission', () => {
  const first = quota.reserveQuota('device');
  expect(first.allowed).toBe(true);
  expect(quota.reserveQuota('device').allowed).toBe(false);
  expect(quota.checkQuota('device').remaining).toBe(0);
});
it('refunds a failed reservation once and cannot refund a later charge', () => {
  const first = quota.reserveQuota('device');
  if (!first.allowed) throw new Error('Admission failed');
  first.finish(false);
  quota.consumeQuota('device');
  first.finish(false);
  expect(quota.checkQuota('device').remaining).toBe(0);
});
it('keeps a successful charge exactly once', () => {
  const first = quota.reserveQuota('device');
  if (!first.allowed) throw new Error('Admission failed');
  first.finish(true);
  first.finish(false);
  expect(quota.checkQuota('device').remaining).toBe(0);
});
it('shares counters with legacy charges and separates guest/authenticated identity', () => {
  quota.consumeQuota('device');
  expect(quota.reserveQuota('device').allowed).toBe(false);
  expect(quota.reserveQuota('device', 'authenticated').allowed).toBe(true);
});
