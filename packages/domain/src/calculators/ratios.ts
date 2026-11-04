import { ratioBps } from '../arithmetic';
import { MAX_AMOUNT_VND } from '../money';

export interface RatiosInputs {
  liquidBalance: number;
  monthlyExpenseAvg: number;
  debtMonthlyObligation: number;
  monthlyIncomeAvg: number;
}

export interface RatiosResult {
  emergencyFundMonths: number | null;
  dtiBps: number | null;
}

// Calculate key financial resilience metrics: Emergency Fund Months and Debt-to-Income (DTI).
export function calculateRatios(inputs: RatiosInputs): RatiosResult {
  const {
    liquidBalance,
    monthlyExpenseAvg,
    debtMonthlyObligation,
    monthlyIncomeAvg,
  } = inputs;

  if (
    !Number.isSafeInteger(liquidBalance) ||
    liquidBalance < 0 ||
    liquidBalance > MAX_AMOUNT_VND ||
    !Number.isSafeInteger(monthlyExpenseAvg) ||
    monthlyExpenseAvg < 0 ||
    monthlyExpenseAvg > MAX_AMOUNT_VND ||
    !Number.isSafeInteger(debtMonthlyObligation) ||
    debtMonthlyObligation < 0 ||
    debtMonthlyObligation > MAX_AMOUNT_VND ||
    !Number.isSafeInteger(monthlyIncomeAvg) ||
    monthlyIncomeAvg < 0 ||
    monthlyIncomeAvg > MAX_AMOUNT_VND
  ) {
    throw new RangeError('All ratio inputs must be non-negative money amounts.');
  }

  const emergencyFundMonths =
    monthlyExpenseAvg === 0
      ? null
      : Math.floor(liquidBalance / monthlyExpenseAvg);

  const dtiBps =
    monthlyIncomeAvg === 0
      ? null
      : ratioBps(debtMonthlyObligation, monthlyIncomeAvg);

  return {
    emergencyFundMonths,
    dtiBps,
  };
}
