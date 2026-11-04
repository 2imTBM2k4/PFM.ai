import { describe, expect, it } from 'vitest';
import {
  formatRecentTransactionTime,
  getYesterdayDateString,
} from './transaction-time';

describe('formatRecentTransactionTime (Group 4.1)', () => {
  it('computes yesterday accurately across month and year boundaries', () => {
    expect(getYesterdayDateString('2026-03-15')).toBe('2026-03-14');
    expect(getYesterdayDateString('2026-03-01')).toBe('2026-02-28');
    expect(getYesterdayDateString('2026-01-01')).toBe('2025-12-31');
  });

  it('formats today and yesterday transactions with HH:mm in Asia/Ho_Chi_Minh timezone', () => {
    const today = '2026-03-15';
    expect(
      formatRecentTransactionTime(
        '2026-03-15',
        '2026-03-15T10:30:00+07:00',
        today,
      ),
    ).toBe('Hôm nay, 10:30');

    expect(
      formatRecentTransactionTime(
        '2026-03-14',
        '2026-03-14T20:00:00+07:00',
        today,
      ),
    ).toBe('Hôm qua, 20:00');
  });

  it('omits synthetic 12:00 noon placeholder for backdated manual entries while keeping real timestamps', () => {
    const today = '2026-03-15';
    // Backdated manual entry created via manualOccurredAt uses T12:00:00+07:00
    expect(
      formatRecentTransactionTime(
        '2026-03-14',
        '2026-03-14T12:00:00+07:00',
        today,
      ),
    ).toBe('Hôm qua');

    expect(
      formatRecentTransactionTime(
        '2026-03-05',
        '2026-03-05T12:00:00+07:00',
        today,
      ),
    ).toBe('05/03');

    // Real timestamp on an older date in the same year includes HH:mm
    expect(
      formatRecentTransactionTime(
        '2026-03-05',
        '2026-03-05T08:45:00+07:00',
        today,
      ),
    ).toBe('05/03, 08:45');
  });
});

