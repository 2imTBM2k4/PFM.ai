import { Alert, Platform } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveLanguage } from '@/messages/language';
import { vi as messages } from '@/messages/vi';
import type { EntryDraft } from '@/features/quick-entry/draft';
import {
  areEntryDraftsChanged,
  haveFieldsChanged,
  isAnyGuardSaving,
  normalizeMoneyCompare,
  registerUnsavedGuard,
  requestGuardLeave,
  requestTabSwitch,
  resetUnsavedGuards,
  resolveGuardLeave,
  unregisterUnsavedGuard,
  getBlockingGuard,
  subscribeUnsavedGuards,
} from './unsaved-changes';

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios' },
  View: 'View',
}));

vi.mock('react-native-paper', () => ({
  TextInput: 'TextInput',
  HelperText: 'HelperText',
}));

vi.mock('@/state/preferences', () => ({
  usePreferences: () => 'vi',
}));

function makeDraft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return {
    transactionId: 'tx-1',
    newDebtId: 'debt-1',
    selected: true,
    amountConfirmed: true,
    kind: 'expense',
    amount: '30.000',
    currency: 'VND',
    walletId: 'wallet-1',
    toWalletId: '',
    categoryId: 'cat-1',
    debtId: '',
    counterpartyLabel: '',
    date: '2026-11-11',
    note: '?n s?ng',
    ...overrides,
  };
}

