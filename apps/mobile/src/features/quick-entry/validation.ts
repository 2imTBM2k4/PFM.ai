import { convertMoney, type ParseResult } from '@pfm/domain';
import type { FieldError } from 'react-hook-form';
import { vi } from '@/messages/vi';
import { amountError, dateError } from '@/utils/form-validation';
import { parseAmountInput } from '../transactions/form';
import type { EntryDraft, EntryReferences } from './draft';

/** Collect errors for selected rows, accounting for combined repayments in a batch. */
export function quickEntryErrors(
  result: ParseResult,
  drafts: EntryDraft[],
  refs: EntryReferences,
  rate: number | null,
): Partial<Record<keyof EntryDraft, FieldError>>[] {
  const remaining = new Map(
    refs.debts.map((debt) => [debt.id, debt.outstanding]),
  );
  return drafts.map((draft, index) => {
    const errors: Partial<Record<keyof EntryDraft, FieldError>> = {};
    if (!draft.selected) return errors;
    const add = (name: keyof EntryDraft, message: string) => {
      errors[name] = { type: 'validate', message };
    };
    if (draft.kind === 'unknown') add('kind', vi.quickKindRequired);
    const money = amountError(draft.amount, { currency: draft.currency });
    if (money !== true) add('amount', money);
    if (
      draft.currency === 'USD' &&
      (!rate || !Number.isFinite(rate) || rate <= 0)
    )
      add('currency', vi.aiExchangeRateUnavailable);
    if (
      result.candidates[index]?.explanation.includes(
        'amount.assumed_thousands',
      ) &&
      !draft.amountConfirmed
    )
      add('amountConfirmed', vi.quickAmountRequired);
    if (!refs.wallets.some((w) => w.id === draft.walletId && !w.is_archived))
      add('walletId', vi.transactionWalletRequired);
    if (
      draft.kind === 'transfer' &&
      (draft.toWalletId === draft.walletId ||
        !refs.wallets.some((w) => w.id === draft.toWalletId && !w.is_archived))
    )
      add('toWalletId', vi.formDestinationInvalid);
    if (
      (draft.kind === 'income' || draft.kind === 'expense') &&
      draft.categoryId &&
      !refs.categories.some(
        (c) =>
          c.id === draft.categoryId &&
          c.kind === draft.kind &&
          !c.is_archived &&
          (!c.parent_id ||
            refs.categories.some(
              (parent) => parent.id === c.parent_id && !parent.is_archived,
            )),
      )
    )
      add('categoryId', vi.transactionReferencesInvalid);
    if (dateError(draft.date) !== true) add('date', vi.transactionDateInvalid);
    if (
      (draft.kind === 'debt_borrow' || draft.kind === 'debt_lend') &&
      !draft.counterpartyLabel.trim()
    )
      add('counterpartyLabel', vi.quickCounterpartyRequired);
    if (
      draft.kind === 'debt_repay_paid' ||
      draft.kind === 'debt_repay_received'
    ) {
      const debt = refs.debts.find(
        (d) =>
          d.id === draft.debtId &&
          d.outstanding > 0 &&
          d.direction ===
            (draft.kind === 'debt_repay_paid' ? 'borrowed' : 'lent'),
      );
      if (!debt) add('debtId', vi.quickDebtRequired);
      else if (money === true && !errors.currency) {
        try {
          const amount = parseAmountInput(draft.amount, draft.currency);
          const vnd =
            draft.currency === 'USD'
              ? convertMoney(amount, 'USD', 'VND', rate)
              : amount;
          const balance = remaining.get(debt.id)!;
          if (vnd > balance) add('amount', vi.formRepaymentTooLarge);
          else remaining.set(debt.id, balance - vnd);
        } catch {
          add('amount', vi.transactionAmountInvalid);
        }
      }
    }
    return errors;
  });
}
