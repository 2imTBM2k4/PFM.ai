import { describe, expect, it, vi } from 'vitest';
import { parseAmountInput } from '@/features/transactions/form';
import {
  computeMoneyCaretOffset,
  countSignificantMoneyChars,
  formatMoneyDisplay,
  moneyInputError,
  sanitizeMoneyValue,
} from './money-input';

vi.mock('react-native-paper', () => ({
  TextInput: 'TextInput',
  HelperText: 'HelperText',
}));

vi.mock('react-native', () => ({ View: 'View' }));

vi.mock('@/state/preferences', () => ({
  usePreferences: () => 'vi',
}));

describe('MoneyInput pure helpers', () => {
  it('normalizes unambiguous grouping and preserves invalid pasted text', () => {
    expect(sanitizeMoneyValue('1.500.000')).toBe('1500000');
    expect(sanitizeMoneyValue('1,500,000')).toBe('1500000');
    expect(sanitizeMoneyValue(' 30 000 ')).toBe('30000');
    expect(sanitizeMoneyValue('abc12xyz')).toBe('abc12xyz');
    expect(sanitizeMoneyValue('0001500')).toBe('1500');
    expect(sanitizeMoneyValue('000')).toBe('0');
    expect(sanitizeMoneyValue('')).toBe('');
    expect(sanitizeMoneyValue('abc')).toBe('abc');
  });

  it('preserves amounts exceeding the limit so they can be corrected', () => {
    expect(sanitizeMoneyValue('100000000000')).toBe('100000000000');
    expect(sanitizeMoneyValue('100000000001')).toBe('100000000001');
    expect(sanitizeMoneyValue('999.999.999.999.999')).toBe('999999999999999');
  });

  it('supports negative initial balances when allowNegative is enabled', () => {
    expect(sanitizeMoneyValue('-2.000.000', { allowNegative: true })).toBe(
      '-2000000',
    );
    expect(sanitizeMoneyValue('-', { allowNegative: true })).toBe('-');
    expect(sanitizeMoneyValue('-2000000', { allowNegative: false })).toBe(
      '-2000000',
    );
    expect(
      formatMoneyDisplay('-2000000', { allowNegative: true, language: 'vi' }),
    ).toBe('-2.000.000');
    expect(
      formatMoneyDisplay('-2000000', { allowNegative: true, language: 'en' }),
    ).toBe('-2,000,000');
  });

  it('handles Backspace over a thousands separator by deleting the preceding digit', () => {
    // User had "1.500" and pressed Backspace right after '.', producing "1500"
    expect(
      sanitizeMoneyValue('1500', {
        currency: 'VND',
        previousDisplay: '1.500',
      }),
    ).toBe('500');
  });

  it('formats VND with dots in Vietnamese and commas in English', () => {
    expect(formatMoneyDisplay('1500000', { language: 'vi' })).toBe('1.500.000');
    expect(formatMoneyDisplay('1500000', { language: 'en' })).toBe('1,500,000');
    expect(formatMoneyDisplay('1.500.000', { language: 'en' })).toBe(
      '1,500,000',
    );
  });

  it('preserves USD decimals while grouping the integer part with commas', () => {
    expect(sanitizeMoneyValue('1,500.25', { currency: 'USD' })).toBe('1500.25');
    expect(sanitizeMoneyValue('0010.5', { currency: 'USD' })).toBe('10.5');
    expect(sanitizeMoneyValue('10.999', { currency: 'USD' })).toBe('10.999');
    expect(sanitizeMoneyValue('10.', { currency: 'USD' })).toBe('10.');
    expect(formatMoneyDisplay('1500.25', { currency: 'USD' })).toBe('1,500.25');
    expect(formatMoneyDisplay('1500.', { currency: 'USD' })).toBe('1,500.');
  });

  it('computes stable caret position when inserting or deleting in the middle of a number', () => {
    // User had "1.500.000", placed cursor after '5' (index 3) and typed '2' -> rawText = "1.5200.000", cursor at 4
    const rawEdited = '1.5200.000';
    const sigBefore = countSignificantMoneyChars(rawEdited, 4);
    expect(sigBefore).toBe(3); // '1', '5', '2'
    const nextDisplay = formatMoneyDisplay(
      sanitizeMoneyValue(rawEdited, { previousDisplay: '1.500.000' }),
      {
        language: 'vi',
      },
    );
    expect(nextDisplay).toBe('15.200.000');
    const nextCaret = computeMoneyCaretOffset(nextDisplay, sigBefore);
    // In "15.200.000", index 4 is right after '2' ("15.2|00.000")
    expect(nextDisplay.slice(0, nextCaret)).toBe('15.2');
  });

  it.each([
    '30k',
    '1tr',
    '30.000 ₫',
    '$10',
    '1.5',
    '1,5',
    '1.00',
    '1,000.000',
    '1e3',
    '12 34',
    '--12',
  ])('keeps ambiguous VND input %s visible and invalid', (raw) => {
    expect(sanitizeMoneyValue(raw)).toBe(raw);
    expect(formatMoneyDisplay(raw)).toBe(raw);
    expect(moneyInputError(raw)).toBe('format');
  });

  it('reports limits and prohibited negatives without changing their values', () => {
    expect(moneyInputError('100000000000')).toBeNull();
    expect(moneyInputError('100000000001')).toBe('limit');
    expect(moneyInputError('-12')).toBe('negative');
    expect(moneyInputError('-12', { allowNegative: true })).toBeNull();
    expect(moneyInputError('-100000000001', { allowNegative: true })).toBe(
      'limit',
    );
    expect(moneyInputError('101', { maxAmount: 100 })).toBe('limit');
    expect(moneyInputError('0')).toBeNull();
    expect(moneyInputError('')).toBeNull();
  });

  it.each(['10.999', '10..2', '1,50.25', '10,25', '1e2', '$10'])(
    'preserves invalid USD input %s',
    (raw) => {
      expect(sanitizeMoneyValue(raw, { currency: 'USD' })).toBe(raw);
      expect(formatMoneyDisplay(raw, { currency: 'USD' })).toBe(raw);
      expect(moneyInputError(raw, { currency: 'USD' })).toBe('format');
    },
  );

  it('checks USD limits in cents without rounding or dropping decimals', () => {
    expect(moneyInputError('999999999.99', { currency: 'USD' })).toBeNull();
    expect(moneyInputError('1000000000.01', { currency: 'USD' })).toBe('limit');
    expect(sanitizeMoneyValue('1000000000.01', { currency: 'USD' })).toBe(
      '1000000000.01',
    );
    expect(sanitizeMoneyValue('.5', { currency: 'USD' })).toBe('0.5');
  });

  it('distinguishes single-character edits of formatted values from malformed pastes', () => {
    expect(sanitizeMoneyValue('1.50', { previousDisplay: '1.500' })).toBe(
      '150',
    );
    expect(sanitizeMoneyValue('1.5000', { previousDisplay: '1.500' })).toBe(
      '15000',
    );
    expect(sanitizeMoneyValue('1.5000')).toBe('1.5000');
    expect(
      sanitizeMoneyValue('1,5000.25', {
        currency: 'USD',
        previousDisplay: '1,500.25',
      }),
    ).toBe('15000.25');
    expect(
      sanitizeMoneyValue('10.999', {
        currency: 'USD',
        previousDisplay: '10.99',
      }),
    ).toBe('10.999');
  });

  it('never lets invalid input turn into a different saveable transaction amount', () => {
    for (const raw of [
      '30k',
      '1tr',
      '-30000',
      '100000000001',
      '1.5',
      '1e3',
      '$10',
      '1,000.000',
    ]) {
      const value = sanitizeMoneyValue(raw);
      expect(() => parseAmountInput(value)).toThrow();
    }
    for (const raw of ['10.999', '10,25', '-10', '1000000000.01', '$10']) {
      const value = sanitizeMoneyValue(raw, { currency: 'USD' });
      expect(() => parseAmountInput(value, 'USD')).toThrow();
    }
    expect(parseAmountInput(sanitizeMoneyValue('30.000'))).toBe(30000);
    expect(
      parseAmountInput(
        sanitizeMoneyValue('1,500.25', { currency: 'USD' }),
        'USD',
      ),
    ).toBe(150025);
  });

  it('keeps grouping stable throughout repeated typing and deletion', () => {
    for (const language of ['vi', 'en'] as const) {
      let display = '';
      for (const digit of '15000000') {
        const value = sanitizeMoneyValue(display + digit, {
          previousDisplay: display,
        });
        display = formatMoneyDisplay(value, { language });
        expect(moneyInputError(value)).toBeNull();
      }
      expect(parseAmountInput(sanitizeMoneyValue(display))).toBe(15000000);
      while (display) {
        const value = sanitizeMoneyValue(display.slice(0, -1), {
          previousDisplay: display,
        });
        expect(moneyInputError(value)).toBeNull();
        display = formatMoneyDisplay(value, { language });
      }
    }
  });

  it('regroups deletion or digit replacement of a selected range without accepting ambiguous pastes', () => {
    const edit = {
      previousDisplay: '1.500',
      previousSelection: { start: 2, end: 4 },
    };
    expect(sanitizeMoneyValue('1.0', edit)).toBe('10');
    expect(sanitizeMoneyValue('1.230', edit)).toBe('1230');
    expect(
      sanitizeMoneyValue('1,0.25', {
        currency: 'USD',
        previousDisplay: '1,500.25',
        previousSelection: { start: 2, end: 4 },
      }),
    ).toBe('10.25');
    expect(
      sanitizeMoneyValue('1.5', {
        previousDisplay: '1.500',
        previousSelection: { start: 0, end: 5 },
      }),
    ).toBe('1.5');
    expect(
      sanitizeMoneyValue('30k', {
        previousDisplay: '1.500',
        previousSelection: { start: 0, end: 5 },
      }),
    ).toBe('30k');
  });
});
