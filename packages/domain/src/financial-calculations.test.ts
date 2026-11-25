import { describe, expect, it } from 'vitest';
import {
  CALCULATION_VERSION,
  compoundInterest,
  requiredMonthlySaving,
} from './financial-calculations';
import { timeToAffordMonths } from './calculators/affordability';

describe('financial calculations', () => {
  it('reuses the savings plan and rounds the time horizon up', () => {
    expect(CALCULATION_VERSION).toBe(1);
    expect(requiredMonthlySaving(30_000_000, 0, 6)).toBe(5_000_000);
    expect(requiredMonthlySaving(30_000_000, 31_000_000, 6)).toBe(0);
    expect(timeToAffordMonths(30_000_000, 5_000_000)).toBe(6);
    expect(timeToAffordMonths(31_000_000, 5_000_000)).toBe(7);
    expect(timeToAffordMonths(1, 0)).toBeNull();
    expect(timeToAffordMonths(1, -1)).toBeNull();
  });
  it('compounds using the explicitly selected frequency', () => {
    const yearly = compoundInterest(10_000_000, 0.1, 'yearly', 2);
    expect(yearly).toMatchObject({ ok: true, contribution: 'none' });
    expect(yearly.ok && yearly.amount).toBeCloseTo(12_100_000, 5);
    expect(compoundInterest(10_000_000, 0, 'monthly', 2, 0)).toEqual({
      ok: true,
      amount: 10_000_000,
      contribution: 'explicit_zero',
    });
    const quarterly = compoundInterest(10_000_000, 0.1, 'quarterly', 2);
    expect(quarterly.ok && quarterly.amount).toBeCloseTo(
      10_000_000 * 1.025 ** 8,
      5,
    );
  });
  it('asks for frequency and contribution timing instead of choosing defaults', () => {
    expect(compoundInterest(10, 0.1, undefined, 2)).toEqual({
      ok: false,
      error: 'COMPOUND_FREQUENCY_REQUIRED',
    });
    expect(compoundInterest(10, 0.1, 'yearly', 2, 5)).toEqual({
      ok: false,
      error: 'CONTRIBUTION_TIMING_REQUIRED',
    });
  });
  it('rejects invalid rates, amounts, horizons and overflow', () => {
    for (const rate of [-1, Infinity, NaN])
      expect(compoundInterest(10, rate, 'yearly', 2).ok).toBe(false);
    expect(compoundInterest(100_000_000_000, 0.1, 'yearly', 1)).toEqual({
      ok: false,
      error: 'RESULT_OVERFLOW',
    });
    expect(compoundInterest(1, 1, 'monthly', 100_000)).toEqual({
      ok: false,
      error: 'RESULT_OVERFLOW',
    });
    expect(compoundInterest(-1, 0, 'yearly', 1).ok).toBe(false);
    expect(compoundInterest(1, 0, 'yearly', NaN).ok).toBe(false);
  });
});
