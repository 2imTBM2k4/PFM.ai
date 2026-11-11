import { MAX_AMOUNT_VND } from '@pfm/domain';
import { useRef, useState } from 'react';
import { HelperText, TextInput, type TextInputProps } from 'react-native-paper';
import { View } from 'react-native';
import { vi } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';

export interface MoneyFormatOptions {
  currency?: 'VND' | 'USD';
  language?: 'vi' | 'en';
  allowNegative?: boolean;
  maxAmount?: number;
  previousDisplay?: string;
  previousSelection?: { start: number; end: number };
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

/** Accept complete grouping, except while editing an already formatted number. */
function canonicalMoneyValue(
  input: string,
  options: MoneyFormatOptions,
): string | null {
  const { currency = 'VND', previousDisplay = '' } = options;
  let working = input.trim();
  if (!working || working === '-') return working;
  const previous = previousDisplay.trim();
  const previousCanonical =
    previous && canonicalMoneyValue(previous, { currency });
  const selection = options.previousSelection;
  let replacedSelection = false;
  if (previousCanonical && selection && selection.end > selection.start) {
    const prefix = previous.slice(0, selection.start);
    const suffix = previous.slice(selection.end);
    const insertedEnd = working.length - suffix.length;
    if (
      insertedEnd >= prefix.length &&
      working.startsWith(prefix) &&
      working.endsWith(suffix) &&
      /^[0-9]*$/.test(working.slice(prefix.length, insertedEnd))
    ) {
      working =
        currency === 'USD'
          ? working.replace(/,/g, '')
          : working.replace(/[., ]/g, '');
      replacedSelection = true;
    }
  }
  if (
    !replacedSelection &&
    previousCanonical &&
    /[., ]/.test(previous) &&
    Math.abs(working.length - previous.length) === 1
  ) {
    const inserting = working.length > previous.length;
    const longer = inserting ? working : previous;
    const shorter = inserting ? previous : working;
    const index = [...longer].findIndex(
      (char, i) =>
        (inserting
          ? isDigit(char)
          : isDigit(char) ||
            (currency === 'USD' ? char === ',' : /[., ]/.test(char))) &&
        longer.slice(0, i) + longer.slice(i + 1) === shorter,
    );
    if (index >= 0) {
      // Backspacing a grouping separator removes the preceding digit, as before.
      if (!inserting && !isDigit(longer[index]) && index > 0) {
        working = working.slice(0, index - 1) + working.slice(index);
      }
      working =
        currency === 'USD'
          ? working.replace(/,/g, '')
          : working.replace(/[., ]/g, '');
    }
  }
  const negative = working.startsWith('-');
  const unsigned = negative ? working.slice(1) : working;
  const pattern =
    currency === 'USD'
      ? /^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)?(?:\.[0-9]{0,2})?$/
      : /^(?:[0-9]+|[0-9]{1,3}([., ])[0-9]{3}(?:\1[0-9]{3})*)$/;
  if (!pattern.test(unsigned) || !/[0-9]/.test(unsigned)) return null;
  const ungrouped =
    currency === 'USD'
      ? unsigned.replace(/,/g, '')
      : unsigned.replace(/[., ]/g, '');
  const normalized = ungrouped.replace(/^0+(?=\d)/, '');
  return (
    (negative ? '-' : '') + (normalized.startsWith('.') ? '0' : '') + normalized
  );
}

/** Normalize valid input; retain invalid text and oversized values for correction. */
export function sanitizeMoneyValue(
  input: string,
  options: MoneyFormatOptions = {},
): string {
  return canonicalMoneyValue(input, options) ?? input;
}

/** Report syntax and magnitude errors without silently changing the user's amount. */
export function moneyInputError(
  value: string,
  options: MoneyFormatOptions = {},
): 'format' | 'negative' | 'limit' | null {
  const canonical = canonicalMoneyValue(value, { currency: options.currency });
  if (canonical === '') return null;
  if (canonical === null || canonical === '-') return 'format';
  if (canonical.startsWith('-') && !options.allowNegative) return 'negative';
  const unsigned = canonical.replace(/^-/, '');
  const [integer, fraction = ''] = unsigned.split('.');
  const magnitude =
    options.currency === 'USD'
      ? BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'))
      : BigInt(integer);
  return magnitude > BigInt(options.maxAmount ?? MAX_AMOUNT_VND)
    ? 'limit'
    : null;
}

/** Format valid numbers while keeping invalid text visible and unchanged. */
export function formatMoneyDisplay(
  value: string,
  options: MoneyFormatOptions = {},
): string {
  const { currency = 'VND', language = 'vi' } = options;
  const canonical = canonicalMoneyValue(value, { currency });
  if (canonical === null) return value;
  if (!canonical || canonical === '-') return canonical;
  const negative = canonical.startsWith('-');
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [integer, fraction] = unsigned.split('.');
  const separator = currency === 'USD' || language === 'en' ? ',' : '.';
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return (
    (negative ? '-' : '') +
    grouped +
    (fraction === undefined ? '' : '.' + fraction)
  );
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

export interface MoneyInputProps extends Omit<
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
 * while retaining invalid input in form state so saving cannot use an older amount.
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
  const inputError = moneyInputError(value, {
    currency,
    allowNegative,
    maxAmount,
  });
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
      previousSelection: rawSelectionRef.current,
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
      allowNegative: true,
    });
    const nextCaret =
      canonicalMoneyValue(nextCanonical, { currency }) === null
        ? estimatedRawCursor
        : computeMoneyCaretOffset(nextDisplay, sigCount, {
            currency,
            allowNegative: true,
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
    <View>
      <TextInput
        mode="outlined"
        {...rest}
        error={!!inputError || rest.error}
        value={displayValue}
        selection={selection}
        onChangeText={handleChangeText}
        onSelectionChange={handleSelectionChange}
        keyboardType={keyboardType}
      />
      {!!inputError && (
        <HelperText type="error" accessibilityRole="alert">
          {inputError === 'negative'
            ? vi.moneyInputNegative
            : inputError === 'limit'
              ? vi.moneyInputLimit
                  .replace(
                    '{limit}',
                    formatMoneyDisplay(
                      currency === 'USD'
                        ? (maxAmount / 100).toFixed(2)
                        : String(maxAmount),
                      { currency, language },
                    ),
                  )
                  .replace('{currency}', currency)
              : currency === 'USD'
                ? vi.moneyInputFormatUsd
                : vi.moneyInputFormatVnd}
        </HelperText>
      )}
    </View>
  );
}
