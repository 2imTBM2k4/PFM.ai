import { validateDate } from '@pfm/domain';
import { parseAmountInput } from '@/features/transactions/form';
import { vi } from '@/messages/vi';

/** Validate money without converting invalid input into a different amount. */
export function amountError(
  value: string,
  options: {
    zero?: boolean;
    optional?: boolean;
    currency?: 'VND' | 'USD';
  } = {},
): true | string {
  if (options.optional && value === '') return true;
  if (options.zero && value === '0') return true;
  try {
    parseAmountInput(value, options.currency);
    return true;
  } catch {
    return options.zero
      ? vi.formNonnegativeAmount
      : vi.transactionAmountInvalid;
  }
}

/** Validate a calendar date while preserving optional empty values. */
export function dateError(value: string, optional = false): true | string {
  if (optional && !value) return true;
  try {
    validateDate(value);
    return true;
  } catch {
    return vi.transactionDateInvalid;
  }
}

/** Validate the end independently before comparing a valid start date. */
export function endDateError(
  value: string,
  start: string,
  optional = false,
): true | string {
  const valid = dateError(value, optional);
  if (valid !== true || !value) return valid;
  return dateError(start) === true && value < start
    ? vi.formEndBeforeStart
    : true;
}

/** Validate a complete calendar month. */
export function monthError(value: string, optional = false): true | string {
  if (optional && !value) return true;
  return /^\d{4}-\d{2}$/.test(value) && dateError(`${value}-01`) === true
    ? true
    : vi.formMonthInvalid;
}

/** Validate whole percentage thresholds used by budget alerts. */
export function percentError(value: string): true | string {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100
    ? true
    : vi.formPercentInvalid;
}

/** Prevent overpayment while allowing partial and full debt repayment. */
export function repaymentError(
  value: string,
  outstanding?: number,
): true | string {
  const valid = amountError(value);
  if (valid !== true) return valid;
  return outstanding !== undefined && parseAmountInput(value) > outstanding
    ? vi.formRepaymentTooLarge
    : true;
}

/** Validate an optional upper amount bound after validating each endpoint. */
export function amountRangeError(
  value: string,
  minimum: string,
): true | string {
  const valid = amountError(value, { zero: true, optional: true });
  if (
    valid !== true ||
    !value ||
    !minimum ||
    amountError(minimum, { zero: true }) !== true
  )
    return valid;
  return Number(value.replace(/\./g, '')) < Number(minimum.replace(/\./g, ''))
    ? vi.formAmountRangeInvalid
    : true;
}
