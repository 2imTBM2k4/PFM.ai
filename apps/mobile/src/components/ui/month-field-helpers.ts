import {
  calendarMonthFromKey,
  formatCalendarMonthKey,
  vietnamToday,
} from '@/utils/calendar';

export interface MonthDraft {
  year: number;
  monthIndex: number; // zero-based 0..11
}

/**
 * Parses a YYYY-MM month key into zero-based month and year, falling back safely to the current month.
 */
export function parseMonthKeyToDraft(
  value: string,
  fallbackKey = vietnamToday().slice(0, 7),
): MonthDraft {
  const parsed = calendarMonthFromKey(value, fallbackKey);
  return { year: parsed.year, monthIndex: parsed.month };
}

/**
 * Formats a MonthDraft back into canonical YYYY-MM format.
 */
export function formatMonthDraftToKey(draft: MonthDraft): string {
  return formatCalendarMonthKey({ year: draft.year, month: draft.monthIndex });
}

/**
 * Builds an ascending year list covering both the current year and selected year within a +/- span.
 */
export function buildMonthYearOptions(
  selectedYear: number,
  currentYear: number,
  span = 30,
): number[] {
  const safeSpan = Math.max(1, Math.floor(span));
  const minYear = Math.max(1, Math.min(selectedYear, currentYear) - safeSpan);
  const maxYear = Math.min(9999, Math.max(selectedYear, currentYear) + safeSpan);
  const years: number[] = [];
  for (let year = minYear; year <= maxYear; year += 1) {
    years.push(year);
  }
  return years;
}

/**
 * Returns 12 localized labels for the iOS month wheel picker.
 */
export function getMonthWheelLabels(
  language: 'vi' | 'en',
  monthPrefix: string,
): string[] {
  return Array.from({ length: 12 }, (_, index) =>
    language === 'en'
      ? monthPrefix + ' ' + String(index + 1).padStart(2, '0')
      : monthPrefix + ' ' + String(index + 1),
  );
}
