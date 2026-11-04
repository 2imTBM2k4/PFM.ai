import { ceilDiv } from '../arithmetic';
import { MAX_AMOUNT_VND } from '../money';

export interface TimeToAffordInputs {
  price: number;
  available: number;
  surplus: number;
  surplusScenarios?: {
    conservative: number;
    typical: number;
    optimistic: number;
  };
  categoryMonthlyAvg?: number;
  reductionBps?: number;
}

export interface TimeToAffordResult {
  remaining: number;
  conservativeMonths: number | null;
  typicalMonths: number | null;
  optimisticMonths: number | null;
  cutMonths?: number | null;
}

// Compute the ceiling months needed to accumulate remaining savings.
export function timeToAffordMonths(
  remaining: number,
  surplus: number,
): number | null {
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    throw new RangeError('Remaining amount must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(surplus)) {
    throw new RangeError('Surplus must be a safe integer.');
  }
  if (remaining === 0) return 0;
  if (surplus <= 0) return null;
  return ceilDiv(remaining, surplus);
}

// Calculate time-to-afford under conservative, typical, optimistic and cut scenarios.
export function timeToAfford(inputs: TimeToAffordInputs): TimeToAffordResult {
  const {
    price,
    available,
    surplus,
    surplusScenarios,
    categoryMonthlyAvg,
    reductionBps,
  } = inputs;

  if (
    !Number.isSafeInteger(price) ||
    price < 0 ||
    price > MAX_AMOUNT_VND ||
    !Number.isSafeInteger(available) ||
    available < 0 ||
    available > MAX_AMOUNT_VND
  ) {
    throw new RangeError('Price and available must be valid money amounts.');
  }

  const remaining = Math.max(0, price - available);

  const conservativeSurplus = surplusScenarios?.conservative ?? surplus;
  const typicalSurplus = surplusScenarios?.typical ?? surplus;
  const optimisticSurplus = surplusScenarios?.optimistic ?? surplus;

  const conservativeMonths = timeToAffordMonths(
    remaining,
    conservativeSurplus,
  );
  const typicalMonths = timeToAffordMonths(remaining, typicalSurplus);
  const optimisticMonths = timeToAffordMonths(remaining, optimisticSurplus);

  let cutMonths: number | null | undefined = undefined;
  if (
    categoryMonthlyAvg !== undefined &&
    reductionBps !== undefined &&
    categoryMonthlyAvg >= 0 &&
    reductionBps >= 0 &&
    reductionBps <= 10000
  ) {
    const extra = Number(
      (BigInt(categoryMonthlyAvg) * BigInt(reductionBps)) / 10000n,
    );
    const cutSurplus = typicalSurplus + extra;
    cutMonths = timeToAffordMonths(remaining, cutSurplus);
  }

  return {
    remaining,
    conservativeMonths,
    typicalMonths,
    optimisticMonths,
    ...(cutMonths !== undefined ? { cutMonths } : {}),
  };
}
