import { ceilDiv } from '../arithmetic';
import { MAX_AMOUNT_VND } from '../money';

export interface SavingsPlanInputs {
  target: number;
  available: number;
  months: number;
  annualRate?: number;
}

export interface SavingsPlanResult {
  remaining: number;
  requiredPerMonth: number;
}

// Calculate the required monthly savings amount to reach a target in a given number of months.
export function savingsPlan(inputs: SavingsPlanInputs): SavingsPlanResult {
  const { target, available, months, annualRate = 0 } = inputs;

  if (
    !Number.isSafeInteger(target) ||
    target < 0 ||
    target > MAX_AMOUNT_VND ||
    !Number.isSafeInteger(available) ||
    available < 0 ||
    available > MAX_AMOUNT_VND
  ) {
    throw new RangeError('Target and available must be valid money amounts.');
  }

  if (!Number.isSafeInteger(months) || months < 1) {
    throw new RangeError('Months must be a positive integer.');
  }

  if (
    !Number.isFinite(annualRate) ||
    annualRate < 0 ||
    annualRate > 1
  ) {
    throw new RangeError('Annual rate must be between 0 and 1.');
  }

  const remaining = Math.max(0, target - available);
  if (remaining === 0) {
    return { remaining: 0, requiredPerMonth: 0 };
  }

  if (annualRate === 0) {
    return {
      remaining,
      requiredPerMonth: ceilDiv(remaining, months),
    };
  }

  const r = annualRate / 12;
  const growthFactor = Math.pow(1 + r, months);
  const futureAvailable = available * growthFactor;

  if (target <= futureAvailable) {
    return { remaining, requiredPerMonth: 0 };
  }

  const numerator = (target - futureAvailable) * r;
  const denominator = growthFactor - 1;
  const pmt = Math.ceil(numerator / denominator);

  return {
    remaining,
    requiredPerMonth: Math.max(0, pmt),
  };
}
