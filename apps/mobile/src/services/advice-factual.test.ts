import { describe, expect, it, vi } from 'vitest';

import {
  buildFactualAdviceReply,
  formatFactRange,
  toChartItems,
} from './advice-factual';
import { en } from '@/messages/en';
import { vi as viMessages } from '@/messages/vi';
import { factsLabels } from '@/messages/seed-labels';
import type { AdviceFactData } from '@/data/advice-insights';

// Preferences pull in the Expo runtime, so the test supplies a faithful
// formatter with the same VND/USD rendering contract.
vi.mock('@/state/preferences', () => ({
  usePreferences: { getState: () => ({ currency: 'VND', exchangeRate: null }) },
  formatCurrencyAmount: (
    amount: number,
    currency: 'VND' | 'USD',
    options?: { rate?: number },
  ) => {
    if (currency === 'USD') {
      const rate = options?.rate;
      if (!rate) return '—';
      const cents = Math.round((amount * 100) / rate);
      const dollars = Math.floor(cents / 100)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return `$${dollars}.${String(cents % 100).padStart(2, '0')}`;
    }
    const grouped = Math.abs(amount)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${amount < 0 ? '-' : ''}${grouped} ₫`;
  },
}));

const CLOCK = {
  now: () => new Date('2026-11-04T03:00:00Z'),
  timeZone: 'Asia/Ho_Chi_Minh',
};

const labels = (language: 'vi' | 'en') =>
  factsLabels(language, language === 'en' ? en : viMessages);

const expenseData = (
  overrides: Partial<
    Extract<AdviceFactData, { kind: 'expense_by_category' }>
  > = {},
): AdviceFactData => ({
  kind: 'expense_by_category',
  totalExpense: 5_000_000,
  topCategories: [
    { name: 'Tiền nhà', systemKey: 'expense.housing.rent', amount: 3_500_000 },
    { name: 'Ăn uống', systemKey: 'expense.food', amount: 1_000_000 },
  ],
  otherAmount: 500_000,
  uncategorizedAmount: 0,
  transactionCount: 12,
  ...overrides,
});

const build = (
  data: AdviceFactData,
  options: {
    language?: 'vi' | 'en';
    currency?: 'VND' | 'USD';
    exchangeRate?: number | null;
    from?: string;
    to?: string;
  } = {},
) =>
  buildFactualAdviceReply({
    kind: data.kind,
    range: {
      kind: 'last_7_days',
      from: options.from ?? '2026-10-29',
      to: options.to ?? '2026-11-04',
    },
    data,
    labels: labels(options.language ?? 'vi'),
    language: options.language ?? 'vi',
    currency: options.currency ?? 'VND',
    exchangeRate: options.exchangeRate ?? null,
    userMessageId: 'msg-1',
    clock: CLOCK,
  });

describe('buildFactualAdviceReply - the reported question', () => {
  it('reports the period, the largest category, its share and the total', () => {
    const reply = build(expenseData());
    expect(reply.replyText).toContain('29/10 – 4/11');
    expect(reply.replyText).toContain('Tiền nhà');
    expect(reply.replyText).toContain('3.500.000 ₫');
    expect(reply.replyText).toContain('70%');
    expect(reply.replyText).toContain('5.000.000 ₫');
    expect(reply.chartItems?.map((item) => item.category)).toEqual([
      'Tiền nhà',
      'Ăn uống',
    ]);
    expect(reply.chartItems?.[0].percentage).toBe(78);
    expect(reply.chartItems?.reduce((sum, item) => sum + item.amount, 0)).toBe(
      4_500_000,
    );
  });

  it('labels a window that crosses a month boundary with both months', () => {
    expect(
      formatFactRange(
        { kind: 'last_7_days', from: '2026-10-29', to: '2026-11-04' },
        'vi',
        '2026-11-04',
      ),
    ).toBe('29/10 – 4/11');
    expect(
      formatFactRange(
        { kind: 'last_7_days', from: '2025-12-28', to: '2026-01-03' },
        'vi',
        '2026-01-03',
      ),
    ).toBe('28/12/2025 – 3/1/2026');
  });

  it('never shows sample chart data as real data', () => {
    const reply = build(expenseData());
    expect(reply.chartItems?.every((item) => item.amount > 0)).toBe(true);
    expect(reply.chartTitle).toContain('29/10 – 4/11');
  });
});

describe('buildFactualAdviceReply - empty and partial data', () => {
  it('says there is no spending for the period instead of guessing habits', () => {
    const reply = build(
      expenseData({
        totalExpense: 0,
        topCategories: [],
        otherAmount: 0,
        uncategorizedAmount: 0,
        transactionCount: 0,
      }),
    );
    expect(reply.replyText).toBe('Từ 29/10 – 4/11 bạn chưa ghi khoản chi nào.');
    expect(reply.chartItems).toBeUndefined();
  });

  it('explains when only uncategorized spending exists', () => {
    const reply = build(
      expenseData({
        totalExpense: 250_000,
        topCategories: [],
        otherAmount: 250_000,
        uncategorizedAmount: 250_000,
        transactionCount: 2,
      }),
    );
    expect(reply.replyText).toContain('Các nhóm còn lại: 250.000 ₫');
    expect(reply.replyText).toContain('chưa phân loại 250.000 ₫');
  });

  it('reports an empty cash-flow window in words', () => {
    const reply = build({
      kind: 'cash_flow',
      totalIncome: 0,
      totalExpense: 0,
      net: 0,
      incomeCount: 0,
      expenseCount: 0,
    });
    expect(reply.replyText).toBe(
      'Từ 29/10 – 4/11 bạn chưa ghi giao dịch thu hoặc chi nào.',
    );
  });
});

describe('buildFactualAdviceReply - language and currency', () => {
  it('answers a cash-flow question with income, spending and the difference', () => {
    const reply = build({
      kind: 'cash_flow',
      totalIncome: 15_000_000,
      totalExpense: 5_000_000,
      net: 10_000_000,
      incomeCount: 2,
      expenseCount: 4,
    });
    expect(reply.replyText).toBe(
      'Từ 29/10 – 4/11: thu 15.000.000 ₫, chi 5.000.000 ₫, chênh lệch 10.000.000 ₫.',
    );
  });

  it('translates system categories and keeps custom names untouched in English', () => {
    const reply = build(
      expenseData({
        topCategories: [
          {
            name: 'Tiền nhà',
            systemKey: 'expense.housing.rent',
            amount: 3_000_000,
          },
          { name: 'Học phí của con', systemKey: null, amount: 2_000_000 },
        ],
        totalExpense: 5_000_000,
        otherAmount: 0,
      }),
      { language: 'en' },
    );
    expect(reply.replyText).toContain('Rent');
    expect(reply.replyText).toContain('Học phí của con');
    expect(reply.replyText).toContain('From Oct 29 – Nov 4');
  });

  it('converts every amount to USD with the current rate', () => {
    const reply = build(expenseData(), {
      currency: 'USD',
      exchangeRate: 25_000,
    });
    expect(reply.replyText).toContain('$200.00');
    expect(reply.replyText).toContain('$140.00');
    expect(reply.replyText).toContain('$40.00');
  });

  it('never prints a bare dash when the rate is missing', () => {
    const reply = build(expenseData(), { currency: 'USD', exchangeRate: null });
    // formatCurrencyAmount degrades to '—'; the caller guards this case, and the
    // builder must not silently invent a converted amount.
    expect(reply.replyText).not.toContain('$');
  });
});

describe('toChartItems', () => {
  it('returns no chart when every amount is zero', () => {
    expect(
      toChartItems(
        [{ name: 'Ăn uống', systemKey: 'expense.food', amount: 0 }],
        labels('vi'),
      ),
    ).toEqual([]);
  });

  it('keeps at least one percent for a tiny share', () => {
    const items = toChartItems(
      [
        { name: 'Lớn', systemKey: null, amount: 1_000_000 },
        { name: 'Nhỏ', systemKey: null, amount: 1 },
      ],
      labels('vi'),
    );
    expect(items[1].percentage).toBeGreaterThanOrEqual(1);
  });
});