describe('unsaved changes helpers', () => {
  it('keeps a transaction draft in its tab protected after a separate modal draft closes', () => {
    const tab = {
      id: 'transaction-form',
      scope: 'tab' as const,
      routeKey: 'transactions',
      dirty: true,
      saving: false,
      saved: false,
      onDiscard: vi.fn(),
    };
    registerUnsavedGuard(tab);
    registerUnsavedGuard({
      ...tab,
      id: 'transaction-form-modal',
      scope: 'modal',
      routeKey: undefined,
    });
    expect(getBlockingGuard('modal')?.id).toBe('transaction-form-modal');
    unregisterUnsavedGuard('transaction-form-modal');
    expect(getBlockingGuard('modal')).toBeUndefined();
    expect(getBlockingGuard('tab', 'transactions')).toBe(tab);
  });
  it('notifies native navigation when a matching draft becomes dirty, saves, or unmounts', () => {
    resetUnsavedGuards();
    const changed = vi.fn();
    const unsubscribe = subscribeUnsavedGuards(changed);
    const guard = {
      id: 'native-form',
      scope: 'modal' as const,
      dirty: true,
      saving: false,
      saved: false,
      onDiscard: vi.fn(),
    };
    registerUnsavedGuard(guard);
    expect(getBlockingGuard('modal')).toBe(guard);
    expect(getBlockingGuard('tab', 'settings')).toBeUndefined();
    registerUnsavedGuard({ ...guard, saving: true, dirty: false });
    expect(getBlockingGuard('modal')?.saving).toBe(true);
    registerUnsavedGuard({ ...guard, saved: true });
    expect(getBlockingGuard('modal')).toBeUndefined();
    unregisterUnsavedGuard(guard.id);
    expect(changed).toHaveBeenCalledTimes(4);
    unsubscribe();
    registerUnsavedGuard(guard);
    expect(changed).toHaveBeenCalledTimes(4);
  });
  beforeEach(() => {
    resetUnsavedGuards();
    setActiveLanguage('vi');
    vi.restoreAllMocks();
    (Platform as { OS: string }).OS = 'ios';
  });

  it('normalizes formatted money strings so reverting an edit is not dirty', () => {
    const initial = { amount: '50.000', note: 'C? ph?', walletId: 'w1' };
    expect(
      haveFieldsChanged(
        initial,
        { amount: '50000', note: 'C? ph?', walletId: 'w1' },
        {
          moneyKeys: ['amount'],
        },
      ),
    ).toBe(false);

    expect(
      haveFieldsChanged(
        initial,
        { amount: '60000', note: 'C? ph?', walletId: 'w1' },
        {
          moneyKeys: ['amount'],
        },
      ),
    ).toBe(true);

    expect(normalizeMoneyCompare('1,250.50', 'USD')).toBe('1250.50');
    expect(normalizeMoneyCompare('1250.50', 'USD')).toBe('1250.50');
    expect(normalizeMoneyCompare('30k', 'VND')).toBe('30k');
  });

  it('compares quick-entry candidate drafts accurately', () => {
    const base = [makeDraft()];
    expect(areEntryDraftsChanged(base, [makeDraft({ amount: '30000' })])).toBe(
      false,
    );
    expect(areEntryDraftsChanged(base, [makeDraft({ selected: false })])).toBe(
      true,
    );
    expect(areEntryDraftsChanged(base, [makeDraft({ note: '?n tr?a' })])).toBe(
      true,
    );
  });

  it('distinguishes clean, dirty, saving, and saved states when leaving', () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    const onDiscard = vi.fn();

    // Clean: leaves immediately
    expect(
      resolveGuardLeave({
        dirty: false,
        saving: false,
        saved: false,
        onDiscard,
      }),
    ).toBe(true);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();

    // Saving: blocks leaving
    expect(
      resolveGuardLeave({ dirty: true, saving: true, saved: false, onDiscard }),
    ).toBe(false);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();

    // Saved: leaves immediately without prompting again
    expect(
      resolveGuardLeave({ dirty: true, saving: false, saved: true, onDiscard }),
    ).toBe(true);
    expect(onDiscard).toHaveBeenCalledTimes(2);
    expect(alertSpy).not.toHaveBeenCalled();

    // Dirty: prompts and discards only when user chooses discard
    expect(
      resolveGuardLeave({
        dirty: true,
        saving: false,
        saved: false,
        onDiscard,
      }),
    ).toBe(false);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const buttons = alertSpy.mock.calls[0]![2] as {
      text?: string;
      style?: string;
      onPress?: () => void;
    }[];
    expect(buttons[0]?.text).toBe(messages.unsavedStay);
    expect(buttons[1]?.text).toBe(messages.unsavedDiscard);
    buttons[0]?.onPress?.();
    expect(onDiscard).toHaveBeenCalledTimes(2);
    buttons[1]?.onPress?.();
    expect(onDiscard).toHaveBeenCalledTimes(3);
  });

  it('routes hardware back and tab switches through active form guards', () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    const onDiscard = vi.fn();
    const fallback = vi.fn();
    const proceedTab = vi.fn();

    registerUnsavedGuard({
      id: 'budget-form',
      scope: 'tab',
      routeKey: 'budgets',
      dirty: true,
      saving: false,
      saved: false,
      onDiscard,
    });

    // Different tab route is unaffected
    expect(requestTabSwitch('transactions', proceedTab)).toBe(true);
    expect(proceedTab).toHaveBeenCalledTimes(1);

    // Active dirty tab prompts before switching and discards on confirm
    expect(requestTabSwitch('budgets', proceedTab)).toBe(false);
    expect(proceedTab).toHaveBeenCalledTimes(1);
    const buttons = alertSpy.mock.calls[0]![2] as { onPress?: () => void }[];
    buttons[1]?.onPress?.();
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(proceedTab).toHaveBeenCalledTimes(2);

    // Hardware back through requestGuardLeave checks the registered guard
    expect(requestGuardLeave('budget-form', fallback)).toBe(false);
    expect(fallback).not.toHaveBeenCalled();

    // Saving state blocks tab switch and reports isAnyGuardSaving
    registerUnsavedGuard({
      id: 'budget-form',
      scope: 'tab',
      routeKey: 'budgets',
      dirty: true,
      saving: true,
      saved: false,
      onDiscard,
    });
    expect(isAnyGuardSaving()).toBe(true);
    expect(requestTabSwitch('budgets', proceedTab)).toBe(false);
    expect(alertSpy).toHaveBeenCalledTimes(2);

    unregisterUnsavedGuard('budget-form');
    expect(isAnyGuardSaving()).toBe(false);
    expect(requestGuardLeave('budget-form', fallback)).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('uses localized window.confirm on web', () => {
    (Platform as { OS: string }).OS = 'web';
    setActiveLanguage('en');
    const confirmMock = vi.fn(() => false);
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      value: { confirm: confirmMock },
      configurable: true,
    });

    try {
      const onDiscard = vi.fn();
      expect(
        resolveGuardLeave({
          dirty: true,
          saving: false,
          saved: false,
          onDiscard,
        }),
      ).toBe(false);
      expect(confirmMock).toHaveBeenCalledWith(
        'Discard changes?\n\nYou have unsaved changes. If you leave now, your edits will be lost.',
      );
      expect(onDiscard).not.toHaveBeenCalled();

      confirmMock.mockReturnValueOnce(true);
      resolveGuardLeave({
        dirty: true,
        saving: false,
        saved: false,
        onDiscard,
      });
      expect(onDiscard).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
      });
    }
  });
});
