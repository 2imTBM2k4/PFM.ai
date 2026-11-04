import { roundHalfUp } from '../arithmetic';

// Calculate percentile using Type 7 linear interpolation (R / Excel standard) and round half-up.
export function percentileType7(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) {
    throw new RangeError('Cannot calculate percentiles of an empty array.');
  }
  if (p < 0 || p > 1) {
    throw new RangeError('Percentile p must be between 0 and 1.');
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const n = sortedValues.length;
  const index = (n - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;

  const value =
    sortedValues[lower] + fraction * (sortedValues[upper] - sortedValues[lower]);
  return roundHalfUp(value);
}

// Compute (p25, median, p75) or fallback to (min, median, max) when data has fewer than 4 points.
export function calculateSurplusPercentiles(values: number[]): {
  p25: number;
  median: number;
  p75: number;
} {
  if (values.length === 0) {
    return { p25: 0, median: 0, p75: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  if (n < 4) {
    return {
      p25: sorted[0],
      median: percentileType7(sorted, 0.5),
      p75: sorted[n - 1],
    };
  }

  return {
    p25: percentileType7(sorted, 0.25),
    median: percentileType7(sorted, 0.5),
    p75: percentileType7(sorted, 0.75),
  };
}
