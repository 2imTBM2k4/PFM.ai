import { describe, expect, it } from 'vitest';

import { convertMoney, formatCompactVnd, formatVnd, toMoney } from './money';

describe('convertMoney', () => {
  it('converts USD cents to booked VND and VND to displayed USD cents', () => {
    expect(convertMoney(1000, 'USD', 'VND', 25_500)).toBe(255_000);
    expect(convertMoney(255_000, 'VND', 'USD', 25_500)).toBe(1000);
    expect(convertMoney(1, 'USD', 'VND', 25_500)).toBe(255);
  });

  it('preserves the original minor unit without a rate', () => {
    expect(convertMoney(1234, 'USD', 'USD', null)).toBe(1234);
  });

  it('rejects missing rates, unsafe results and invalid minor amounts', () => {
    expect(() => convertMoney(100, 'USD', 'VND', null)).toThrow(RangeError);
    expect(() => convertMoney(100, 'USD', 'VND', 0)).toThrow(RangeError);
    expect(() => convertMoney(0.5, 'USD', 'VND', 25_500)).toThrow(RangeError);
    expect(() => convertMoney(100_000_000_000, 'USD', 'VND', 25_500)).toThrow(RangeError);
  });
});

describe('formatCompactVnd', () => {
  it.each([
    [0, '0 ₫'],
    [999, '999 ₫'],
    [1000, '1k'],
    [30000, '30k'],
    [1500000, '1,5 triệu'],
    [-1500000, '-1,5 triệu'],
    [999999, '1 triệu'],
    [1000000000, '1 tỷ'],
    [100000000000, '100 tỷ'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatCompactVnd(value)).toBe(expected);
  });
  it.each([0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s',
    (value) => {
      expect(() => formatCompactVnd(value)).toThrow(RangeError);
    },
  );
});

describe('toMoney', () => {
  it.each([0, 999, 1000, 100_000_000_000])('accepts whole VND: %s', (value) => {
    expect(toMoney(value)).toBe(value);
  });

  it.each([
    -1,
    0.5,
    NaN,
    Infinity,
    100_000_000_001,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid or excessive money: %s', (value) => {
    expect(() => toMoney(value)).toThrow(RangeError);
  });
});

describe('formatVnd', () => {
  it.each([
    [0, '0 ₫'],
    [999, '999 ₫'],
    [1000, '1.000 ₫'],
    [1_500_000, '1.500.000 ₫'],
    [-1_500_000, '-1.500.000 ₫'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatVnd(value)).toBe(expected);
  });

  it.each([0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a non-integer or unsafe amount: %s',
    (value) => {
      expect(() => formatVnd(value)).toThrow(RangeError);
    },
  );
});
