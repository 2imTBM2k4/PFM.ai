import { roundHalfUp } from './arithmetic';

export const MAX_AMOUNT_VND = 100_000_000_000;

export type Money = number & { readonly __brand: 'Money' };
export type Currency = 'VND' | 'USD';

// Convert integer minor units using the number of VND per one USD.
export function convertMoney(
  amountMinor: number,
  from: Currency,
  to: Currency,
  vndPerUsd: number | null,
): number {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError('INVALID_MONEY');
  if (from === to) return amountMinor;
  if (vndPerUsd === null || !Number.isFinite(vndPerUsd) || vndPerUsd <= 0)
    throw new RangeError('INVALID_EXCHANGE_RATE');
  const converted = Math.round(
    from === 'USD'
      ? (amountMinor * vndPerUsd) / 100
      : (amountMinor * 100) / vndPerUsd,
  );
  if (!Number.isSafeInteger(converted) || Math.abs(converted) > MAX_AMOUNT_VND)
    throw new RangeError('CONVERTED_MONEY_OUT_OF_RANGE');
  return converted;
}

// Validate a non-negative whole-VND amount within the transaction limit.
export function toMoney(value: number): Money {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_AMOUNT_VND) {
    throw new RangeError(
      'Money must be a non-negative safe integer within MAX_AMOUNT_VND.',
    );
  }
  return value as Money;
}

// Format a signed whole-VND value without relying on platform Intl support.
export function formatVnd(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('A formatted VND amount must be a safe integer.');
  }
  const digits = String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${value < 0 ? '-' : ''}${digits} ₫`;
}

// Round display labels to one decimal; calculations continue using whole VND.
export function formatCompactVnd(value: number): string {
  if (!Number.isSafeInteger(value))
    throw new RangeError('A formatted VND amount must be a safe integer.');
  const absolute = Math.abs(value);
  if (absolute < 1000) return formatVnd(value);
  for (const [divisor, suffix] of [
    [1000000000, ' tỷ'],
    [1000000, ' triệu'],
    [1000, 'k'],
  ] as const) {
    const tenths = roundHalfUp(absolute, divisor / 10);
    if (tenths >= 10) {
      const whole = Math.trunc(tenths / 10);
      const fraction = tenths % 10;
      return `${value < 0 ? '-' : ''}${whole}${fraction ? `,${fraction}` : ''}${suffix}`;
    }
  }
  return formatVnd(value);
}
