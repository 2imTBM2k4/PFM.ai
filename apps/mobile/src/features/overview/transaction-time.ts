import { vi } from '@/messages/vi';

const TIME_FORMATTER = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Returns the YYYY-MM-DD date string for the day immediately before `dateStr`.
 */
export function getYesterdayDateString(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d - 1));
  const year = String(utc.getUTCFullYear()).padStart(4, '0');
  const month = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Formats a transaction's `occurred_on` (YYYY-MM-DD) and `occurred_at` (ISO-8601)
 * into a human-friendly label matching the reference design:
 * e.g., "Hôm nay, 10:30", "Hôm qua, 20:00", or "05/10, 09:00".
 * Omits the time suffix if `occurred_at` is the synthetic noon placeholder ('T12:00:00+07:00')
 * generated when backdating a manual entry without a time picker.
 */
export function formatRecentTransactionTime(
  occurredOn: string,
  occurredAt: string | null | undefined,
  todayDate: string,
): string {
  const yesterdayDate = getYesterdayDateString(todayDate);

  let dateLabel: string;
  if (occurredOn === todayDate) {
    dateLabel = vi.txTimeToday;
  } else if (occurredOn === yesterdayDate) {
    dateLabel = vi.txTimeYesterday;
  } else {
    const [year, month, day] = occurredOn.split('-');
    const todayYear = todayDate.slice(0, 4);
    dateLabel =
      year === todayYear ? `${day}/${month}` : `${day}/${month}/${year}`;
  }

  if (!occurredAt) {
    return dateLabel;
  }

  // Manual backdated entries without a time picker use the exact noon placeholder
  if (occurredOn !== todayDate && occurredAt === `${occurredOn}T12:00:00+07:00`) {
    return dateLabel;
  }

  const parsed = new Date(occurredAt);
  if (Number.isNaN(parsed.getTime())) {
    return dateLabel;
  }

  const parts = TIME_FORMATTER.formatToParts(parsed);
  const hour = parts.find((p) => p.type === 'hour')?.value;
  const minute = parts.find((p) => p.type === 'minute')?.value;
  if (!hour || !minute) {
    return dateLabel;
  }

  return `${dateLabel}, ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

