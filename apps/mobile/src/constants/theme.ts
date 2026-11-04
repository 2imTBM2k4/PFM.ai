/**
 * Central theme and design token access for PFM.ai.
 * Combines Pastel Sunset / Midnight Aurora design tokens with backward-compatible helpers.
 */

import '@/global.css';

import { Platform } from 'react-native';
import {
  DesignColors,
  DesignRadius,
  DesignSpacing,
  DesignTypography,
  createSoftShadow,
  type DesignColorScheme,
  type ThemeMode,
} from './design-tokens';
import { usePreferences } from '@/state/preferences';

export {
  DesignColors,
  DesignRadius,
  DesignSpacing,
  DesignTypography,
  createSoftShadow,
  type DesignColorScheme,
  type ThemeMode,
};

export const Colors = {
  light: {
    text: '#111827',
    background: '#E2D4FF',
    backgroundElement: '#FFFFFF',
    backgroundSelected: '#ECE6FF',
    textSecondary: '#4B5563',
  },
  dark: {
    text: '#F8FAFC',
    background: '#0B1026',
    backgroundElement: '#181A2C',
    backgroundSelected: '#2B183D',
    textSecondary: '#94A3B8',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const FinancePalette = {
  light: {
    ground: '#F3EEFF',
    surface: 'rgba(255, 255, 255, 0.84)',
    surfaceMuted: 'rgba(255, 255, 255, 0.62)',
    border: 'rgba(255, 255, 255, 0.88)',
    borderSubtle: 'rgba(124, 92, 255, 0.14)',
    text: '#111827',
    textMuted: '#6B7280',
    primary: '#7C5CFF',
    primarySoft: '#ECE6FF',
    primaryInk: '#4C1D95',
    income: '#16A34A',
    incomeSoft: '#DCFCE7',
    incomeInk: '#15803D',
    expense: '#111827',
    expenseAccent: '#EF4444',
    expenseSoft: '#FEE2E2',
    expenseInk: '#DC2626',
    transfer: '#7C5CFF',
    transferSoft: '#EDE9FE',
    transferInk: '#5B21B6',
    warning: '#D97706',
    warningSoft: '#FEF3C7',
    warningInk: '#92400E',
    danger: '#DC2626',
    dangerSoft: '#FEE2E2',
    dangerInk: '#991B1B',
    purple: '#7C5CFF',
    purpleSoft: '#EDE9FE',
    purpleInk: '#4C1D95',
    teal: '#0D9488',
    tealSoft: '#CCFBF1',
    tealInk: '#115E59',
  },
  dark: {
    ground: '#0B1026',
    surface: 'rgba(24, 26, 44, 0.82)',
    surfaceMuted: 'rgba(32, 35, 58, 0.72)',
    border: 'rgba(255, 255, 255, 0.12)',
    borderSubtle: 'rgba(255, 255, 255, 0.08)',
    text: '#F8FAFC',
    textMuted: '#94A3B8',
    primary: '#7C5CFF',
    primarySoft: 'rgba(124, 92, 255, 0.22)',
    primaryInk: '#DDD6FE',
    income: '#4ADE80',
    incomeSoft: 'rgba(34, 197, 94, 0.18)',
    incomeInk: '#86EFAC',
    expense: '#F8FAFC',
    expenseAccent: '#F87171',
    expenseSoft: 'rgba(239, 68, 68, 0.18)',
    expenseInk: '#FCA5A5',
    transfer: '#A78BFA',
    transferSoft: 'rgba(167, 139, 250, 0.18)',
    transferInk: '#DDD6FE',
    warning: '#FBBF24',
    warningSoft: 'rgba(245, 158, 11, 0.18)',
    warningInk: '#FDE68A',
    danger: '#F87171',
    dangerSoft: 'rgba(239, 68, 68, 0.20)',
    dangerInk: '#FECACA',
    purple: '#A78BFA',
    purpleSoft: 'rgba(124, 92, 255, 0.24)',
    purpleInk: '#E9D5FF',
    teal: '#2DD4BF',
    tealSoft: 'rgba(45, 212, 191, 0.18)',
    tealInk: '#99F6E4',
  },
} as const;

/**
 * Returns the active DesignColorScheme token set according to the user's selected theme mode.
 */
export function useDesignTheme(): DesignColorScheme {
  const themeMode = usePreferences((state) => state.themeMode);
  usePreferences((state) => state.language);
  usePreferences((state) => state.currency);
  usePreferences((state) => state.exchangeRate);
  return DesignColors[themeMode];
}

/**
 * Returns the semantic finance palette synchronized with the user's selected theme mode.
 */
export function useFinancePalette() {
  const themeMode = usePreferences((state) => state.themeMode);
  usePreferences((state) => state.language);
  usePreferences((state) => state.currency);
  usePreferences((state) => state.exchangeRate);
  return FinancePalette[themeMode];
}

/**
 * Maps a wallet kind identifier to its visual icon and token colors.
 */
export function walletKindVisual(
  kind: string,
  palette: ReturnType<typeof useFinancePalette>,
) {
  switch (kind) {
    case 'cash':
      return {
        icon: 'cash-multiple',
        bg: palette.incomeSoft,
        fg: palette.incomeInk,
      };
    case 'bank':
      return {
        icon: 'bank-outline',
        bg: palette.primarySoft,
        fg: palette.primaryInk,
      };
    case 'ewallet':
      return {
        icon: 'cellphone-check',
        bg: palette.purpleSoft,
        fg: palette.purpleInk,
      };
    case 'credit_card':
      return {
        icon: 'credit-card-outline',
        bg: palette.expenseSoft,
        fg: palette.expenseInk,
      };
    case 'savings':
      return {
        icon: 'piggy-bank-outline',
        bg: palette.tealSoft,
        fg: palette.tealInk,
      };
    default:
      return {
        icon: 'wallet-outline',
        bg: palette.surfaceMuted,
        fg: palette.text,
      };
  }
}

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
