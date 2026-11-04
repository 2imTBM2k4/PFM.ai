import { expect, it } from 'vitest';
import {
  formatAmountInput,
  parseAmountInput,
  manualOccurredAt,
  isFutureDate,
} from './form';

it('groups whole VND while rejecting negative, fractional, malformed and oversized input', () => {
  expect(formatAmountInput('1500000')).toBe('1.500.000');
  expect(formatAmountInput('0001500')).toBe('1.500');
  expect(parseAmountInput('1.500.000')).toBe(1500000);
  expect(parseAmountInput('100.000.000.000')).toBe(100000000000);
  for (const value of [
    '',
    '0',
    '-30000',
    '12.5',
    '1,5',
    '1.00',
    '100000000001',
  ])
    expect(() => parseAmountInput(value)).toThrow();
  expect(formatAmountInput('-30000')).toBe('-30000');
  expect(formatAmountInput('1.50', '1.500')).toBe('150');
  expect(formatAmountInput('12.5', '')).toBe('12.5');
});

it('regroups each typed digit through thousands, ten thousands, millions and the maximum', () => {
  let displayed = '';
  for (const digit of '4000000')
    displayed = formatAmountInput(displayed + digit, displayed);
  expect(displayed).toBe('4.000.000');
  expect(parseAmountInput(displayed)).toBe(4000000);
  expect(formatAmountInput('4.0000', '4.000')).toBe('40.000');
  expect(formatAmountInput('40.0000', '40.000')).toBe('400.000');
  displayed = '';
  for (const digit of '100000000000')
    displayed = formatAmountInput(displayed + digit, displayed);
  expect(displayed).toBe('100.000.000.000');
  expect(parseAmountInput(displayed)).toBe(100000000000);
});

it('regroups single-digit insertions and deletions within an already formatted amount', () => {
  expect(formatAmountInput('4.0900', '4.000')).toBe('40.900');
  expect(formatAmountInput('4.00', '4.000')).toBe('400');
  expect(formatAmountInput('1.23.567', '1.234.567')).toBe('123.567');
  expect(formatAmountInput('4.0000', '')).toBe('4.0000');
  expect(formatAmountInput('12.5', '12.')).toBe('12.5');
  expect(() => parseAmountInput('12.5')).toThrow();
});

it('reads USD decimal input as cents without treating the dot as a VND thousands mark', () => {
  expect(parseAmountInput('10.25', 'USD')).toBe(1025);
  expect(parseAmountInput('0.01', 'USD')).toBe(1);
  expect(parseAmountInput('10', 'USD')).toBe(1000);
  expect(formatAmountInput('10.25', '', 'USD')).toBe('10.25');
  for (const value of ['0', '0.001', '1.234', '1,000', '-1'])
    expect(() => parseAmountInput(value, 'USD')).toThrow();
});

it('keeps today timestamp, uses noon for other dates, and warns from tomorrow in Vietnam', () => {
  const now = new Date('2026-10-26T17:01:00Z');
  expect(manualOccurredAt('2026-10-27', now)).toBe(now.toISOString());
  expect(manualOccurredAt('2026-10-26', now)).toBe('2026-10-26T12:00:00+07:00');
  expect(isFutureDate('2026-10-27', now)).toBe(false);
  expect(isFutureDate('2026-10-28', now)).toBe(true);
  expect(isFutureDate('2026-10-26', now)).toBe(false);
  expect(() => manualOccurredAt('2026-02-30', now)).toThrow();
});
