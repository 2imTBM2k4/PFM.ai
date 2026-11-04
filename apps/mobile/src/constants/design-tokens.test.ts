import { describe, expect, it, vi } from 'vitest';
import { createSoftShadow } from './design-tokens';
import { formatCurrencyAmount, formatTransactionCurrencyAmount } from '@/state/preferences';

vi.mock('@/data/connection', () => ({
  withDatabase: async () => undefined,
}));

describe('Shadow & Currency Formatting Utilities', () => {
  it('computes mode-aware soft shadows for sm, md, and lg elevations', () => {
    const lightSm = createSoftShadow('light', 'sm');
    const lightMd = createSoftShadow('light', 'md');
    const darkLg = createSoftShadow('dark', 'lg');

    expect(lightSm.shadowRadius ?? 0).toBeLessThan(lightMd.shadowRadius ?? 0);
    expect(lightMd.shadowRadius).toBe(18);
    expect(darkLg.shadowRadius).toBe(26);
    expect(darkLg.shadowOpacity ?? 0).toBeGreaterThan(
      lightMd.shadowOpacity ?? 0,
    );
  });

  it('formats zero, standard, negative, and huge integer currency amounts accurately without floats', () => {
    // Zero balance
    expect(formatCurrencyAmount(0, 'VND')).toBe('0 ₫');
    expect(formatCurrencyAmount(0, 'USD', { rate: 25_500 })).toBe('$0.00');
    expect(formatCurrencyAmount(255_000, 'USD', { rate: 25_500 })).toBe('$10.00');

    // Standard integer VND & USD conversion
    expect(formatCurrencyAmount(30_000, 'VND')).toBe('30.000 ₫');
    expect(formatCurrencyAmount(1_500_000, 'VND', { showPlus: true })).toBe(
      '+1.500.000 ₫',
    );
    expect(formatCurrencyAmount(-450_000, 'VND')).toBe('-450.000 ₫');

    // Compact formatting
    expect(formatCurrencyAmount(1_500_000, 'VND', { compact: true })).toBe(
      '1.5M ₫',
    );
    expect(formatCurrencyAmount(100_000_000_000, 'VND')).toBe(
      '100.000.000.000 ₫',
    );

    // Truncates any accidental float input to integer smallest unit
    expect(formatCurrencyAmount(30000.89, 'VND')).toBe('30.000 ₫');
  });

  it('shows the original USD and converts an old USD transaction at the current rate', () => {
    const row = { amount: 255_000, original_amount_minor: 1000, original_currency: 'USD' as const, booking_rate: 25_500 };
    expect(formatTransactionCurrencyAmount(row, 'USD', 26_000)).toBe('$10.00');
    expect(formatTransactionCurrencyAmount(row, 'VND', 26_000)).toBe('260.000 ₫');
    expect(row.amount).toBe(255_000);
  });
});
