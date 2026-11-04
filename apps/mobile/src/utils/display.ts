import { formatVnd } from '@pfm/domain';
import { formatCurrencyAmount, usePreferences } from '@/state/preferences';

/**
 * Formats a stored ISO date (YYYY-MM-DD) for the selected language without changing
 * the value used by forms, parsers or the database.
 */
export function formatDisplayDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  if (usePreferences.getState().language === 'en') return `${match[2]}/${match[3]}/${match[1]}`;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/**
 * Formats a stored month key (YYYY-MM) as MM/YYYY.
 */
export function formatDisplayMonth(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${match[2]}/${match[1]}`;
}

/**
 * Formats a month key as a compact chart label (T10 for October).
 */
export function formatDisplayMonthShort(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${usePreferences.getState().language === 'en' ? 'M' : 'T'}${Number(match[2])}`;
}

/**
 * Compact Vietnamese money label for small dashboard cards.
 * Uses "tr"/"tỷ" rather than the English "M"/"B" so dashboard values stay
 * consistent with the rest of the Vietnamese interface.
 */
export function formatCompactVndShort(value: number): string {
  const { currency, language } = usePreferences.getState();
  if (currency === 'USD' || language === 'en')
    return formatCurrencyAmount(value, currency, { compact: true });
  if (!Number.isSafeInteger(value)) return formatVnd(value);
  const absolute = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (absolute >= 1_000_000_000) {
    return `${sign}${trimTenth(absolute / 1_000_000_000)} tỷ`;
  }
  if (absolute >= 1_000_000) {
    return `${sign}${trimTenth(absolute / 1_000_000)} tr`;
  }
  if (absolute >= 1_000) {
    return `${sign}${Math.round(absolute / 1_000)}k`;
  }
  return formatVnd(value);
}

function trimTenth(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded.toString().replace('.', ',').replace(/,0$/, '');
}
