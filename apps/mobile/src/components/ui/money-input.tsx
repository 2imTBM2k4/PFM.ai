import { MAX_AMOUNT_VND } from '@pfm/domain';
import { useRef, useState } from 'react';
import { TextInput, type TextInputProps } from 'react-native-paper';
import { usePreferences } from '@/state/preferences';

export interface MoneyFormatOptions {
  currency?: 'VND' | 'USD';
  language?: 'vi' | 'en';
  allowNegative?: boolean;
  maxAmount?: number;
  previousDisplay?: string;
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

/**
 * Normalizes arbitrary user input or pasted text into a canonical numeric string
 * suitable for form state (`"1500000"`, `"-2000000"`, or `"1500.25"` for USD).
 */
export function sanitizeMoneyValue(
  input: string,
  options: MoneyFormatOptions = {},
): string {
  const {
    currency = 'VND',
    allowNegative = false,
    maxAmount = MAX_AMOUNT_VND,
    previousDisplay = '',
  } = options;

  if (!input) return '';

  let working = input;

  // If the user pressed Backspace on a thousands separator, remove the digit before it.
  if (
    previousDisplay &&
    input.length === previousDisplay.length - 1 &&
    currency === 'VND'
  ) {
    let diffIndex = -1;
    for (let i = 0; i < previousDisplay.length; i++) {
      if (
        previousDisplay.slice(0, i) + previousDisplay.slice(i + 1) ===
        input
      ) {
        diffIndex = i;
        break;
      }
    }
    const removedChar = diffIndex >= 0 ? previousDisplay[diffIndex] : '';
    if ((removedChar === '.' || removedChar === ',') && diffIndex > 0) {
      working = input.slice(0, diffIndex - 1) + input.slice(diffIndex);
    }
  }

  const trimmed = working.trim();
  const isNegative = allowNegative && trimmed.startsWith('-');

  if (currency === 'USD') {
    // Strip thousands commas and non-numeric characters while keeping at most one decimal dot.
    const cleaned = trimmed.replace(/,/g, '').replace(/[^0-9.]/g, '');
    if (!cleaned) return isNegative ? '-' : '';

    const dotIndex = cleaned.indexOf('.');
    const hasDot = dotIndex !== -1;
    const rawInt = (hasDot ? cleaned.slice(0, dotIndex) : cleaned).replace(
      /^0+(?=\d)/,
      '',
    );
    const intPart = rawInt === '' ? (hasDot ? '0' : '') : rawInt;
    const decPart = hasDot
      ? cleaned
          .slice(dotIndex + 1)
          .replace(/\./g, '')
          .slice(0, 2)
      : '';

    if (!intPart && !hasDot) return isNegative ? '-' : '';

    const candidate = hasDot ? `${intPart}.${decPart}` : intPart;
    const minor = Math.round(Number(candidate) * 100);
    if (Number.isFinite(minor) && minor > maxAmount) {
      const maxDollars = Math.floor(maxAmount / 100);
      return `${isNegative ? '-' : ''}${maxDollars}`;
    }
    return `${isNegative ? '-' : ''}${candidate}`;
  }

  const digits = trimmed.replace(/[^0-9]/g, '');
  if (!digits) {
    return isNegative ? '-' : '';
  }

  const normalizedDigits = digits.replace(/^0+(?=\d)/, '');
  const numeric = BigInt(normalizedDigits);
  const clamped =
    numeric > BigInt(maxAmount) ? String(maxAmount) : normalizedDigits;

  if (clamped === '0' && isNegative) {
    return '-0';
  }
  return `${isNegative ? '-' : ''}${clamped}`;
}

/**
 * Formats a canonical or raw money string with thousands separators for display.
 * VND uses `.` in Vietnamese and `,` in English; USD uses `,` for the integer part
 * and preserves `.` for cents.
 */
export function formatMoneyDisplay(
  value: string,
  options: MoneyFormatOptions = {},
): string {
  const {
    currency = 'VND',
    language = 'vi',
    allowNegative = false,
    maxAmount = MAX_AMOUNT_VND,
  } = options;

  const canonical = sanitizeMoneyValue(value, {
    currency,
    allowNegative,
    maxAmount,
  });
  if (!canonical || canonical === '-') return canonical;

  const isNegative = canonical.startsWith('-');
  const unsigned = isNegative ? canonical.slice(1) : canonical;

  if (currency === 'USD') {
    const dotIndex = unsigned.indexOf('.');
    const hasDot = dotIndex !== -1;
    const intPart = hasDot ? unsigned.slice(0, dotIndex) : unsigned;
    const decPart = hasDot ? unsigned.slice(dotIndex + 1) : '';
    const groupedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${isNegative ? '-' : ''}${hasDot ? `${groupedInt}.${decPart}` : groupedInt}`;
  }

  const separator = language === 'en' ? ',' : '.';
  const grouped = unsigned.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return `${isNegative ? '-' : ''}${grouped}`;
}

/**
 * Counts how many significant characters (digits, minus sign, or USD decimal dot)
 * appear before `cursorOffset` in `rawEditedText`.
 */
export function countSignificantMoneyChars(
  rawEditedText: string,
  cursorOffset: number,
  options: { currency?: 'VND' | 'USD'; allowNegative?: boolean } = {},
): number {
  const { currency = 'VND', allowNegative = false } = options;
  const slice = rawEditedText.slice(
    0,
    Math.max(0, Math.min(cursorOffset, rawEditedText.length)),
  );
  let count = 0;
  let seenDot = false;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    if (isDigit(ch)) {
      count++;
    } else if (allowNegative && i === 0 && ch === '-') {
      count++;
    } else if (currency === 'USD' && ch === '.' && !seenDot) {
      seenDot = true;
      count++;
    }
  }
  return count;
}

/**
 * Maps a significant character count back to the corresponding caret index in `formattedDisplay`.
 */
export function computeMoneyCaretOffset(
  formattedDisplay: string,
  significantCount: number,
  options: { currency?: 'VND' | 'USD'; allowNegative?: boolean } = {},
): number {
  if (significantCount <= 0 || !formattedDisplay) return 0;
  const { currency = 'VND', allowNegative = false } = options;
  let seen = 0;
  let seenDot = false;
  for (let i = 0; i < formattedDisplay.length; i++) {
    const ch = formattedDisplay[i];
    const isSig =
      isDigit(ch) ||
      (allowNegative && i === 0 && ch === '-') ||
      (currency === 'USD' && ch === '.' && !seenDot);
    if (currency === 'USD' && ch === '.') {
      seenDot = true;
    }
    if (isSig) {
      seen++;
      if (seen === significantCount) {
        return i + 1;
      }
    }
  }
  return formattedDisplay.length;
}

export interface MoneyInputProps
  extends Omit<
    TextInputProps,
    'value' | 'onChangeText' | 'keyboardType' | 'selection'
  > {
  value: string;
  onChangeText(nextCanonicalValue: string): void;
  currency?: 'VND' | 'USD';
  allowNegative?: boolean;
  maxAmount?: number;
}

/**
 * Shared money input component that displays locale-aware thousands separators
 * while keeping the form state as a clean canonical numeric string.
 */
export function MoneyInput({
  value,
  onChangeText,
  currency = 'VND',
  allowNegative = false,
  maxAmount = MAX_AMOUNT_VND,
  ...rest
}: MoneyInputProps) {
  const language = usePreferences((state) => state.language);
  const displayValue = formatMoneyDisplay(value, {
    currency,
    language,
    allowNegative,
    maxAmount,
  });

  const [selection, setSelection] = useState<
    { start: number; end: number } | undefined
  >(undefined);
  const rawSelectionRef = useRef<{ start: number; end: number }>({
    start: displayValue.length,
    end: displayValue.length,
  });
  const pendingCaretRef = useRef<number | null>(null);

  const handleChangeText = (rawText: string) => {
    const nextCanonical = sanitizeMoneyValue(rawText, {
      currency,
      allowNegative,
      maxAmount,
      previousDisplay: displayValue,
    });
    const nextDisplay = formatMoneyDisplay(nextCanonical, {
      currency,
      language,
      allowNegative,
      maxAmount,
    });

    const lengthDelta = rawText.length - displayValue.length;
    const estimatedRawCursor = Math.max(
      0,
      Math.min(rawText.length, rawSelectionRef.current.end + lengthDelta),
    );
    const sigCount = countSignificantMoneyChars(rawText, estimatedRawCursor, {
      currency,
      allowNegative,
    });
    const nextCaret = computeMoneyCaretOffset(nextDisplay, sigCount, {
      currency,
      allowNegative,
    });

    pendingCaretRef.current = nextCaret;
    setSelection({ start: nextCaret, end: nextCaret });
    rawSelectionRef.current = { start: nextCaret, end: nextCaret };
    onChangeText(nextCanonical);
  };

  const handleSelectionChange: NonNullable<
    TextInputProps['onSelectionChange']
  > = (event) => {
    const sel = event.nativeEvent.selection;
    if (pendingCaretRef.current !== null) {
      const target = pendingCaretRef.current;
      pendingCaretRef.current = null;
      rawSelectionRef.current = { start: target, end: target };
      setSelection(undefined);
      return;
    }
    rawSelectionRef.current = sel;
    if (selection !== undefined) {
      setSelection(undefined);
    }
  };

  const keyboardType = allowNegative
    ? 'numbers-and-punctuation'
    : currency === 'USD'
      ? 'decimal-pad'
      : 'number-pad';

  return (
    <TextInput
      mode="outlined"
      {...rest}
      value={displayValue}
      selection={selection}
      onChangeText={handleChangeText}
      onSelectionChange={handleSelectionChange}
      keyboardType={keyboardType}
    />
  );
}
