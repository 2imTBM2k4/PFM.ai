import { describe, expect, it } from 'vitest';
import {
  amountRangeError,
  repaymentError,
  amountError,
  dateError,
  endDateError,
  monthError,
  percentError,
} from './form-validation';

describe('manual form validation', () => {
  it('allows partial or exact repayment but blocks overpayment and invalid amounts', () => {
    expect(repaymentError('50.000', 100000)).toBe(true);
    expect(repaymentError('100.000', 100000)).toBe(true);
    expect(repaymentError('100.001', 100000)).not.toBe(true);
    expect(repaymentError('0', 100000)).not.toBe(true);
    expect(repaymentError('100.001')).toBe(true);
  });
  it('allows open amount ranges and zero but rejects reversed or malformed bounds', () => {
    expect(amountRangeError('', '100.000')).toBe(true);
    expect(amountRangeError('0', '')).toBe(true);
    expect(amountRangeError('100.000', '100.000')).toBe(true);
    expect(amountRangeError('99.999', '100.000')).not.toBe(true);
    expect(amountRangeError('abc', '')).not.toBe(true);
    expect(amountRangeError('100', 'abc')).toBe(true);
  });
  it('requires positive money except where zero or an empty filter is allowed', () => {
    for (const value of ['', '0', '-1', '30k', '100000000001'])
      expect(amountError(value)).not.toBe(true);
    expect(amountError('30000')).toBe(true);
    expect(amountError('0', { zero: true })).toBe(true);
    expect(amountError('', { optional: true })).toBe(true);
    expect(amountError('0', { optional: true })).not.toBe(true);
    expect(amountError('10.25', { currency: 'USD' })).toBe(true);
    expect(amountError('10.999', { currency: 'USD' })).not.toBe(true);
  });
  it('checks calendar dates without forbidding future or past dates', () => {
    expect(dateError('2026-02-30')).not.toBe(true);
    expect(dateError('2024-02-29')).toBe(true);
    expect(dateError('2030-01-01')).toBe(true);
    expect(dateError('')).not.toBe(true);
    expect(dateError('', true)).toBe(true);
  });
  it('accepts an open end and equality but rejects a reversed range', () => {
    expect(endDateError('', '2026-11-11', true)).toBe(true);
    expect(endDateError('2026-11-11', '2026-11-11')).toBe(true);
    expect(endDateError('2026-11-10', '2026-11-11')).not.toBe(true);
    expect(endDateError('2026-11-10', '')).toBe(true);
    expect(monthError('2026-13')).not.toBe(true);
    expect(monthError('2026-11')).toBe(true);
    expect(monthError('', true)).toBe(true);
  });
  it('only accepts whole alert percentages between 1 and 100', () => {
    for (const value of ['', '0', '101', '1.5', '1e1', '-1'])
      expect(percentError(value)).not.toBe(true);
    for (const value of ['1', '80', '100'])
      expect(percentError(value)).toBe(true);
  });
});
