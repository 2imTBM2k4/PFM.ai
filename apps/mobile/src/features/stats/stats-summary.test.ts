import { describe, expect, it } from 'vitest';
import {
  aggregatePeriodSummary,
  buildDonutBreakdown,
  computeCategoryAllocation,
  computeDonutCallouts,
  computeTrendChartScale,
  formatAllocationPercentLabel,
  resolveCategoryVisual,
  shouldShowDailyTotals,
} from './stats-summary';

it('shows daily totals through today and hides them on future calendar days', () => {
  expect(shouldShowDailyTotals('2026-11-03', '2026-11-04')).toBe(true);
  expect(shouldShowDailyTotals('2026-11-04', '2026-11-04')).toBe(true);
  expect(shouldShowDailyTotals('2026-11-05', '2026-11-04')).toBe(false);
  expect(shouldShowDailyTotals('2026-12-01', '2026-11-04')).toBe(false);
});

describe('Stats Summary & Category Allocation (Stage 5)', () => {
  it('handles zero-transaction months with 0 income, 0 expense, 0 net, and 0% savings rate', () => {
    const emptySummary = aggregatePeriodSummary([
      { month: '2026-08', income: 0, expense: 0 },
      { month: '2026-09', income: 0, expense: 0 },
      { month: '2026-10', income: 0, expense: 0 },
    ]);

    expect(emptySummary).toEqual({
      totalIncome: 0,
      totalExpense: 0,
      netSavings: 0,
      savingsRatePercent: 0,
    });

    const emptyAllocation = computeCategoryAllocation([]);
    expect(emptyAllocation).toEqual({ totalExpense: 0, items: [] });
  });

  it('aggregates 1M, 3M, and 6M flows accurately using exact integers', () => {
    const threeMonths = [
      { month: '2026-08', income: 20_000_000, expense: 12_000_000 },
      { month: '2026-09', income: 25_000_000, expense: 15_000_000 },
      { month: '2026-10', income: 30_000_000, expense: 18_000_000 },
    ];

    const summary = aggregatePeriodSummary(threeMonths);
    expect(summary.totalIncome).toBe(75_000_000);
    expect(summary.totalExpense).toBe(45_000_000);
    expect(summary.netSavings).toBe(30_000_000);
    expect(summary.savingsRatePercent).toBe(40);
  });

  it('clamps savings rate to 0% when expenses exceed income (negative net flow)', () => {
    const deficit = aggregatePeriodSummary([
      { month: '2026-10', income: 10_000_000, expense: 14_500_000 },
    ]);

    expect(deficit.netSavings).toBe(-4_500_000);
    expect(deficit.savingsRatePercent).toBe(0);
  });

  it('keeps expense categories beyond six in the complete allocation total', () => {
    const categories = Array.from({ length: 7 }, (_, index) => ({
      id: `category-${index}`,
      name: `Category ${index}`,
      amount: 100,
    }));
    const allocation = computeCategoryAllocation(categories);
    expect(allocation.totalExpense).toBe(700);
    expect(allocation.items).toHaveLength(7);
    expect(allocation.items.map((item) => item.percentage)).toEqual(
      Array(7).fill(14),
    );
  });

  it('sorts category allocation descending by amount and preserves integer amounts', () => {
    const allocation = computeCategoryAllocation([
      { id: 'c1', name: 'Di chuyển', amount: 1_000_000 },
      { id: 'c2', name: 'Nhà ở', amount: 5_000_000 },
      { id: 'c3', name: 'Ăn uống', amount: 4_000_000 },
    ]);

    expect(allocation.totalExpense).toBe(10_000_000);
    expect(allocation.items.map((i) => i.name)).toEqual([
      'Nhà ở',
      'Ăn uống',
      'Di chuyển',
    ]);
    expect(allocation.items.map((i) => i.percentage)).toEqual([50, 40, 10]);
  });

  it('formats <1%, 100%, and 99% allocation labels cleanly', () => {
    expect(formatAllocationPercentLabel(1, 86_000, 2)).toBe('<1%');
    expect(formatAllocationPercentLabel(85_999, 86_000, 2)).toBe('99%');
    expect(formatAllocationPercentLabel(500_000, 500_000, 1)).toBe('100%');
    expect(formatAllocationPercentLabel(75, 100, 4)).toBe('75%');
    expect(formatAllocationPercentLabel(0, 100, 2)).toBe('0%');
  });

  it('builds complete breakdown items and merges tail beyond 5 top slices into Other for donut chart', () => {
    const input = [
      { id: 'c1', systemKey: 'expense.housing', name: 'Nhà ở', amount: 750_000 },
      { id: 'c2', systemKey: 'expense.food', name: 'Ăn uống', amount: 130_000 },
      { id: 'c3', systemKey: 'expense.bills_subscriptions', name: 'Hóa đơn', amount: 100_000 },
      { id: 'c4', systemKey: 'expense.transport', name: 'Di chuyển', amount: 20_000 },
      { id: 'c5', systemKey: 'expense.health', name: 'Sức khỏe', amount: 15_000 },
      { id: 'c6', systemKey: 'expense.education', name: 'Giáo dục', amount: 10_000 },
      { id: null, systemKey: null, name: null, amount: 5_000 },
    ];

    const breakdown = buildDonutBreakdown(input, 'Chưa phân loại', 'Khác');
    expect(breakdown.total).toBe(1_030_000);
    expect(breakdown.items).toHaveLength(7);
    expect(breakdown.slices).toHaveLength(6);
    expect(breakdown.slices.at(-1)?.name).toBe('Khác');
    expect(breakdown.slices.at(-1)?.amount).toBe(15_000);
    expect(breakdown.items[0].icon).toBe('home');
    expect(breakdown.items.at(-1)?.icon).toBe('help-circle-outline');
  });

  it('solves non-overlapping left/right donut callout positions with minimum vertical spacing', () => {
    const { slices } = buildDonutBreakdown(
      [
        { id: 'c1', systemKey: 'expense.housing', name: 'Nhà ở', amount: 750_000 },
        { id: 'c2', systemKey: 'expense.food', name: 'Ăn uống', amount: 130_000 },
        { id: 'c3', systemKey: 'expense.bills_subscriptions', name: 'Hóa đơn', amount: 100_000 },
        { id: 'c4', systemKey: 'expense.transport', name: 'Di chuyển', amount: 20_000 },
        { id: 'c5', systemKey: 'expense.health', name: 'Sức khỏe', amount: 10_000 },
        { id: 'c6', systemKey: 'expense.education', name: 'Giáo dục', amount: 5_000 },
      ],
      'Chưa phân loại',
      'Khác',
    );

    const points = computeDonutCallouts(slices, 156, 114, 62, 24, 204, 38);
    expect(points).toHaveLength(6);

    const checkSpacing = (column: typeof points) => {
      const sorted = [...column].sort((a, b) => a.labelY - b.labelY);
      for (let i = 0; i < sorted.length; i++) {
        expect(sorted[i].labelY).toBeGreaterThanOrEqual(24);
        expect(sorted[i].labelY).toBeLessThanOrEqual(204);
        if (i > 0) {
          expect(sorted[i].labelY - sorted[i - 1].labelY).toBeGreaterThanOrEqual(37.9);
        }
      }
    };

    checkSpacing(points.filter((p) => p.side === 'left'));
    checkSpacing(points.filter((p) => p.side === 'right'));
  });

  it('resolves explicit category visuals over system keys and uncategorized fallbacks', () => {
    expect(
      resolveCategoryVisual(
        { systemKey: 'expense.food', icon: 'cart', color: '#195DB7' },
        0,
        false,
      ),
    ).toEqual({ icon: 'cart', color: '#195DB7' });
    expect(resolveCategoryVisual({ systemKey: null }, 0, true)).toEqual({
      icon: 'help-circle-outline',
      color: '#F472B6',
    });
  });

  it('computes clean unidirectional, downward-only, and symmetric trend chart scales', () => {
    const upward = computeTrendChartScale([0, 6_850_000, 1_600_000], false);
    expect(upward.unitKind).toBe('million');
    expect(upward.ticks).toEqual([8, 6, 4, 2, 0]);
    expect(upward.zeroRatio).toBe(1);
    expect(upward.maxRawValue).toBe(8_000_000);

    const downwardOnly = computeTrendChartScale([-24_688_083, -4_685_195], true);
    expect(downwardOnly.unitKind).toBe('million');
    expect(downwardOnly.ticks).toEqual([0, -8, -16, -24, -32]);
    expect(downwardOnly.zeroRatio).toBe(0);
    expect(downwardOnly.minRawValue).toBe(-32_000_000);

    const bidirectional = computeTrendChartScale([-3_599_000, 2_127_668], true);
    expect(bidirectional.unitKind).toBe('million');
    expect(bidirectional.ticks).toEqual([3.6, 2.4, 1.2, 0, -1.2, -2.4, -3.6]);
    expect(bidirectional.zeroRatio).toBe(0.5);

    const smallThousands = computeTrendChartScale([120_000, 450_000], false);
    expect(smallThousands.unitKind).toBe('thousand');
    expect(smallThousands.ticks).toEqual([480, 360, 240, 120, 0]);
  });
});
