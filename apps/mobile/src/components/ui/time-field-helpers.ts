/**
 * Parses a 24-hour HH:MM string into numeric hour and minute values, defaulting to 20:00 when invalid.
 */
export function parseReminderTime(time: string): {
  hour: number;
  minute: number;
} {
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(time);
  if (!match) return { hour: 20, minute: 0 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Formats hour and minute integers into canonical 24-hour HH:MM format.
 */
export function formatHourMinute(hour: number, minute: number): string {
  const normalizedHour = ((Math.trunc(hour) % 24) + 24) % 24;
  const normalizedMinute = ((Math.trunc(minute) % 60) + 60) % 60;
  return (
    String(normalizedHour).padStart(2, '0') +
    ':' +
    String(normalizedMinute).padStart(2, '0')
  );
}

/**
 * Converts an HH:MM string into a local Date for native time pickers.
 */
export function parseTimeToLocalDate(time: string, reference = new Date()): Date {
  const { hour, minute } = parseReminderTime(time);
  const date = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
    hour,
    minute,
    0,
    0,
  );
  return date;
}

/**
 * Extracts canonical 24-hour HH:MM from a JS Date emitted by a native time picker.
 */
export function formatDateToTime(date: Date): string {
  return formatHourMinute(date.getHours(), date.getMinutes());
}

/**
 * Parses and validates user-typed hour and minute strings, returning HH:MM or null when invalid.
 */
export function parseHourMinuteInputs(
  hourText: string,
  minuteText: string,
): string | null {
  const trimmedHour = hourText.trim();
  const trimmedMinute = minuteText.trim();
  if (!/^\d{1,2}$/.test(trimmedHour) || !/^\d{1,2}$/.test(trimmedMinute)) {
    return null;
  }
  const hour = Number(trimmedHour);
  const minute = Number(trimmedMinute);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return formatHourMinute(hour, minute);
}
