import { expect, it } from 'vitest';
import {
  AnalysisSummarySchema,
  CalculationSchema,
} from '../../packages/contracts/src/index.ts';
import { cases } from './cases.mjs';

it('contains 80 distinct synthetic questions in ten balanced groups with valid contracts', () => {
  expect(cases).toHaveLength(80);
  expect(new Set(cases.map((c) => c.id)).size).toBe(80);
  expect(new Set(cases.map((c) => c.question)).size).toBe(80);
  const groups = new Map();
  for (const c of cases) {
    groups.set(c.group, (groups.get(c.group) ?? 0) + 1);
    expect(c.question.length).toBeLessThanOrEqual(500);
    expect(AnalysisSummarySchema.safeParse(c.summary).success, c.id).toBe(true);
    for (const calculation of c.calculations)
      expect(CalculationSchema.safeParse(calculation).success, c.id).toBe(true);
    expect(c.rubric.length).toBeGreaterThan(10);
  }
  expect(groups.size).toBe(10);
  expect([...groups.values()]).toEqual(Array(10).fill(8));
});

it('uses independently hand-checked flat-loan totals and rational amortization', () => {
  const flat = cases.find((c) => c.id === 'flat-1').calculations[0];
  expect(flat.results).toEqual({
    monthlyPayment: 1120000,
    totalInterest: 1440000,
    totalPayment: 13440000,
    effectiveRateBps: 2146,
  });
  const declining = cases.find((c) => c.id === 'declining-1').calculations[0];
  expect(declining.results.monthlyPayment).toBe(1066185);
  expect(declining.results.totalInterest).toBe(794226);
  expect(declining.results.totalPayment).toBe(12794226);
  // Independently verify the nominal flat IRR using discounted payments, not the production solver.
  const pv = (bps) =>
    Array.from(
      { length: 12 },
      (_, i) => 1120000 / (1 + bps / 120000) ** (i + 1),
    ).reduce((a, b) => a + b, 0);
  // The published rate is rounded to one basis point, so bracket its half-unit interval.
  expect(pv(flat.results.effectiveRateBps - 0.5)).toBeGreaterThan(12000000);
  expect(pv(flat.results.effectiveRateBps + 0.5)).toBeLessThan(12000000);
});

it('includes zero/negative surplus, already affordable, short history and debt stress', () => {
  expect(
    cases.some((c) =>
      c.calculations.some(
        (x) =>
          x.type === 'time_to_afford' &&
          x.inputs.surplus === 0 &&
          x.results.typicalMonths === null,
      ),
    ),
  ).toBe(true);
  expect(
    cases.some((c) =>
      c.calculations.some(
        (x) =>
          x.type === 'time_to_afford' &&
          x.inputs.surplus < 0 &&
          x.results.typicalMonths === null,
      ),
    ),
  ).toBe(true);
  expect(
    cases.some((c) =>
      c.calculations.some(
        (x) =>
          x.type === 'time_to_afford' &&
          x.results.remaining === 0 &&
          x.results.typicalMonths === 0,
      ),
    ),
  ).toBe(true);
  expect(cases.some((c) => c.summary.window.monthsWithData === 0)).toBe(true);
  expect(
    cases
      .filter((c) => c.group === 'stress')
      .every((c) => c.summary.riskFlags.includes('DEBT_STRESS')),
  ).toBe(true);
});
