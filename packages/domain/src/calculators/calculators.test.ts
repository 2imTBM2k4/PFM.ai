import { describe, expect, it } from 'vitest';

import {
  calculateRatios,
  growth,
  loanEstimate,
  savingsPlan,
  timeToAfford,
  timeToAffordMonths,
} from './index';

describe('C1: timeToAfford', () => {
  it('passes all normative test vectors from plan.md §7.4.2', () => {
    const remaining = 2_000_000 - 200_000; // 1,800,000
    expect(timeToAffordMonths(remaining, 600_000)).toBe(3);
    expect(timeToAffordMonths(remaining, 300_000)).toBe(6);
    expect(timeToAffordMonths(remaining, 900_000)).toBe(2);
    expect(timeToAffordMonths(remaining, 0)).toBeNull();
    expect(timeToAffordMonths(remaining, -500_000)).toBeNull();

    // Already affordable
    expect(timeToAffordMonths(0, 500_000)).toBe(0);
    const affordableInputs = timeToAfford({
      price: 150_000,
      available: 200_000,
      surplus: 500_000,
    });
    expect(affordableInputs.remaining).toBe(0);
    expect(affordableInputs.typicalMonths).toBe(0);

    // Ceiling rounding edge
    expect(timeToAffordMonths(1_000_001, 500_000)).toBe(3);
  });

  it('computes 3 scenarios and cut reduction scenario', () => {
    const result = timeToAfford({
      price: 2_000_000,
      available: 200_000,
      surplus: 600_000,
      surplusScenarios: {
        conservative: 300_000,
        typical: 600_000,
        optimistic: 900_000,
      },
      categoryMonthlyAvg: 2_000_000,
      reductionBps: 2000, // 20% cut = +400k -> typical surplus becomes 1,000,000
    });

    expect(result.remaining).toBe(1_800_000);
    expect(result.conservativeMonths).toBe(6);
    expect(result.typicalMonths).toBe(3);
    expect(result.optimisticMonths).toBe(2);
    expect(result.cutMonths).toBe(2); // 1,800,000 / 1,000,000 = ceil(1.8) = 2
  });
});

describe('C2: savingsPlan', () => {
  it('computes exact monthly requirement without interest', () => {
    const res = savingsPlan({
      target: 10_000_000,
      available: 1_000_000,
      months: 10,
    });
    expect(res.remaining).toBe(9_000_000);
    expect(res.requiredPerMonth).toBe(900_000);
  });

  it('returns 0 when already funded', () => {
    const res = savingsPlan({
      target: 5_000_000,
      available: 6_000_000,
      months: 5,
    });
    expect(res.remaining).toBe(0);
    expect(res.requiredPerMonth).toBe(0);
  });

  it('computes savings plan with interest', () => {
    const res = savingsPlan({
      target: 10_000_000,
      available: 0,
      months: 12,
      annualRate: 0.06, // 6% annual rate
    });
    // Reference: 10,000,000 * 0.005 / ((1.005)^12 - 1) = 810,664.2 -> ceil 810,665
    expect(res.requiredPerMonth).toBeGreaterThanOrEqual(810_660);
    expect(res.requiredPerMonth).toBeLessThanOrEqual(810_670);
  });
});

describe('C3: loanEstimate', () => {
  it('computes Annuity loan matching plan.md test vector', () => {
    const res = loanEstimate({
      principal: 100_000_000,
      annualRate: 0.12,
      months: 12,
      rateType: 'declining',
      decliningMethod: 'annuity',
    });

    // PMT ~ 8,884,879
    expect(res.monthlyPayment).toBe(8_884_879);
    // Total interest ~ 6.6 million
    expect(res.totalInterest).toBeGreaterThan(6_600_000);
    expect(res.totalInterest).toBeLessThan(6_650_000);

    // Assert invariants: sum of principal parts equals original principal, final balance is 0
    const sumPrincipal = res.schedule.reduce((acc, s) => acc + s.principal, 0);
    expect(sumPrincipal).toBe(100_000_000);
    expect(res.schedule[res.schedule.length - 1].balance).toBe(0);
    expect(res.totalPayment).toBe(100_000_000 + res.totalInterest);
  });

  it('computes Equal Principal loan matching plan.md test vector', () => {
    const res = loanEstimate({
      principal: 12_000_000,
      annualRate: 0.12,
      months: 12,
      rateType: 'declining',
      decliningMethod: 'equal_principal',
    });

    expect(res.schedule[0].interest).toBe(120_000);
    expect(res.schedule[0].payment).toBe(1_120_000);
    expect(res.schedule[1].interest).toBe(110_000);
    expect(res.schedule[11].interest).toBe(10_000);
    expect(res.schedule[11].payment).toBe(1_010_000);
    expect(res.totalInterest).toBe(780_000);
    expect(res.schedule[11].balance).toBe(0);
  });

  it('computes Flat Rate loan and effective IRR matching plan.md test vector', () => {
    const res = loanEstimate({
      principal: 10_000_000,
      annualRate: 0.12,
      months: 12,
      rateType: 'flat',
    });

    expect(res.totalInterest).toBe(1_200_000);
    expect(res.totalPayment).toBe(11_200_000);

    // 11 payments of 933,333 and a last payment of 933,337
    for (let i = 0; i < 11; i++) {
      expect(res.schedule[i].payment).toBe(933_333);
    }
    expect(res.schedule[11].payment).toBe(933_337);

    // Effective rate nominal = ~21.4% - 21.5% (2140 - 2150 bps)
    expect(res.effectiveRateBps).toBeGreaterThanOrEqual(2140);
    expect(res.effectiveRateBps).toBeLessThanOrEqual(2150);
  });
});

describe('C4: growth', () => {
  it('computes compound growth matching plan.md test vector', () => {
    const res = growth({
      presentValue: 0,
      monthlyContribution: 1_000_000,
      annualRate: 0.06,
      months: 12,
    });

    // FV ~ 12,335,562
    expect(res.futureValue).toBe(12_335_562);
    expect(res.totalContributions).toBe(12_000_000);
    expect(res.totalInterest).toBe(335_562);
  });
});

describe('C5: calculateRatios', () => {
  it('calculates emergency fund months and DTI correctly', () => {
    const res = calculateRatios({
      liquidBalance: 3_200_000,
      monthlyExpenseAvg: 8_400_000,
      debtMonthlyObligation: 1_800_000,
      monthlyIncomeAvg: 9_000_000,
    });

    expect(res.emergencyFundMonths).toBe(0);
    expect(res.dtiBps).toBe(2000); // 1.8M / 9.0M * 10000 = 2000 bps = 20%
  });

  it('handles zero expense and zero income gracefully', () => {
    const res = calculateRatios({
      liquidBalance: 10_000_000,
      monthlyExpenseAvg: 0,
      debtMonthlyObligation: 0,
      monthlyIncomeAvg: 0,
    });

    expect(res.emergencyFundMonths).toBeNull();
    expect(res.dtiBps).toBeNull();
  });
});
