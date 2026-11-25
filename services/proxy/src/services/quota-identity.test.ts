import { expect, it } from 'vitest';
import { QuotaService } from './quota-service';
import { config } from '../config';

it('keeps daily quotas separate for a guest and a verified subject with the same string', () => {
  const before = config.unlimitedAiTesting;
  config.unlimitedAiTesting = false;
  try {
    const quota = new QuotaService();
    quota.consumeQuota('same', 'guest');
    expect(quota.checkQuota('same', 'authenticated').remaining).toBe(
      config.dailyLimitPerDevice,
    );
    expect(quota.checkQuota('same', 'guest').remaining).toBe(
      config.dailyLimitPerDevice - 1,
    );
  } finally {
    config.unlimitedAiTesting = before;
  }
});
