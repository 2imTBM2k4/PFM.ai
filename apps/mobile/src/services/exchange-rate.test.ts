import { expect, it, vi } from 'vitest';
import { fetchUsdVndRate, loadUsdVndRate } from './exchange-rate';

it('accepts only a dated, positive USD/VND network rate', async () => {
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({ date: '2026-11-02', base: 'USD', quote: 'VND', rate: 25_500 }),
  }));
  await expect(fetchUsdVndRate(fetcher as never)).resolves.toEqual({ date: '2026-11-02', rate: 25_500 });
  expect(fetcher).toHaveBeenCalledWith('https://api.frankfurter.dev/v2/rate/usd/vnd', { signal: expect.any(AbortSignal) });
  fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ date: '2026-11-02', base: 'USD', quote: 'VND', rate: 0 }) });
  await expect(fetchUsdVndRate(fetcher as never)).rejects.toThrow('EXCHANGE_RATE_INVALID');
  fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ date: '2026-11-02', base: 'USD', quote: 'VND', rate: 1_000_001 }) });
  await expect(fetchUsdVndRate(fetcher as never)).rejects.toThrow('EXCHANGE_RATE_INVALID');
});

it('uses a dated cached rate when network fails and rejects a missing rate', async () => {
  const settings = new Map<string, string>([['usd_vnd_rate', JSON.stringify({ date: '2026-11-01', rate: 25_000 })]]);
  const db = {
    getFirstAsync: async (_sql: string, key: string) => ({ value: settings.get(key) ?? '' }),
    runAsync: async (_sql: string, key: string, value: string) => { settings.set(key, value); },
  };
  const offline = vi.fn(async () => { throw new Error('offline'); });
  await expect(loadUsdVndRate(db as never, offline as never)).resolves.toEqual({ date: '2026-11-01', rate: 25_000, cached: true });
  settings.clear();
  await expect(loadUsdVndRate(db as never, offline as never)).rejects.toThrow('EXCHANGE_RATE_UNAVAILABLE');
});
