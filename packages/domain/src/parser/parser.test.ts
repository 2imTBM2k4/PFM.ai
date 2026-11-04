import { describe, expect, it } from 'vitest';
import { parseEntry } from './index';
import type { Clock } from '../dates';

const clock: Clock = {
  now: () => new Date('2026-10-23T09:00:00+07:00'),
  timeZone: 'Asia/Ho_Chi_Minh',
};
const parse = (text: string, reference = clock) =>
  parseEntry(text, { clock: reference });

it('parses English rent expenses in USD while respecting explicit VND', () => {
  const usd = parseEntry('spent $10.25 on rent', { clock, currency: 'USD' });
  expect(usd.candidates[0]).toMatchObject({
    kind: 'expense',
    categoryKey: 'expense.housing.rent',
    amount: { value: 1025, currency: 'USD' },
  });
  const implicit = parseEntry('spent 10 on rent', { clock, currency: 'USD' });
  expect(implicit.candidates[0].amount).toMatchObject({ value: 1000, currency: 'USD' });
  const vnd = parseEntry('spent 10,000 VND on rent', { clock, currency: 'USD' });
  expect(vnd.candidates[0].amount).toMatchObject({ value: 10000, currency: 'VND' });
});

it('classifies English quick-entry examples as food expenses and salary income', () => {
  const breakfast = parseEntry('spent $10 on breakfast', { clock, currency: 'USD' });
  expect(breakfast.candidates[0]).toMatchObject({ kind: 'expense', categoryKey: 'expense.food.eating_out', amount: { value: 1000, currency: 'USD' } });
  const salary = parseEntry('salary $500', { clock, currency: 'USD' });
  expect(salary.candidates[0]).toMatchObject({ kind: 'income', categoryKey: 'income.salary', amount: { value: 50_000, currency: 'USD' } });
});

describe('normative amounts', () => {
  it.each([
    ['ăn sáng 30k', 30000, 'high'],
    ['cf 25k', 25000, 'high'],
    ['2tr', 2000000, 'high'],
    ['lương 15tr', 15000000, 'high'],
    ['mua điện thoại 2tr5', 2500000, 'high'],
    ['1tr2', 1200000, 'high'],
    ['1,5tr', 1500000, 'high'],
    ['1.5tr', 1500000, 'high'],
    ['1.25tr', 1250000, 'high'],
    ['0,5tr', 500000, 'high'],
    ['1,5 triệu', 1500000, 'high'],
    ['2 triệu rưỡi', 2500000, 'high'],
    ['1 tỷ rưỡi', 1500000000, 'high'],
    ['3tr500', 3500000, 'high'],
    ['2tr05', 2050000, 'high'],
    ['1k5', 1500, 'high'],
    ['1,5k', 1500, 'high'],
    ['50 nghìn', 50000, 'high'],
    ['50 ngàn', 50000, 'high'],
    ['50.000đ', 50000, 'high'],
    ['50.000', 50000, 'medium'],
    ['1.500.000', 1500000, 'medium'],
    ['1,500,000', 1500000, 'medium'],
    ['1.500', 1500, 'medium'],
    ['2m', 2000000, 'medium'],
    ['2 củ', 2000000, 'medium'],
    ['1 lít', 100000, 'low'],
    ['ăn sáng 30', 30000, 'low'],
    ['mua 2 ly cf 50k', 50000, 'high'],
    ['lương tháng 10 15tr', 15000000, 'high'],
    ['15/10 ăn trưa 45k', 45000, 'high'],
    ['30K', 30000, 'high'],
    ['2TR', 2000000, 'high'],
    ['2 trieu', 2000000, 'high'],
    ['50 ngan', 50000, 'high'],
    ['3tỉ2', 3200000000, 'high'],
    ['100000tr', 100000000000, 'high'],
    ['50₫', 50, 'medium'],
    ['5000 VNĐ', 5000, 'high'],
  ])('%s → %s (%s)', (text, value, confidence) => {
    expect(parse(String(text)).candidates.map((c) => c.amount)).toEqual([
      { value, confidence, matchedText: expect.any(String) },
    ]);
  });

  it.each([
    ['0k', 'ZERO_AMOUNT'],
    ['1.200,50', 'NON_INTEGER_VND'],
    ['100001tr', 'AMOUNT_TOO_LARGE'],
    ['gửi xe', 'NO_AMOUNT'],
    ['0901234567', 'NO_AMOUNT'],
    ['７０００', 'NO_AMOUNT'],
    ['7h30', 'NO_AMOUNT'],
    ['7h', 'NO_AMOUNT'],
    ['tháng 10 năm 2026', 'NO_AMOUNT'],
    ['-30k', 'NO_AMOUNT'],
    ['abc30k', 'NO_AMOUNT'],
    ['30kilomet', 'NO_AMOUNT'],
  ])('%s is rejected with %s', (text, warning) => {
    expect(parse(text).warnings).toContain(warning);
    expect(parse(text).candidates[0].amount.value).toBeNull();
  });

  it('rounds fractional dong half up using exact arithmetic', () => {
    expect(parse('1k0005').candidates[0].amount).toMatchObject({
      value: 1001,
      confidence: 'low',
    });
    expect(parse('1k0005').warnings).toContain('NON_INTEGER_VND');
    expect(parse('1k0004').candidates[0].amount.value).toBe(1000);
    expect(parse('ăn sáng 30').warnings).toContain('ASSUMED_THOUSANDS');
  });

  it('keeps separate candidates and removes only each own amount', () => {
    const result = parse('cf 30k bánh 20k');
    expect(result.warnings).toContain('MULTIPLE_AMOUNTS');
    expect(result.candidates.map((c) => c.amount.value)).toEqual([
      30000, 20000,
    ]);
    expect(result.candidates.map((c) => c.noteText)).toEqual([
      'cf bánh 20k',
      'cf 30k bánh',
    ]);
  });

  it('preserves raw input, normalized original matching text and quantities', () => {
    const input = '  Mua\u00a02 ly  cà phê\n 50 NGÀN hôm qua  ';
    const result = parse(input);
    expect(result.raw).toBe(input);
    expect(result.candidates[0]).toMatchObject({
      amount: { value: 50000, matchedText: '50 NGÀN' },
      date: { matchedText: 'hôm qua' },
      noteText: 'Mua 2 ly cà phê',
    });
  });
});

