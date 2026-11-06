import { describe, expect, it, vi } from 'vitest';
import {
  parseTransactionsFromCsv,
  serializeTransactionsToCsv,
  splitCsvLine,
} from './csv-transfer';

vi.mock('@/data/connection', () => ({
  withDatabase: async () => undefined,
}));

describe('Local CSV Export & Import Service (Stage 6)', () => {
  it('round-trips a USD transaction with its booked VND amount and rate', () => {
    const original = [{
      occurredOn: '2026-11-02', kind: 'expense' as const, amount: 255_000,
      note: 'Rent', categoryName: 'Housing',
      originalCurrency: 'USD' as const, originalAmountMinor: 1000, bookingRate: 25_500,
    }];
    expect(parseTransactionsFromCsv(serializeTransactionsToCsv(original))).toEqual(original);
    expect(() => parseTransactionsFromCsv('occurred_on,kind,amount,note,category,currency,original_amount_minor,booking_rate\n2026-11-02,expense,1,Rent,Housing,USD,1000,25500')).toThrow('CSV_EXCHANGE_MISMATCH');
  });
  it('serializes and parses RFC 4180 CSV with commas, quotes, and integer amounts', () => {
    const original = [
      {
        occurredOn: '2026-10-25',
        kind: 'expense' as const,
        amount: 45_000,
        note: 'Phở bò, quẩy & "trà đá"',
        categoryName: 'Ăn ngoài',
      },
      {
        occurredOn: '2026-10-26',
        kind: 'income' as const,
        amount: 25_000_000,
        note: 'Lương tháng 10',
        categoryName: 'Lương',
      },
    ];

    const csv = serializeTransactionsToCsv(original);
    expect(csv).toContain('occurred_on,kind,amount,note,category');
    expect(csv).toContain('"Phở bò, quẩy & ""trà đá"""');

    const parsed = parseTransactionsFromCsv(csv);
    expect(parsed).toEqual(original);
  });

  it('rejects floating-point, zero, negative, or oversized amounts (> 100B VND) and invalid dates', () => {
    expect(() =>
      parseTransactionsFromCsv(
        'occurred_on,kind,amount,note,category\n2026-10-25,expense,30000.5,Cafe,Ăn uống',
      ),
    ).toThrow('CSV_AMOUNT_NOT_INTEGER');

    expect(() =>
      parseTransactionsFromCsv(
        'occurred_on,kind,amount,note,category\n2026-10-25,expense,0,Cafe,Ăn uống',
      ),
    ).toThrow('CSV_AMOUNT_OUT_OF_RANGE');

    expect(() =>
      parseTransactionsFromCsv(
        'occurred_on,kind,amount,note,category\n2026-10-25,expense,-50000,Cafe,Ăn uống',
      ),
    ).toThrow('CSV_AMOUNT_NOT_INTEGER');

    expect(() =>
      parseTransactionsFromCsv(
        'occurred_on,kind,amount,note,category\n2026-10-25,expense,100000000001,Quá giới hạn,Khác',
      ),
    ).toThrow('CSV_AMOUNT_OUT_OF_RANGE');

    expect(() =>
      parseTransactionsFromCsv(
        'occurred_on,kind,amount,note,category\n2026-02-30,expense,30000,Ngày sai,Khác',
      ),
    ).toThrow();
  });

  it('splits quoted CSV lines accurately', () => {
    expect(
      splitCsvLine('2026-10-28,expense,30000,"Ăn sáng, cà phê",Ăn uống'),
    ).toEqual(['2026-10-28', 'expense', '30000', 'Ăn sáng, cà phê', 'Ăn uống']);
  });
});
