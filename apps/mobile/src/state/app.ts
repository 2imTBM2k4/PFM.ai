import { create } from 'zustand';
import { uuid } from 'expo';
import { logAppEvent } from '@/services/logger';
import { withDatabase, deletePreviewData } from '@/data/connection';
import { pinLock, lockSession } from '@/features/lock/mobile';
import { resetPreferences } from './preferences';
import { clearBudgetNotifications } from '@/features/budgets/mobile';
import {
  runRecurring,
  clearRecurringNotifications,
} from '@/features/recurring/mobile';
import {
  finishOnboarding,
  listWallets,
  readOnboarding,
  type WalletRow,
} from '@/data/repository';

interface AppState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  startupError:
    | 'databaseError'
    | 'databaseKeyError'
    | 'databaseBuildError'
    | 'databaseRecoveryError';
  onboarded: boolean;
  deleteFailed: boolean;
  deleting: boolean;
  wallets: WalletRow[];
  recurringVersion: number;
  chatSessionId: string;
  refreshRecurring(recheck?: boolean): Promise<void>;
  initialize(): Promise<void>;
  completeOnboarding(balance: number): Promise<void>;
  refreshWallets(): Promise<void>;
  deleteData(): Promise<void>;
}

export const useApp = create<AppState>()((set, get) => ({
  status: 'idle',
  startupError: 'databaseError',
  onboarded: false,
  deleteFailed: false,
  deleting: false,
  wallets: [],
  recurringVersion: 0,
  chatSessionId: uuid.v4(),
  async refreshRecurring(recheck = false) {
    if (get().status !== 'ready' || !get().onboarded) return;
    try {
      const result = await runRecurring(recheck);
      if (get().status === 'ready')
        set((state) => ({
          wallets: result.wallets,
          recurringVersion:
            state.recurringVersion + (result.created > 0 ? 1 : 0),
        }));
    } catch {
      /* The recurring screen exposes the retry state. */
    }
  },
  async initialize() {
    if (get().status === 'loading') return;
    set({ status: 'loading', startupError: 'databaseError' });
    try {
      const { onboarded, wallets } = await withDatabase(async (db) => {
        const onboarded = await readOnboarding(db);
        return { onboarded, wallets: await listWallets(db) };
      });
      const latestWallets = onboarded
        ? (await runRecurring()).wallets
        : wallets;
      set({ onboarded, wallets: latestWallets, status: 'ready' });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const startupError = [
        'DATABASE_KEY_MISSING',
        'DATABASE_KEY_INVALID',
        'DATABASE_KEY_UNAVAILABLE',
      ].includes(code)
        ? 'databaseKeyError'
        : code === 'DATABASE_CIPHER_UNAVAILABLE'
          ? 'databaseBuildError'
          : code === 'DATABASE_RECOVERY_REQUIRED'
            ? 'databaseRecoveryError'
            : 'databaseError';
      logAppEvent('error', {
        route: 'startup',
        status: 'failed',
        errorCode: 'DATABASE_OPEN_FAILED',
      });
      set({ status: 'error', startupError });
    }
  },
  async completeOnboarding(balance) {
    const wallets = await withDatabase(async (db) => {
      await finishOnboarding(db, balance, new Date().toISOString());
      return listWallets(db);
    });
    set({ wallets, onboarded: true });
  },
  async refreshWallets() {
    set({ wallets: await withDatabase(listWallets) });
  },
  async deleteData() {
    if (get().deleting) return;
    set({ status: 'loading', deleting: true, wallets: [] });
    try {
      await clearRecurringNotifications();
      await deletePreviewData();
      await clearBudgetNotifications();
      await pinLock.resetAfterDataDeletion();
      resetPreferences();
      await lockSession.getState().initialize();
      set({
        wallets: [],
        chatSessionId: uuid.v4(),
        onboarded: false,
        status: 'idle',
        deleteFailed: false,
        deleting: false,
      });
      await get().initialize();
    } catch {
      set({
        wallets: [],
        onboarded: false,
        status: 'error',
        deleteFailed: true,
        deleting: false,
      });
    }
  },
}));
