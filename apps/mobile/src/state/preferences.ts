import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { convertMoney } from '@pfm/domain';
import type {
  AppLanguage,
  CurrencyCode,
  ThemeMode,
} from '@/constants/design-tokens';
import { withDatabase } from '@/data/connection';
import type { Queries } from '@/data/migrate';
import { applyDevSeedData, removeDevSeedData } from '@/data/seed-data';
import { loadUsdVndRate } from '@/services/exchange-rate';
import { setActiveLanguage } from '@/messages/language';

export interface UserPreferences {
  language: AppLanguage;
  currency: CurrencyCode;
  themeMode: ThemeMode;
  seedEnabled: boolean;
}

export type ChatActionType = 'camera' | 'library' | 'prompt';

export interface ReceiptAssetPayload {
  uri: string;
  width?: number;
  height?: number;
}

interface PreferencesState extends UserPreferences {
  hydrated: boolean;
  pendingTransactionEntry: 'manual' | 'natural' | null;
  pendingChatAction: ChatActionType | null;
  pendingReceiptAsset: ReceiptAssetPayload | null;
  isAddTransactionOpen: boolean;
  isChatOpen: boolean;
  isTabBarVisible: boolean;
  setTabBarVisible(visible: boolean): void;
  openAddTransaction(mode?: 'manual' | 'natural'): void;
  closeAddTransaction(): void;
  openChat(action?: ChatActionType): void;
  openChatWithReceipt(asset: ReceiptAssetPayload): void;
  closeChat(): void;
  exchangeRate: number | null;
  exchangeRateDate: string | null;
  exchangeRateCached: boolean;
  refreshExchangeRate(): Promise<void>;
  hydratePreferences(): Promise<void>;
  setLanguage(language: AppLanguage): Promise<void>;
  setCurrency(currency: CurrencyCode): Promise<void>;
  setThemeMode(themeMode: ThemeMode): Promise<void>;
  setSeedEnabled(enabled: boolean): Promise<void>;
  requestAddTransaction(mode?: 'manual' | 'natural'): void;
  consumeAddTransaction(): 'manual' | 'natural' | null;
  requestChatCamera(action?: ChatActionType): void;
  consumeChatAction(): ChatActionType | null;
  consumeReceiptAsset(): ReceiptAssetPayload | null;
}

const PREF_KEYS = {
  language: 'pref_language',
  currency: 'pref_currency',
  themeMode: 'pref_theme_mode',
  seedEnabled: 'pref_seed_enabled',
} as const;

/**
 * Reads a single preference value from the local SQLite settings table.
 */
async function readSettingValue(
  db: Queries,
  key: string,
): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    key,
  );
  return row?.value ?? null;
}

/**
 * Upserts a single preference key-value pair into the local SQLite settings table.
 */