describe('normative dates', () => {
  it.each([
    ['hôm nay', '2026-10-23', 'high'],
    ['sáng nay', '2026-10-23', 'high'],
    ['trưa nay', '2026-10-23', 'high'],
    ['chiều nay', '2026-10-23', 'high'],
    ['tối nay', '2026-10-23', 'high'],
    ['hôm qua', '2026-10-22', 'high'],
    ['tối qua', '2026-10-22', 'high'],
    ['chiều qua', '2026-10-22', 'high'],
    ['hôm kia', '2026-10-21', 'high'],
    ['ngày mai', '2026-10-24', 'high'],
    ['thứ 6', '2026-10-23', 'medium'],
    ['thứ 7', '2026-10-17', 'medium'],
    ['chủ nhật', '2026-10-18', 'medium'],
    ['thứ 2', '2026-10-19', 'medium'],
    ['thứ 6 tuần trước', '2026-10-16', 'high'],
    ['thứ 2 tuần trước', '2026-10-12', 'high'],
    ['ngày 15', '2026-10-15', 'medium'],
    ['ngày 25', '2026-09-25', 'medium'],
    ['15/10', '2026-10-15', 'high'],
    ['15-10', '2026-10-15', 'high'],
    ['15/10/2026', '2026-10-15', 'high'],
    ['15/10/26', '2026-10-15', 'high'],
    ['30/12', '2025-12-30', 'medium'],
    ['24/10', '2026-10-24', 'medium'],
  ])('%s → %s (%s)', (text, value, confidence) => {
    const result = parse(text);
    expect(result.candidates[0].date).toEqual({
      value,
      confidence,
      matchedText: text,
      defaulted: false,
    });
    expect(result.warnings.includes('FUTURE_DATE')).toBe(value > '2026-10-23');
    expect(result.candidates[0].amount.value).toBeNull();
  });

  it('rejects invalid dates without recovering their digits as money', () => {
    for (const text of [
      '31/02',
      '31/04/26',
      '15/13',
      '29/02/2025',
      'ngày 32',
    ]) {
      expect(parse(text).candidates[0]).toMatchObject({
        date: { value: null, defaulted: false },
        amount: { value: null },
        occurredAtHint: null,
      });
      expect(parse(text).warnings).toContain('INVALID_DATE');
    }
  });

  it('defaults only when there is no date', () => {
    expect(parse('cf 30k').candidates[0].date).toEqual({
      value: '2026-10-23',
      confidence: 'high',
      matchedText: null,
      defaulted: true,
    });
  });

  it.each([
    ['sáng nay', '2026-10-23T08:00:00+07:00'],
    ['tối nay', '2026-10-23T09:00:00+07:00'],
    ['tối qua', '2026-10-22T19:00:00+07:00'],
    ['chiều qua', '2026-10-22T15:00:00+07:00'],
    ['15/10', '2026-10-15T12:00:00+07:00'],
    ['cf 30k', '2026-10-23T09:00:00+07:00'],
    ['trưa nay', '2026-10-23T09:00:00+07:00'],
  ])('time hint %s', (input, hint) =>
    expect(parse(input).candidates[0].occurredAtHint).toBe(hint),
  );

  it('handles month/year rollover and leap years without clamping invalid days', () => {
    const march: Clock = {
      ...clock,
      now: () => new Date('2026-03-01T09:00:00+07:00'),
    };
    expect(parse('hôm qua', march).candidates[0].date.value).toBe('2026-02-28');
    expect(parse('ngày 31', march).warnings).toContain('INVALID_DATE');
    expect(parse('29/02/24', march).candidates[0].date.value).toBe(
      '2024-02-29',
    );
    const jan: Clock = {
      ...clock,
      now: () => new Date('2026-01-01T09:00:00+07:00'),
    };
    expect(parse('ngày 25', jan).candidates[0].date.value).toBe('2025-12-25');
  });

  it('uses injected timezone instead of the host timezone and reads clock once', () => {
    let reads = 0;
    const reference: Clock = {
      timeZone: 'America/New_York',
      now: () => {
        reads++;
        return new Date('2026-10-23T02:00:12Z');
      },
    };
    expect(parse('cf 30k', reference).candidates[0].occurredAtHint).toBe(
      '2026-10-22T22:00:12-04:00',
    );
    expect(reads).toBe(1);
    expect(parse('15/01/2026', reference).candidates[0].occurredAtHint).toBe(
      '2026-01-15T12:00:00-05:00',
    );
  });
});

