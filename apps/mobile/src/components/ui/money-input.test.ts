import { describe, expect, it, vi } from 'vitest';
import {
  computeMoneyCaretOffset,
  countSignificantMoneyChars,
  formatMoneyDisplay,
  sanitizeMoneyValue,
} from './money-input';

vi.mock('react-native-paper', () => ({
  TextInput: 'TextInput',
}));

vi.mock('@/state/preferences', () => ({
  usePreferences: () => 'vi',
}));

describe('MoneyInput pure helpers', () => {
  it('sanitizes pasted strings with dots, commas, spaces, letters, and leading zeros', () => {
    expect(sanitizeMoneyValue('1.500.000')).toBe('1500000');
    expect(sanitizeMoneyValue('1,500,000')).toBe('1500000');
    expect(sanitizeMoneyValue(' 30 000 ')).toBe('30000');
    expect(sanitizeMoneyValue('abc12xyz')).toBe('12');
    expect(sanitizeMoneyValue('0001500')).toBe('1500');
    expect(sanitizeMoneyValue('000')).toBe('0');
    expect(sanitizeMoneyValue('')).toBe('');
    expect(sanitizeMoneyValue('abc')).toBe('');
  });

  it('clamps values exceeding MAX_AMOUNT_VND (100,000,000,000)', () => {
    expect(sanitizeMoneyValue('100000000000')).toBe('100000000000');
    expect(sanitizeMoneyValue('100000000001')).toBe('100000000000');
    expect(sanitizeMoneyValue('999.999.999.999.999')).toBe('100000000000');
  });

  it('supports negative initial balances when allowNegative is enabled', () => {
    expect(sanitizeMoneyValue('-2.000.000', { allowNegative: true })).toBe(
      '-2000000',
    );
    expect(sanitizeMoneyValue('-', { allowNegative: true })).toBe('-');
    expect(sanitizeMoneyValue('-2000000', { allowNegative: false })).toBe(
      '2000000',
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
    expect(sanitizeMoneyValue('10.999', { currency: 'USD' })).toBe('10.99');
    expect(sanitizeMoneyValue('10.', { currency: 'USD' })).toBe('10.');
    expect(formatMoneyDisplay('1500.25', { currency: 'USD' })).toBe('1,500.25');
    expect(formatMoneyDisplay('1500.', { currency: 'USD' })).toBe('1,500.');
  });

  it('computes stable caret position when inserting or deleting in the middle of a number', () => {
    // User had "1.500.000", placed cursor after '5' (index 3) and typed '2' -> rawText = "1.5200.000", cursor at 4
    const rawEdited = '1.5200.000';
    const sigBefore = countSignificantMoneyChars(rawEdited, 4);
    expect(sigBefore).toBe(3); // '1', '5', '2'
    const nextDisplay = formatMoneyDisplay(sanitizeMoneyValue(rawEdited), {
      language: 'vi',
    });
    expect(nextDisplay).toBe('15.200.000');
    const nextCaret = computeMoneyCaretOffset(nextDisplay, sigBefore);
    // In "15.200.000", index 4 is right after '2' ("15.2|00.000")
    expect(nextDisplay.slice(0, nextCaret)).toBe('15.2');
  });
});