async function writeSettingValue(
  db: Queries,
  key: string,
  value: string,
): Promise<void> {
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

/**
 * Formats an integer amount in the smallest currency unit into a human-readable currency string.
 * Money is strictly stored and processed as integers (never floating-point).
 */
export function formatCurrencyAmount(
  amountInteger: number,
  currency: CurrencyCode,
  options?: { showPlus?: boolean; compact?: boolean; rate?: number },
): string {
  const safeInteger = Math.trunc(
    Number.isFinite(amountInteger) ? amountInteger : 0,
  );
  const isNegative = safeInteger < 0;
  const absValue = Math.abs(safeInteger);
  const prefix = isNegative
    ? '-'
    : options?.showPlus && absValue > 0
      ? '+'
      : '';

  if (currency === 'USD') {
    const rate = options?.rate ?? usePreferences.getState().exchangeRate;
    if (rate === null) return '—';
    const totalCents = Math.abs(convertMoney(safeInteger, 'VND', 'USD', rate));
    const wholeDollars = Math.floor(totalCents / 100);
    const cents = totalCents % 100;
    if (options?.compact && wholeDollars >= 1000) {
      const compactThousands = (wholeDollars / 1000)
        .toFixed(1)
        .replace(/\.0$/, '');
      return `${prefix}$${compactThousands}k`;
    }
    const formattedDollars = wholeDollars
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${prefix}$${formattedDollars}.${cents.toString().padStart(2, '0')}`;
  }

  if (options?.compact) {
    if (absValue >= 1_000_000_000) {
      const billions = (absValue / 1_000_000_000)
        .toFixed(1)
        .replace(/\.0$/, '');
      return `${prefix}${billions}B ₫`;
    }
    if (absValue >= 1_000_000) {
      const millions = (absValue / 1_000_000).toFixed(1).replace(/\.0$/, '');
      return `${prefix}${millions}M ₫`;
    }
    if (absValue >= 1_000) {
      const thousands = Math.round(absValue / 1_000);
      return `${prefix}${thousands}k ₫`;
    }
  }

  const grouped = absValue.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${prefix}${grouped} ₫`;
}

export function formatTransactionCurrencyAmount(
  row: {
    amount: number;
    original_amount_minor: number | null;
    original_currency: 'VND' | 'USD';
    booking_rate: number | null;
  },
  currency: CurrencyCode,
  rate: number | null,
): string {
  if (row.original_currency !== 'USD')
    return formatCurrencyAmount(
      row.amount,
      currency,
      rate ? { rate } : undefined,
    );
  const originalCents = row.original_amount_minor ?? 0;
  if (currency === 'USD') {
    const dollars = Math.floor(originalCents / 100)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `$${dollars}.${(originalCents % 100).toString().padStart(2, '0')}`;
  }
  return formatCurrencyAmount(
    rate ? convertMoney(originalCents, 'USD', 'VND', rate) : row.amount,
    'VND',
  );
}

export const usePreferences = create<PreferencesState>()((set, get) => ({
  language: 'vi',
  currency: 'VND',
  themeMode: 'light',
  seedEnabled: false,
  hydrated: false,
  pendingTransactionEntry: null,
  pendingChatAction: null,
  pendingReceiptAsset: null,
  isAddTransactionOpen: false,
  isChatOpen: false,
  isTabBarVisible: true,

  setTabBarVisible(visible: boolean) {
    if (get().isTabBarVisible !== visible) {
      set({ isTabBarVisible: visible });
    }
  },

  openAddTransaction(mode = 'manual') {
    set({ isAddTransactionOpen: true, pendingTransactionEntry: mode });
  },

  closeAddTransaction() {
    set({ isAddTransactionOpen: false, pendingTransactionEntry: null });
  },

  openChat(action?: ChatActionType) {
    set({ isChatOpen: true, pendingChatAction: action ?? null });
  },

  openChatWithReceipt(asset: ReceiptAssetPayload) {
    set({
      isChatOpen: true,
      pendingReceiptAsset: asset,
      pendingChatAction: null,
    });
  },

  closeChat() {
    set({ isChatOpen: false, pendingChatAction: null, pendingReceiptAsset: null });
  },

  exchangeRate: null,
  exchangeRateDate: null,
  exchangeRateCached: false,

  async refreshExchangeRate() {
    try {
      const next = await withDatabase((db) => loadUsdVndRate(db));
      set({
        exchangeRate: next.rate,
        exchangeRateDate: next.date,
        exchangeRateCached: next.cached,
      });
    } catch {
      if (get().exchangeRate !== null) set({ exchangeRateCached: true });
    }
  },

  requestAddTransaction(mode = 'manual') {
    set({ isAddTransactionOpen: true, pendingTransactionEntry: mode });
  },

  consumeAddTransaction() {
    const current = get().pendingTransactionEntry;
    if (current !== null) {
      set({ pendingTransactionEntry: null });
    }
    return current;
  },

  requestChatCamera(action: ChatActionType = 'camera') {
    set({ isChatOpen: true, pendingChatAction: action });
  },

  consumeChatAction() {
    const current = get().pendingChatAction;
    if (current !== null) {
      set({ pendingChatAction: null });
    }
    return current;
  },

  consumeReceiptAsset() {
    const current = get().pendingReceiptAsset;
    if (current !== null) {
      set({ pendingReceiptAsset: null });
    }
    return current;
  },

  async hydratePreferences() {
    try {
      const loaded = await withDatabase(async (db) => {
        const language = await readSettingValue(db, PREF_KEYS.language);
        const currency = await readSettingValue(db, PREF_KEYS.currency);
        const themeMode = await readSettingValue(db, PREF_KEYS.themeMode);
        const seedEnabled = await readSettingValue(db, PREF_KEYS.seedEnabled);
        return {
          language: (language === 'en' || language === 'vi'
            ? language
            : 'vi') as AppLanguage,
          currency: (currency === 'USD' || currency === 'VND'
            ? currency
            : 'VND') as CurrencyCode,
          themeMode: (themeMode === 'dark' || themeMode === 'light'
            ? themeMode
            : 'light') as ThemeMode,
          seedEnabled: seedEnabled === 'true',
        };
      });
      set({ ...loaded, hydrated: true });
      setActiveLanguage(loaded.language);
      void get().refreshExchangeRate();
    } catch {
      set({ hydrated: true });
    }
  },

  async setLanguage(language) {
    set({ language });
    setActiveLanguage(language);
    try {
      await withDatabase((db) =>
        writeSettingValue(db, PREF_KEYS.language, language),
      );
    } catch {
      // Keep in-memory state if persistence is unavailable in tests.
    }
  },

  async setCurrency(currency) {
    set({ currency });
    if (currency === 'USD') void get().refreshExchangeRate();
    try {
      await withDatabase((db) =>
        writeSettingValue(db, PREF_KEYS.currency, currency),
      );
    } catch {
      // Keep in-memory state if persistence is unavailable in tests.
    }
  },

  async setThemeMode(themeMode) {
    set({ themeMode });
    try {
      await withDatabase((db) =>
        writeSettingValue(db, PREF_KEYS.themeMode, themeMode),
      );
    } catch {
      // Keep in-memory state if persistence is unavailable in tests.
    }
  },

  async setSeedEnabled(enabled) {
    await withDatabase(async (db) => {
      if (enabled) await applyDevSeedData(db);
      else await removeDevSeedData(db);
    });
    set({ seedEnabled: enabled });
  },
}));

export function useIsTabBarVisible() {
  const [visible, setVisible] = useState(
    () => usePreferences.getState().isTabBarVisible,
  );
  useEffect(() => {
    return usePreferences.subscribe((state) => {
      setVisible(state.isTabBarVisible);
    });
  }, []);
  return visible;
}
