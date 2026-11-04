import { addDays, addMonths, startOfWeek, today, validateDate } from '../dates';
import type { Clock } from '../dates';
import { matchingText } from './text';
import type { ParsedEntry, ParseWarning, Span } from './types';

const pad = (value: number) => String(value).padStart(2, '0');
const DATE_PATTERN =
  /\b(?:hom (?:nay|qua|kia)|(?:sang|trua|chieu|toi) (?:nay|qua)|ngay mai|(?:thu [2-7]|chu nhat)(?: tuan truoc)?|(?:ngay )?\d+[/-]\d+(?:[/-]\d+)?|ngay \d+)/g;

// Share date syntax with learning so edited notes cannot train on date words.
export function dateMentions(folded: string) {
  return [...folded.matchAll(DATE_PATTERN)].filter(
    (match) =>
      !/[a-z0-9]/.test(folded[match.index - 1] ?? '') &&
      !/[a-z0-9]/.test(folded[match.index + match[0].length] ?? ''),
  );
}
const calendarDate = (year: number, month: number, day: number) =>
  validateDate(`${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`);

// Format local time with its offset at the target date, including DST changes.
function timeHint(
  value: string,
  bucket: number | undefined,
  reference: Date,
  clock: Clock,
  current: string,
): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: clock.timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = (date: Date) =>
    Object.fromEntries(
      formatter.formatToParts(date).map((part) => [part.type, part.value]),
    );
  const now = parts(reference);
  const useNow =
    value === current && (bucket === undefined || bucket > Number(now.hour));
  const time = useNow
    ? `${now.hour}:${now.minute}:${now.second}`
    : `${pad(bucket ?? 12)}:00:00`;
  const local = new Date(`${value}T${time}Z`).getTime();
  let instant = local;
  let offset = useNow ? Math.round((local - reference.getTime()) / 60000) : 0;
  // Current instants retain their actual offset when the local hour repeats.
  for (let i = 0; !useNow && i < 3; i++) {
    const fields = parts(new Date(instant));
    const represented = new Date(
      `${fields.year.padStart(4, '0')}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}Z`,
    ).getTime();
    offset = Math.round((represented - instant) / 60000);
    instant = local - offset * 60000;
  }
  const magnitude = Math.abs(offset);
  return `${value}T${time}${offset < 0 ? '-' : '+'}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`;
}

// Remove date/time digits before money matching, preserving original text spans.
export function extractDate(
  text: string,
  clock: Clock,
): {
  date: ParsedEntry['date'];
  occurredAtHint: string | null;
  excluded: Span[];
  removed: Span[];
  warnings: ParseWarning[];
  rule: string;
} {
  const reference = clock.now();
  const frozenClock = { timeZone: clock.timeZone, now: () => reference };
  const current = today(frozenClock);
  const view = matchingText(text);
  const removed: Span[] = [];
  const excluded: Span[] = [];
  const warnings: ParseWarning[] = [];
  let date: ParsedEntry['date'] = {
    value: current,
    confidence: 'high',
    matchedText: null,
    defaulted: true,
  };
  let rule = 'date.default_today';
  for (const match of dateMentions(view.folded)) {
    const start = match.index;
    const token = match[0];
    const span = view.span(start, start + token.length);
    excluded.push(span);
    removed.push(span);
    if (!date.defaulted) continue;
    date = {
      value: null,
      confidence: 'high',
      matchedText: text.slice(span.start, span.end),
      defaulted: false,
    };
    rule = 'date.explicit';
    try {
      if (/^(hom|sang|trua|chieu|toi) /.test(token)) {
        date.value = addDays(
          current,
          token.endsWith('qua') ? -1 : token.endsWith('kia') ? -2 : 0,
        );
        rule = 'date.relative';
      } else if (token === 'ngay mai') {
        date.value = addDays(current, 1);
        rule = 'date.relative';
      } else if (/^(thu |chu nhat)/.test(token)) {
        const weekday = token.startsWith('chu') ? 6 : Number(token[4]) - 2;
        if (token.endsWith('tuan truoc'))
          date.value = addDays(startOfWeek(current), weekday - 7);
        else {
          date.confidence = 'medium';
          date.value = addDays(startOfWeek(current), weekday);
          if (date.value > current) date.value = addDays(date.value, -7);
        }
        rule = 'date.weekday';
      } else if (/^ngay \d+$/.test(token)) {
        const day = Number(token.slice(5));
        const month =
          day > Number(current.slice(8))
            ? addMonths(current.slice(0, 8) + '01', -1)
            : current;
        date.value = calendarDate(
          Number(month.slice(0, 4)),
          Number(month.slice(5, 7)),
          day,
        );
        date.confidence = 'medium';
        rule = 'date.day_of_month';
      } else {
        const numeric = token.replace(/^ngay /, '');
        const [day, month, year] = numeric.split(/[/-]/);
        const targetYear = year
          ? year.length === 2
            ? 2000 + Number(year)
            : Number(year)
          : Number(current.slice(0, 4));
        if (!/^\d{1,2}[/-]\d{1,2}(?:[/-](?:\d{2}|\d{4}))?$/.test(numeric))
          throw new RangeError('Invalid date format.');
        date.value = calendarDate(targetYear, Number(month), Number(day));
        if (!year && date.value > current) {
          date.confidence = 'medium';
          if (date.value > addDays(current, 7))
            date.value = calendarDate(
              targetYear - 1,
              Number(month),
              Number(day),
            );
        }
        rule = 'date.numeric';
      }
      if (date.value > current) warnings.push('FUTURE_DATE');
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      date.value = null;
      date.confidence = 'low';
      warnings.push('INVALID_DATE');
    }
  }
  for (const match of view.folded.matchAll(
    /\b(?:thang \d+|nam \d+|\d+h(?:\d+)?)/g,
  )) {
    if (
      /[a-z0-9]/.test(view.folded[match.index - 1] ?? '') ||
      /[a-z0-9]/.test(view.folded[match.index + match[0].length] ?? '')
    )
      continue;
    excluded.push(view.span(match.index, match.index + match[0].length));
  }
  const bucketMatch = /(?:^|[^a-z])(sang|trua|chieu|toi)(?![a-z])/.exec(
    view.folded,
  );
  const buckets: Record<string, number> = {
    sang: 8,
    trua: 12,
    chieu: 15,
    toi: 19,
  };
  return {
    date,
    occurredAtHint: date.value
      ? timeHint(
          date.value,
          bucketMatch ? buckets[bucketMatch[1]] : undefined,
          reference,
          frozenClock,
          current,
        )
      : null,
    excluded,
    removed,
    warnings,
    rule,
  };
}
