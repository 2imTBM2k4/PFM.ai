import { savingsPlan } from './calculators/savings';
import { MAX_AMOUNT_VND } from './money';

export const CALCULATION_VERSION = 1;

/** Reuse the validated domain formula without assuming an interest rate. */
export function requiredMonthlySaving(
  target: number,
  available: number,
  months: number,
): number {
  return savingsPlan({ target, available, months }).requiredPerMonth;
}

/** Compound an explicitly selected schedule; positive contributions need timing clarification. */
export function compoundInterest(
  principal: number,
  annualRate: number,
  compoundFrequency: 'yearly' | 'monthly' | 'quarterly' | undefined,
  years: number,
  additionalContribution?: number,
):
  | { ok: true; amount: number; contribution: 'none' | 'explicit_zero' }
  | { ok: false; error: string } {
  const frequencies = { yearly: 1, monthly: 12, quarterly: 4 };
  if (!compoundFrequency || !Object.hasOwn(frequencies, compoundFrequency))
    return { ok: false, error: 'COMPOUND_FREQUENCY_REQUIRED' };
  if (
    !Number.isSafeInteger(principal) ||
    principal < 0 ||
    principal > MAX_AMOUNT_VND ||
    !Number.isFinite(annualRate) ||
    annualRate < 0 ||
    !Number.isFinite(years) ||
    years < 0 ||
    (additionalContribution !== undefined &&
      (!Number.isSafeInteger(additionalContribution) ||
        additionalContribution < 0 ||
        additionalContribution > MAX_AMOUNT_VND))
  )
    return { ok: false, error: 'INVALID_CALCULATION_INPUT' };
  if (additionalContribution !== undefined && additionalContribution > 0)
    return { ok: false, error: 'CONTRIBUTION_TIMING_REQUIRED' };
  const frequency = frequencies[compoundFrequency];
  if (!Number.isSafeInteger(years * frequency))
    return { ok: false, error: 'PARTIAL_COMPOUND_PERIOD' };
  const amount =
    principal === 0
      ? 0
      : principal * (1 + annualRate / frequency) ** (years * frequency);
  if (!Number.isFinite(amount) || amount > MAX_AMOUNT_VND)
    return { ok: false, error: 'RESULT_OVERFLOW' };
  return {
    ok: true,
    amount,
    contribution:
      additionalContribution === undefined ? 'none' : 'explicit_zero',
  };
}
