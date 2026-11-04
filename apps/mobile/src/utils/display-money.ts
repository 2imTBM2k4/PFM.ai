import { formatCompactVnd } from '@pfm/domain';
import { formatCurrencyAmount, usePreferences } from '@/state/preferences';

export function formatMoney(amountVnd: number): string {
  return formatCurrencyAmount(amountVnd, usePreferences.getState().currency);
}

export function formatCompactMoney(amountVnd: number): string {
  const { currency } = usePreferences.getState();
  return currency === 'USD'
    ? formatCurrencyAmount(amountVnd, currency, { compact: true })
    : formatCompactVnd(amountVnd);
}
