import { useStore } from 'zustand';
import { PinLock } from './service';
import { createLockSession } from './session';

let value: string | null = null;

export async function checkPinStorage() {
  // PIN protection is intentionally unavailable in the browser preview.
}

export const pinLock = new PinLock(
  {
    get: async () => value,
    set: async (next) => {
      value = next;
    },
    remove: async () => {
      value = null;
    },
    checkWritable: checkPinStorage,
  },
  async () => '0'.repeat(64),
  () => '0'.repeat(64),
  Date.now,
);

export const isPinDeferred = true;
export const lockSession = createLockSession(pinLock, Date.now, false);

export function useLockSession<T>(
  selector: (state: ReturnType<typeof lockSession.getState>) => T,
) {
  return useStore(lockSession, selector);
}
