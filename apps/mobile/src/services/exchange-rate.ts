import type { Queries } from '@/data/migrate';

export interface ExchangeRate {
  date: string;
  rate: number;
}

const SETTING_KEY = 'usd_vnd_rate';
const RATE_URL = 'https://api.frankfurter.dev/v2/rate/usd/vnd';
// shortcut: broad USD/VND sanity range, revisit if the pair moves outside it.

function validRate(value: unknown): value is ExchangeRate {
  if (!value || typeof value !== 'object') return false;
  const rate = value as Record<string, unknown>;
  return (
    typeof rate.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(rate.date) &&
    typeof rate.rate === 'number' &&
    Number.isFinite(rate.rate) &&
    rate.rate >= 1_000 && rate.rate <= 1_000_000
  );
}

export async function fetchUsdVndRate(fetchImpl: typeof fetch = fetch): Promise<ExchangeRate> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(RATE_URL, { signal: controller.signal });
    if (!response.ok) throw new Error('EXCHANGE_RATE_UNAVAILABLE');
    const data: unknown = await response.json();
    if (!validRate(data)) throw new Error('EXCHANGE_RATE_INVALID');
    const pair = data as ExchangeRate & { base?: string; quote?: string };
    if (pair.base !== 'USD' || pair.quote !== 'VND') throw new Error('EXCHANGE_RATE_INVALID');
    return { date: pair.date, rate: pair.rate };
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadUsdVndRate(
  db: Queries,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeRate & { cached: boolean }> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key=?',
    SETTING_KEY,
  );
  let previous: unknown;
  try { previous = row?.value ? JSON.parse(row.value) : null; } catch { previous = null; }
  try {
    const latest = await fetchUsdVndRate(fetchImpl);
    await db.runAsync(
      'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      SETTING_KEY,
      JSON.stringify(latest),
    );
    return { ...latest, cached: false };
  } catch {
    if (validRate(previous)) return { ...previous, cached: true };
    throw new Error('EXCHANGE_RATE_UNAVAILABLE');
  }
}
