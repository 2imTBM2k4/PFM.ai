import { validateDate } from '@pfm/domain';

/**
 * Converts a stored YYYY-MM-DD string into a local Date anchored at noon to prevent timezone day shifts.
 */
export function parseIsoDateToLocalDate(value: string, fallbackIso: string): Date {
  let resolved = fallbackIso;
  try {
    resolved = validateDate(value);
  } catch {
    try {
      resolved = validateDate(fallbackIso);
    } catch {
      return new Date();
    }
  }
  const year = Number(resolved.slice(0, 4));
  const month = Number(resolved.slice(5, 7));
  const day = Number(resolved.slice(8, 10));
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  date.setFullYear(year);
  return date;
}

/**
 * Formats a local JS Date back into canonical YYYY-MM-DD storage format.
 */
export function formatLocalDateToIso(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}
