import { MAX_AMOUNT_VND, today, validateDate } from '@pfm/domain';

const AMOUNT_PATTERN = /^(?:\d+|\d{1,3}(?:\.\d{3})+)$/;

export function formatAmountInput(value: string, previous = '', currency: 'VND' | 'USD' = 'VND') {
  if (currency === 'USD') return value;
  const inserting = value.length > previous.length;
  const longer = inserting ? value : previous;
  const shorter = inserting ? previous : value;
  // Native text edits retain old separators until we regroup the new digits.
  if (
    AMOUNT_PATTERN.test(previous) &&
    longer.length === shorter.length + 1 &&
    [...longer].some(
      (character, index) =>
        (!inserting || /\d/.test(character)) &&
        longer.slice(0, index) + longer.slice(index + 1) === shorter,
    )
  )
    value = value.replace(/\./g, '');
  if (!AMOUNT_PATTERN.test(value)) return value;
  return value
    .replace(/\./g, '')
    .replace(/^0+(?=\d)/, '')
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function parseAmountInput(value: string, currency: 'VND' | 'USD' = 'VND') {
  if (currency === 'USD') {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value))
      throw new Error('TRANSACTION_AMOUNT');
    const amount = Math.round(Number(value) * 100);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_VND)
      throw new Error('TRANSACTION_AMOUNT');
    return amount;
  }
  if (!AMOUNT_PATTERN.test(value)) throw new Error('TRANSACTION_AMOUNT');
  const amount = Number(value.replace(/\./g, ''));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_VND)
    throw new Error('TRANSACTION_AMOUNT');
  return amount;
}

const TIME_HM_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const VN_TIME_FORMATTER = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Extracts HH:mm in Vietnam timezone from an ISO timestamp (or falls back to current time). */
export function extractVietnamTime(
  occurredAt: string | null | undefined,
  fallbackNow: Date = new Date(),
): string {
  const parsed = occurredAt ? new Date(occurredAt) : fallbackNow;
  const target = Number.isNaN(parsed.getTime()) ? fallbackNow : parsed;
  const parts = VN_TIME_FORMATTER.formatToParts(target);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '12';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

export function manualOccurredAt(date: string, now: Date, time?: string) {
  validateDate(date);
  if (date === today({ now: () => now, timeZone: 'Asia/Ho_Chi_Minh' })) {
    return now.toISOString();
  }
  if (time && TIME_HM_PATTERN.test(time)) {
    return `${date}T${time}:00+07:00`;
  }
  return `${date}T12:00:00+07:00`;
}

export function isFutureDate(date: string, now: Date) {
  return (
    validateDate(date) > today({ now: () => now, timeZone: 'Asia/Ho_Chi_Minh' })
  );
}
