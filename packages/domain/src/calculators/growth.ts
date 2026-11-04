import { roundHalfUp } from '../arithmetic';
import { MAX_AMOUNT_VND } from '../money';

export interface GrowthInputs {
  presentValue: number;
  monthlyContribution: number;
  annualRate: number;
  months: number;
}

export interface GrowthResult {
  futureValue: number;
  totalContributions: number;
  totalInterest: number;
}

// Calculate future value with compound interest and recurring monthly contributions.
export function growth(inputs: GrowthInputs): GrowthResult {
  const { presentValue, monthlyContribution, annualRate, months } = inputs;

  if (
    !Number.isSafeInteger(presentValue) ||
    presentValue < 0 ||
    presentValue > MAX_AMOUNT_VND ||
    !Number.isSafeInteger(monthlyContribution) ||
    monthlyContribution < 0 ||
    monthlyContribution > MAX_AMOUNT_VND
  ) {
    throw new RangeError('Present value and monthly contribution must be valid money amounts.');
  }

  if (!Number.isSafeInteger(months) || months < 1) {
    throw new RangeError('Months must be a positive integer.');
  }

  if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 1) {
    throw new RangeError('Annual rate must be between 0 and 1.');
  }

  const totalContributions = monthlyContribution * months;

  if (annualRate === 0) {
    const futureValue = presentValue + totalContributions;
    return {
      futureValue,
      totalContributions,
      totalInterest: 0,
    };
  }

  const r = annualRate / 12;
  const growthFactor = Math.pow(1 + r, months);
  const futureFromPv = presentValue * growthFactor;
  const futureFromPmt = monthlyContribution * ((growthFactor - 1) / r);

  const futureValue = roundHalfUp(futureFromPv + futureFromPmt);
  const totalInterest = Math.max(
    0,
    futureValue - (presentValue + totalContributions),
  );

  return {
    futureValue,
    totalContributions,
    totalInterest,
  };
}
