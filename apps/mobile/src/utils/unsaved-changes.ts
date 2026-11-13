import { Alert, Platform } from 'react-native';
import { sanitizeMoneyValue } from '@/components/ui/money-input';
import type { EntryDraft } from '@/features/quick-entry/draft';
import { vi } from '@/messages/vi';

export type UnsavedGuardScope = 'tab' | 'modal';

export interface UnsavedGuardEntry {
  id: string;
  scope: UnsavedGuardScope;
  routeKey?: string;
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  onDiscard: () => void;
}

const activeGuards = new Map<string, UnsavedGuardEntry>();
const guardListeners = new Set<() => void>();

/** Subscribes native routes to changes in the existing draft guards. */
export function subscribeUnsavedGuards(listener: () => void) {
  guardListeners.add(listener);
  return () => {
    guardListeners.delete(listener);
  };
}

/** Finds the most recent blocking draft owned by a route or modal. */
export function getBlockingGuard(scope: UnsavedGuardScope, routeKey?: string) {
  return [...activeGuards.values()]
    .reverse()
    .find(
      (guard) =>
        guard.scope === scope &&
        (!routeKey || guard.routeKey === routeKey) &&
        (guard.saving || (guard.dirty && !guard.saved)),
    );
}

/** Normalize formatted money strings so equivalent edits like 50.000 and 50000 match. */
export function normalizeMoneyCompare(
  value: string,
  currency: 'VND' | 'USD' = 'VND',
): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return sanitizeMoneyValue(trimmed, { currency, allowNegative: true });
}

/** Compare current form field values against initial values, normalizing money fields. */
export function haveFieldsChanged<T extends object>(
  initial: T,
  current: T,
  options: {
    moneyKeys?: readonly (keyof T)[];
    currency?: 'VND' | 'USD';
    keys?: readonly (keyof T)[];
  } = {},
): boolean {
  const keys = options.keys ?? (Object.keys(initial) as (keyof T)[]);
  const moneySet = new Set<keyof T>(options.moneyKeys ?? []);
  const currency = options.currency ?? 'VND';

  for (const key of keys) {
    const initialValue = initial[key];
    const currentValue = current[key];
    if (moneySet.has(key)) {
      if (
        normalizeMoneyCompare(String(initialValue ?? ''), currency) !==
        normalizeMoneyCompare(String(currentValue ?? ''), currency)
      ) {
        return true;
      }
      continue;
    }
    if ((initialValue ?? '') !== (currentValue ?? '')) {
      return true;
    }
  }
  return false;
}

/** Check whether any quick-entry candidate draft differs from its initial parsed state. */
export function areEntryDraftsChanged(
  initial: readonly EntryDraft[],
  current: readonly EntryDraft[],
): boolean {
  if (initial.length !== current.length) return true;
  for (let index = 0; index < initial.length; index++) {
    const base = initial[index];
    const draft = current[index];
    if (!base || !draft) return true;
    if (
      base.selected !== draft.selected ||
      base.kind !== draft.kind ||
      normalizeMoneyCompare(base.amount, base.currency) !==
        normalizeMoneyCompare(draft.amount, draft.currency) ||
      base.currency !== draft.currency ||
      base.walletId !== draft.walletId ||
      base.toWalletId !== draft.toWalletId ||
      base.categoryId !== draft.categoryId ||
      base.debtId !== draft.debtId ||
      base.counterpartyLabel !== draft.counterpartyLabel ||
      base.date !== draft.date ||
      base.note !== draft.note
    ) {
      return true;
    }
  }
  return false;
}

/** Register or update an active form guard in insertion/update order. */
export function registerUnsavedGuard(entry: UnsavedGuardEntry): void {
  activeGuards.delete(entry.id);
  activeGuards.set(entry.id, entry);
  guardListeners.forEach((listener) => listener());
}

/** Remove a form guard when the form unmounts or closes. */
export function unregisterUnsavedGuard(id: string): void {
  activeGuards.delete(id);
  guardListeners.forEach((listener) => listener());
}

/** Clear all registered guards (intended for test isolation). */
export function resetUnsavedGuards(): void {
  activeGuards.clear();
  guardListeners.forEach((listener) => listener());
}

/** Return true if any currently mounted form is mid-save. */
export function isAnyGuardSaving(): boolean {
  for (const entry of activeGuards.values()) {
    if (entry.saving) return true;
  }
  return false;
}

/** Present the localized discard-changes confirmation dialog for native and web. */
export function promptDiscardChanges(onConfirm: () => void): void {
  if (Platform.OS === 'web') {
    const confirmed =
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(
            `${vi.unsavedChangesTitle}\n\n${vi.unsavedChangesMessage}`,
          )
        : true;
    if (confirmed) onConfirm();
    return;
  }
  Alert.alert(vi.unsavedChangesTitle, vi.unsavedChangesMessage, [
    { text: vi.unsavedStay, style: 'cancel' },
    {
      text: vi.unsavedDiscard,
      style: 'destructive',
      onPress: onConfirm,
    },
  ]);
}

/** Evaluate whether a guarded form can leave immediately, must block, or must prompt. */
export function resolveGuardLeave(
  guard: Pick<UnsavedGuardEntry, 'dirty' | 'saving' | 'saved' | 'onDiscard'>,
  afterDiscard?: () => void,
): boolean {
  if (guard.saving) return false;
  if (!guard.dirty || guard.saved) {
    guard.onDiscard();
    afterDiscard?.();
    return true;
  }
  promptDiscardChanges(() => {
    guard.onDiscard();
    afterDiscard?.();
  });
  return false;
}

/** Ask a specific registered form guard to handle leaving, falling back if not mounted. */
export function requestGuardLeave(
  id: string,
  fallbackLeave: () => void,
): boolean {
  const guard = activeGuards.get(id);
  if (!guard) {
    fallbackLeave();
    return true;
  }
  return resolveGuardLeave(guard);
}

/** Check whether the active tab can be left without losing dirty form edits. */
export function requestTabSwitch(
  activeRouteKey: string,
  proceed: () => void,
): boolean {
  const entries = [...activeGuards.values()].reverse();
  const match = entries.find(
    (entry) =>
      entry.scope === 'tab' &&
      (!entry.routeKey || entry.routeKey === activeRouteKey),
  );
  if (!match) {
    proceed();
    return true;
  }
  if (match.saving) return false;
  if (!match.dirty || match.saved) {
    proceed();
    return true;
  }
  promptDiscardChanges(() => {
    match.onDiscard();
    proceed();
  });
  return false;
}