describe('whole-token and timezone regressions', () => {
  it.each(['15/09/2026', '15-09-2026'])(
    'does not shorten ngày %s to a day of month',
    (date) => {
      expect(parse(`ngày ${date} ăn 30k`).candidates[0]).toMatchObject({
        date: { value: '2026-09-15', matchedText: `ngày ${date}` },
        amount: { value: 30000 },
        noteText: 'ăn',
      });
    },
  );

  it('rejects an entire malformed separator run rather than keeping the prefix', () => {
    for (const input of ['1..500k', '1,,500', '1.,500k']) {
      expect(parse(input).candidates[0].amount.value).toBeNull();
      expect(parse(input).warnings).toContain('NON_INTEGER_VND');
    }
  });

  it('preserves the actual current offset during the repeated DST hour', () => {
    const reference: Clock = {
      timeZone: 'America/New_York',
      now: () => new Date('2026-11-01T06:30:00Z'),
    };
    expect(parse('cf 30k', reference).candidates[0].occurredAtHint).toBe(
      '2026-11-01T01:30:00-05:00',
    );
  });
});

describe('generated properties', () => {
  it('computes integer/unit spellings independently', () => {
    for (let n = 1; n <= 250; n++) {
      for (const [unit, multiplier] of [
        ['k', 1000],
        ['tr', 1000000],
        ['nghìn', 1000],
        ['triệu', 1000000],
      ] as const) {
        for (const spelling of [`${n}${unit}`, `${n} ${unit.toUpperCase()}`]) {
          expect(parse(spelling).candidates[0].amount.value).toBe(
            n * multiplier,
          );
        }
      }
    }
  });

  it('never throws, never returns negative money, and is deterministic on arbitrary Unicode', () => {
    let seed = 123456;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const corpus = [
      '',
      '\ud800',
      '9'.repeat(10000) + 'k',
      '1k' + '0'.repeat(10000),
      '\u0300'.repeat(1000),
      '😀 30k hôm qua',
    ];
    for (let i = 0; i < 500; i++) {
      let input = '';
      for (let j = 0; j < next() % 80; j++)
        input += String.fromCodePoint(next() % 0x110000);
      corpus.push(input);
    }
    for (const input of corpus) {
      const result = parse(input);
      expect(parse(input)).toEqual(result);
      expect(result.candidates.length).toBeGreaterThan(0);
      for (const candidate of result.candidates) {
        expect(
          candidate.amount.value === null || candidate.amount.value >= 0,
        ).toBe(true);
      }
    }
  });
});
