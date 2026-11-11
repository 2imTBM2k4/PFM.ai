import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import {
  registerUnsavedGuard,
  resolveGuardLeave,
  unregisterUnsavedGuard,
  type UnsavedGuardScope,
} from '@/utils/unsaved-changes';

export interface UseUnsavedChangesGuardOptions {
  id: string;
  scope?: UnsavedGuardScope;
  routeKey?: string;
  dirty: boolean;
  saving: boolean;
  hasError?: boolean;
  changeSignature?: string;
  onDiscard: () => void;
}

/**
 * Registers an active form guard for dirty-leave prompts across back buttons,
 * hardware back, modal dismissal, tab switches, and web page unloads.
 */
export function useUnsavedChangesGuard({
  id,
  scope = 'tab',
  routeKey,
  dirty,
  saving,
  hasError = false,
  changeSignature,
  onDiscard,
}: UseUnsavedChangesGuardOptions) {
  const [savedSignature, setSavedSignature] = useState<string | null>(null);

  const effectiveSaved =
    savedSignature !== null &&
    !hasError &&
    dirty &&
    (changeSignature === undefined || savedSignature === changeSignature);

  useEffect(() => {
    registerUnsavedGuard({
      id,
      scope,
      routeKey,
      dirty,
      saving,
      saved: effectiveSaved,
      onDiscard,
    });
    return () => {
      unregisterUnsavedGuard(id);
    };
  }, [id, scope, routeKey, dirty, saving, effectiveSaved, onDiscard]);

  useEffect(() => {
    if (
      Platform.OS !== 'web' ||
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function'
    ) {
      return;
    }
    if (!dirty || saving || effectiveSaved) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [dirty, saving, effectiveSaved]);

  const requestLeave = useCallback(() => {
    resolveGuardLeave({ dirty, saving, saved: effectiveSaved, onDiscard });
  }, [dirty, saving, effectiveSaved, onDiscard]);

  const runGuardedSave = useCallback(
    async (action: () => Promise<boolean | void>) => {
      setSavedSignature(null);
      const outcome = await action();
      if (outcome !== false) {
        setSavedSignature(changeSignature ?? '__saved__');
      }
      return outcome;
    },
    [changeSignature],
  );

  const resetSaved = useCallback(() => {
    setSavedSignature(null);
  }, []);

  return {
    saved: effectiveSaved,
    requestLeave,
    runGuardedSave,
    resetSaved,
  };
}
