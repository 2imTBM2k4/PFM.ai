import { usePreventRemove } from 'expo-router';
import { useSyncExternalStore } from 'react';
import {
  getBlockingGuard,
  promptDiscardChanges,
  subscribeUnsavedGuards,
  unregisterUnsavedGuard,
  type UnsavedGuardScope,
} from '@/utils/unsaved-changes';

/** Applies existing draft protection to system back gestures and sheet dismissal. */
export function NativeRouteGuard({
  scope = 'tab',
  routeKey,
}: {
  scope?: UnsavedGuardScope;
  routeKey?: string;
}) {
  const guard = useSyncExternalStore(
    subscribeUnsavedGuards,
    () => getBlockingGuard(scope, routeKey),
    () => undefined,
  );
  usePreventRemove(Boolean(guard), ({ repeat }) => {
    const current = getBlockingGuard(scope, routeKey);
    if (!current) {
      repeat();
      return;
    }
    if (current.saving) return;
    promptDiscardChanges(() => {
      unregisterUnsavedGuard(current.id);
      repeat();
    });
  });
  return null;
}
