import { describe, expect, it } from 'vitest';
import { budgetBannerItems, budgetThresholds } from './budgets';

describe('budgetThresholds', () => {
  it('uses exact inclusive budget thresholds and emits 100 percent once when warning is also 100', () => {
    expect(budgetThresholds(2399999, 3000000, 80)).toEqual([]);
    expect(budgetThresholds(2400000, 3000000, 80)).toEqual([80]);
    expect(budgetThresholds(2999999, 3000000, 80)).toEqual([80]);
    expect(budgetThresholds(3000000, 3000000, 80)).toEqual([80, 100]);
    expect(budgetThresholds(3000001, 3000000, 80)).toEqual([80, 100]);
    expect(budgetThresholds(3000000, 3000000, 100)).toEqual([100]);
    expect(budgetThresholds(9000000000000000, 100000000000, 80)).toEqual([
      80, 100,
    ]);
    for (const args of [
      [-1, 1, 80],
      [1, 0, 80],
      [1, 1, 0],
      [1, 1, 101],
      [0.5, 1, 80],
    ])
      expect(() => budgetThresholds(args[0], args[1], args[2])).toThrow();
  });
});

describe('budgetBannerItems', () => {
  it('triggers warn at exact threshold and ignores 1 VND below threshold', () => {
    expect(
      budgetBannerItems([
        {
          id: 'b-under',
          category_name: 'Ăn uống',
          spent: 79_999,
          amount: 100_000,
          warn_percent: 80,
          is_active: 1,
          in_period: 1,
        },
      ]),
    ).toEqual([]);

    expect(
      budgetBannerItems([
        {
          id: 'b-exact-warn',
          category_name: 'Ăn uống',
          spent: 80_000,
          amount: 100_000,
          warn_percent: 80,
          is_active: 1,
          in_period: 1,
        },
      ]),
    ).toEqual([
      {
        budgetId: 'b-exact-warn',
        categoryName: 'Ăn uống',
        level: 'warn',
        spent: 80_000,
        amount: 100_000,
        percent: 80,
        overBy: 0,
      },
    ]);
  });

  it('triggers over when spent equals or exceeds amount and floors percent', () => {
    expect(
      budgetBannerItems([
        {
          id: 'b-exact-limit',
          category_name: null,
          spent: 100_000,
          amount: 100_000,
          warn_percent: 80,
          is_active: 1,
          in_period: 1,
        },
        {
          id: 'b-exceeded',
          category_name: 'Mua sắm',
          spent: 125_900,
          amount: 100_000,
          warn_percent: 80,
          is_active: 1,
          in_period: 1,
        },
      ]),
    ).toEqual([
      {
        budgetId: 'b-exceeded',
        categoryName: 'Mua sắm',
        level: 'over',
        spent: 125_900,
        amount: 100_000,
        percent: 125,
        overBy: 25_900,
      },
      {
        budgetId: 'b-exact-limit',
        categoryName: null,
        level: 'over',
        spent: 100_000,
        amount: 100_000,
        percent: 100,
        overBy: 0,
      },
    ]);
  });

  it('emits only over and never warn when warn_percent is 100', () => {
    expect(
      budgetBannerItems([
        {
          id: 'b-99',
          category_name: 'Di chuyển',
          spent: 99_999,
          amount: 100_000,
          warn_percent: 100,
          is_active: 1,
          in_period: 1,
        },
      ]),
    ).toEqual([]);

    expect(
      budgetBannerItems([
        {
          id: 'b-100',
          category_name: 'Di chuyển',
          spent: 100_000,
          amount: 100_000,
          warn_percent: 100,
          is_active: 1,
          in_period: 1,
        },
      ]),
    ).toEqual([
      {
        budgetId: 'b-100',
        categoryName: 'Di chuyển',
        level: 'over',
        spent: 100_000,
        amount: 100_000,
        percent: 100,
        overBy: 0,
      },
    ]);
  });

  it('skips paused or out-of-period budgets and sorts over before warn then descending percent', () => {
    const items = budgetBannerItems([
      {
        id: 'paused-over',
        category_name: 'Giải trí',
        spent: 500_000,
        amount: 100_000,
        warn_percent: 80,
        is_active: 0,
        in_period: 1,
      },
      {
        id: 'out-of-period-over',
        category_name: 'Du lịch',
        spent: 500_000,
        amount: 100_000,
        warn_percent: 80,
        is_active: 1,
        in_period: 0,
      },
      {
        id: 'warn-82',
        category_name: 'Ăn uống',
        spent: 82_000,
        amount: 100_000,
        warn_percent: 80,
        is_active: 1,
        in_period: 1,
      },
      {
        id: 'over-110',
        category_name: null,
        spent: 1_100_000,
        amount: 1_000_000,
        warn_percent: 80,
        is_active: 1,
        in_period: 1,
      },
      {
        id: 'warn-95',
        category_name: 'Hóa đơn',
        spent: 190_000,
        amount: 200_000,
        warn_percent: 85,
        is_active: 1,
        in_period: 1,
      },
      {
        id: 'over-140',
        category_name: 'Mua sắm',
        spent: 700_000,
        amount: 500_000,
        warn_percent: 90,
        is_active: 1,
        in_period: 1,
      },
    ]);

    expect(items.map((item) => item.budgetId)).toEqual([
      'over-140',
      'over-110',
      'warn-95',
      'warn-82',
    ]);
  });

  it('handles large amounts near 1e11 without overflow or precision loss', () => {
    const limit = 100_000_000_000;
    const warnAt80 = 80_000_000_000;
    expect(
      budgetBannerItems([
        {
          id: 'large-under',
          category_name: null,
          spent: warnAt80 - 1,
          amount: limit,
          warn_percent: 80,
          is_active: 1,
          in_period: 1,
        },
        {
          id: 'large-warn',
          category_name: null,
          spent: limit - 1,
          amount: limit,
          warn_percent: 80,
          is_active: 1,
          in_period: 1,
        },
      ]),
    ).toEqual([
      {
        budgetId: 'large-warn',
        categoryName: null,
        level: 'warn',
        spent: 99_999_999_999,
        amount: 100_000_000_000,
        percent: 99,
        overBy: 0,
      },
    ]);
  });
});
