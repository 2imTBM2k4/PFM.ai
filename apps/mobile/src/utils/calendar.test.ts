import { describe, expect, it } from 'vitest';
import {
  calendarDays,
  calendarMonth,
  parseDisplayMonth,
  shiftCalendarMonth,
  vietnamToday,
} from './calendar';

describe('calendar date picker helpers', () => {
  it('uses Vietnam midnight rather than the device calendar day', () => {
    expect(vietnamToday(new Date('2026-10-27T16:59:59Z'))).toBe('2026-10-27');
    expect(vietnamToday(new Date('2026-10-27T17:00:00Z'))).toBe('2026-10-28');
    expect(vietnamToday(new Date('2026-10-28T02:00:00Z'))).toBe('2026-10-28');
  });

  it('preserves years 0001, 0099 and 9999 without Date constructor remapping', () => {
    for (const year of [1, 99, 9999]) {
      const prefix = `${String(year).padStart(4, '0')}-02`;
      const view = calendarMonth(`${prefix}-01`);
      expect(view).toEqual({ year, month: 1 });
      const days = calendarDays(view).filter((day) => day !== null);
      expect(days[0]?.date).toBe(`${prefix}-01`);
      expect(days.at(-1)?.date).toBe(`${prefix}-28`);
    }
    expect(calendarDays({ year: 1, month: 0 })[0]).toEqual({
      day: 1,
      date: '0001-01-01',
    });
  });

  it('uses Gregorian leap-year rules and Monday-first padding', () => {
    expect(calendarDays({ year: 2000, month: 1 }).filter(Boolean)).toHaveLength(
      29,
    );
    expect(calendarDays({ year: 1900, month: 1 }).filter(Boolean)).toHaveLength(
      28,
    );
    const february = calendarDays({ year: 2024, month: 1 });
    expect(february.slice(0, 3)).toEqual([null, null, null]);
    expect(february[3]).toEqual({ day: 1, date: '2024-02-01' });
  });

  it('clamps navigation at supported year boundaries', () => {
    expect(shiftCalendarMonth({ year: 1, month: 0 }, -1)).toEqual({
      year: 1,
      month: 0,
    });
    expect(shiftCalendarMonth({ year: 9999, month: 11 }, 1)).toEqual({
      year: 9999,
      month: 11,
    });
    expect(shiftCalendarMonth({ year: 99, month: 11 }, 1)).toEqual({
      year: 100,
      month: 0,
    });
    expect(shiftCalendarMonth({ year: 2026, month: 0 }, -1)).toEqual({
      year: 2025,
      month: 11,
    });
  });

  it('rejects rollover dates and invalid years and falls back safely for blank optional dates', () => {
    for (const value of [
      '',
      '2026-02-31',
      '2026-13-01',
      '0000-01-01',
      '10000-01-01',
      '2026-2-01',
    ]) {
      expect(calendarMonth(value, '2024-02-29')).toEqual({
        year: 2024,
        month: 1,
      });
    }
    expect(() => calendarDays({ year: 0, month: 0 })).toThrow();
    expect(() => calendarDays({ year: 10000, month: 0 })).toThrow();
    expect(parseDisplayMonth('2/0001')).toEqual({ year: 1, month: 1 });
    expect(parseDisplayMonth('12/9999')).toEqual({ year: 9999, month: 11 });
    for (const value of [
      '13/2026',
      '00/2026',
      '02/0000',
      '02/10000',
      '2/99',
      '2026-02',
    ]) {
      expect(parseDisplayMonth(value)).toBeNull();
    }
  });
});
