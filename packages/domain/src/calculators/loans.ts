import { roundHalfUp } from '../arithmetic';
import { MAX_AMOUNT_VND } from '../money';

export type LoanRateType = 'declining' | 'flat';

export interface LoanScheduleEntry {
  period: number;
  principal: number;
  interest: number;
  payment: number;
  balance: number;
}

export interface LoanEstimateInputs {
  principal: number;
  annualRate: number;
  months: number;
  rateType: LoanRateType;
  upfrontFee?: number;
  decliningMethod?: 'annuity' | 'equal_principal';
}

export interface LoanEstimateResult {
  monthlyPayment: number;
  totalInterest: number;
  totalPayment: number;
  effectiveRateBps: number;
  schedule: LoanScheduleEntry[];
}

// Solve for the monthly internal rate of return using bisection.
function solveMonthlyIrr(
  netPrincipal: number,
  payments: number[],
  tolerance = 1e-9,
): number {
  if (netPrincipal <= 0) return 0;
  const totalPayment = payments.reduce((acc, p) => acc + p, 0);
  if (totalPayment <= netPrincipal) return 0;

  let low = 0;
  let high = 5.0; // 500% monthly upper bound

  for (let iter = 0; iter < 100; iter++) {
    const mid = (low + high) / 2;
    let npv = 0;
    for (let k = 0; k < payments.length; k++) {
      npv += payments[k] / Math.pow(1 + mid, k + 1);
    }

    if (Math.abs(npv - netPrincipal) < tolerance) {
      return mid;
    }

    if (npv > netPrincipal) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
}

// Calculate loan repayment schedule, interest, payments, and effective rate.
export function loanEstimate(inputs: LoanEstimateInputs): LoanEstimateResult {
  const {
    principal,
    annualRate,
    months,
    rateType,
    upfrontFee = 0,
    decliningMethod = 'annuity',
  } = inputs;

  if (
    !Number.isSafeInteger(principal) ||
    principal <= 0 ||
    principal > MAX_AMOUNT_VND
  ) {
    throw new RangeError('Principal must be a positive money amount.');
  }

  if (!Number.isSafeInteger(months) || months < 1) {
    throw new RangeError('Months must be a positive integer.');
  }

  if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 1) {
    throw new RangeError('Annual rate must be between 0 and 1.');
  }

  if (
    !Number.isSafeInteger(upfrontFee) ||
    upfrontFee < 0 ||
    upfrontFee >= principal
  ) {
    throw new RangeError('Upfront fee must be non-negative and less than principal.');
  }

  const r = annualRate / 12;
  const schedule: LoanScheduleEntry[] = [];

  if (rateType === 'flat') {
    const totalInterest = roundHalfUp((principal * annualRate * months) / 12);
    const totalPayment = principal + totalInterest;
    const basePayment = Math.floor(totalPayment / months);
    let runningBalance = principal;

    for (let k = 1; k <= months; k++) {
      const isLast = k === months;
      const payment = isLast
        ? totalPayment - basePayment * (months - 1)
        : basePayment;
      const interest = isLast
        ? totalInterest - Math.floor(totalInterest / months) * (months - 1)
        : Math.floor(totalInterest / months);
      const principalPart = payment - interest;
      runningBalance = Math.max(0, runningBalance - principalPart);

      schedule.push({
        period: k,
        principal: principalPart,
        interest,
        payment,
        balance: isLast ? 0 : runningBalance,
      });
    }

    const payments = schedule.map((s) => s.payment);
    const monthlyIrr = solveMonthlyIrr(principal - upfrontFee, payments);
    const effectiveRateBps = roundHalfUp(monthlyIrr * 12 * 10000);

    return {
      monthlyPayment: basePayment,
      totalInterest,
      totalPayment,
      effectiveRateBps,
      schedule,
    };
  }

  // Declining balance
  if (decliningMethod === 'equal_principal') {
    const basePrincipal = Math.floor(principal / months);
    let currentBalance = principal;
    let totalInterest = 0;

    for (let k = 1; k <= months; k++) {
      const isLast = k === months;
      const principalPart = isLast
        ? principal - basePrincipal * (months - 1)
        : basePrincipal;
      const interest = roundHalfUp(currentBalance * r);
      totalInterest += interest;
      const payment = principalPart + interest;
      currentBalance = Math.max(0, currentBalance - principalPart);

      schedule.push({
        period: k,
        principal: principalPart,
        interest,
        payment,
        balance: isLast ? 0 : currentBalance,
      });
    }

    const payments = schedule.map((s) => s.payment);
    const monthlyIrr = solveMonthlyIrr(principal - upfrontFee, payments);
    const effectiveRateBps = roundHalfUp(monthlyIrr * 12 * 10000);

    return {
      monthlyPayment: schedule[0].payment,
      totalInterest,
      totalPayment: principal + totalInterest,
      effectiveRateBps,
      schedule,
    };
  }

  // Annuity (equal payments)
  const pmt =
    r === 0
      ? roundHalfUp(principal, months)
      : roundHalfUp((principal * r) / (1 - Math.pow(1 + r, -months)));

  let currentBalance = principal;
  let totalInterest = 0;

  for (let k = 1; k <= months; k++) {
    const isLast = k === months;
    const interest = roundHalfUp(currentBalance * r);
    totalInterest += interest;

    if (isLast) {
      const principalPart = currentBalance;
      const payment = principalPart + interest;
      schedule.push({
        period: k,
        principal: principalPart,
        interest,
        payment,
        balance: 0,
      });
      currentBalance = 0;
    } else {
      const principalPart = pmt - interest;
      currentBalance = Math.max(0, currentBalance - principalPart);
      schedule.push({
        period: k,
        principal: principalPart,
        interest,
        payment: pmt,
        balance: currentBalance,
      });
    }
  }

  const payments = schedule.map((s) => s.payment);
  const monthlyIrr = solveMonthlyIrr(principal - upfrontFee, payments);
  const effectiveRateBps = roundHalfUp(monthlyIrr * 12 * 10000);

  return {
    monthlyPayment: pmt,
    totalInterest,
    totalPayment: principal + totalInterest,
    effectiveRateBps,
    schedule,
  };
}
