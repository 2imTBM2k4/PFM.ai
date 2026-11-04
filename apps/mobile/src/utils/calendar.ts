import { daysInMonth, today, validateDate } from '@pfm/domain';

export interface CalendarMonth {
  year: number;
  month: number; // zero-based
}

export function vietnamToday(now = new Date()): string {
  return today({ now: () => now, timeZone: 'Asia/Ho_Chi_Minh' });
}

export function calendarMonth(
  value: string,
  fallback = vietnamToday(),
): CalendarMonth {
  let date = fallback;
  try {
    date = validateDate(value);
  } catch {
    validateDate(fallback);
  }
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)) - 1,
  };
}

export function shiftCalendarMonth(
  current: CalendarMonth,
  delta: number,
): CalendarMonth {
  if (
    !Number.isInteger(current.year) ||
    !Number.isInteger(current.month) ||
    !Number.isSafeInteger(delta)
  ) {
    throw new RangeError(
      'Expected a valid calendar month and whole month offset.',
    );
  }
  daysInMonth(current.year, current.month + 1);
  const index = Math.max(
    0,
    Math.min(9999 * 12 - 1, (current.year - 1) * 12 + current.month + delta),
  );
  return { year: Math.floor(index / 12) + 1, month: index % 12 };
}

export function calendarDays({
  year,
  month,
}: CalendarMonth): ({ date: string; day: number } | null)[] {
  const prefix = `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`;
  validateDate(`${prefix}-01`);
  const firstWeekday = new Date(`${prefix}-01T12:00:00Z`).getUTCDay();
  const offset = (firstWeekday + 6) % 7;
  return [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: daysInMonth(year, month + 1) }, (_, index) => ({
      day: index + 1,
      date: `${prefix}-${String(index + 1).padStart(2, '0')}`,
    })),
  ];
}

/** Jump to MM/YYYY without pressing arrows hundreds of times. */
export function parseDisplayMonth(value: string): CalendarMonth | null {
  const match = /^(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const date = `${match[2]}-${match[1].padStart(2, '0')}-01`;
  try {
    validateDate(date);
    return calendarMonth(date);
  } catch {
    return null;
  }
}
