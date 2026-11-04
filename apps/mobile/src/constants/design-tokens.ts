import type { ViewStyle } from 'react-native';

export type ThemeMode = 'light' | 'dark';
export type AppLanguage = 'en' | 'vi';
export type CurrencyCode = 'VND' | 'USD';

export interface DesignColorScheme {
  mode: ThemeMode;
  sky: {
    top: string;
    upperMid: string;
    lowerMid: string;
    horizon: string;
  };
  hills: {
    far: string;
    mid: string;
    near: string;
  };
  orb: {
    corePurple: string;
    wavePink: string;
    waveBlue: string;
    highlight: string;
    glow: string;
  };
  card: {
    surface: string;
    surfaceElevated: string;
    surfaceSubtle: string;
    border: string;
    shadow: string;
  };
  brand: {
    primary: string;
    primaryStrong: string;
    primaryText: string;
    primarySoft: string;
    primaryBorder: string;
    primaryGlow: string;
  };
  finance: {
    income: string;
    incomeSoft: string;
    incomeText: string;
    expense: string;
    expenseSoft: string;
    expenseText: string;
    savings: string;
    savingsSoft: string;
    savingsText: string;
  };
  chat: {
    userBubble: string;
    userText: string;
    aiBubble: string;
    aiText: string;
    inputSurface: string;
    inputBorder: string;
  };
  tabBar: {
    pillBackground: string;
    pillBorder: string;
    activeTab: string;
    activeIcon: string;
    inactiveIcon: string;
    addButton: string;
    addButtonGlow: string;
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
    onPrimary: string;
  };
}

export const DesignColors: Record<ThemeMode, DesignColorScheme> = {
  light: {
    mode: 'light',
    sky: {
      top: '#D4E6FF',
      upperMid: '#E2D4FF',
      lowerMid: '#FAD4EA',
      horizon: '#FFE3CC',
    },
    hills: {
      far: 'rgba(176, 152, 232, 0.36)',
      mid: 'rgba(216, 168, 224, 0.44)',
      near: 'rgba(246, 204, 218, 0.58)',
    },
    orb: {
      corePurple: '#7C5CFF',
      wavePink: '#FF7AD9',
      waveBlue: '#5CE1FF',
      highlight: '#FFFFFF',
      glow: 'rgba(124, 92, 255, 0.35)',
    },
    card: {
      surface: 'rgba(255, 255, 255, 0.78)',
      surfaceElevated: 'rgba(255, 255, 255, 0.92)',
      surfaceSubtle: 'rgba(255, 255, 255, 0.56)',
      border: 'rgba(255, 255, 255, 0.88)',
      shadow: 'rgba(67, 56, 114, 0.10)',
    },
    brand: {
      primary: '#7C5CFF',
      primaryStrong: '#6D4AE8',
      primaryText: '#5B3DE0',
      primarySoft: '#ECE6FF',
      primaryBorder: '#D5C7FF',
      primaryGlow: 'rgba(124, 92, 255, 0.32)',
    },
    finance: {
      income: '#16A34A',
      incomeSoft: '#DCFCE7',
      incomeText: '#15803D',
      expense: '#EF4444',
      expenseSoft: '#FEE2E2',
      expenseText: '#DC2626',
      savings: '#7C5CFF',
      savingsSoft: '#EDE9FE',
      savingsText: '#6D28D9',
    },
    chat: {
      userBubble: '#E4DCFF',
      userText: '#1E1B4B',
      aiBubble: 'rgba(243, 244, 248, 0.92)',
      aiText: '#111827',
      inputSurface: 'rgba(255, 255, 255, 0.94)',
      inputBorder: 'rgba(255, 255, 255, 0.95)',
    },
    tabBar: {
      pillBackground: 'rgba(255, 255, 255, 0.78)',
      pillBorder: 'rgba(255, 255, 255, 0.88)',
      activeTab: '#7C5CFF',
      activeIcon: '#FFFFFF',
      inactiveIcon: '#6B7280',
      addButton: '#7C5CFF',
      addButtonGlow: 'rgba(124, 92, 255, 0.35)',
    },
    text: {
      primary: '#111827',
      secondary: '#4B5563',
      muted: '#6B7280',
      onPrimary: '#FFFFFF',
    },
  },
  dark: {
    mode: 'dark',
    sky: {
      top: '#0B1026',
      upperMid: '#191336',
      lowerMid: '#2B183D',
      horizon: '#3B213A',
    },
    hills: {
      far: 'rgba(92, 68, 158, 0.28)',
      mid: 'rgba(124, 92, 255, 0.22)',
      near: 'rgba(42, 28, 72, 0.52)',
    },
    orb: {
      corePurple: '#8B6EFF',
      wavePink: '#FF7AD9',
      waveBlue: '#5CE1FF',
      highlight: '#FFFFFF',
      glow: 'rgba(139, 110, 255, 0.45)',
    },
    card: {
      surface: 'rgba(24, 26, 44, 0.78)',
      surfaceElevated: 'rgba(32, 35, 58, 0.92)',
      surfaceSubtle: 'rgba(20, 22, 38, 0.58)',
      border: 'rgba(255, 255, 255, 0.12)',
      shadow: 'rgba(0, 0, 0, 0.35)',
    },
    brand: {
      primary: '#7C5CFF',
      primaryStrong: '#6D4AE8',
      primaryText: '#C4B5FD',
      primarySoft: 'rgba(124, 92, 255, 0.22)',
      primaryBorder: 'rgba(124, 92, 255, 0.42)',
      primaryGlow: 'rgba(124, 92, 255, 0.40)',
    },
    finance: {
      income: '#4ADE80',
      incomeSoft: 'rgba(34, 197, 94, 0.18)',
      incomeText: '#86EFAC',
      expense: '#F87171',
      expenseSoft: 'rgba(239, 68, 68, 0.18)',
      expenseText: '#FCA5A5',
      savings: '#A78BFA',
      savingsSoft: 'rgba(167, 139, 250, 0.18)',
      savingsText: '#C4B5FD',
    },
    chat: {
      userBubble: '#4832A8',
      userText: '#F8FAFC',
      aiBubble: 'rgba(30, 33, 54, 0.92)',
      aiText: '#F1F5F9',
      inputSurface: 'rgba(26, 29, 48, 0.94)',
      inputBorder: 'rgba(255, 255, 255, 0.14)',
    },
    tabBar: {
      pillBackground: 'rgba(18, 20, 36, 0.78)',
      pillBorder: 'rgba(255, 255, 255, 0.14)',
      activeTab: '#7C5CFF',
      activeIcon: '#FFFFFF',
      inactiveIcon: '#94A3B8',
      addButton: '#7C5CFF',
      addButtonGlow: 'rgba(124, 92, 255, 0.48)',
    },
    text: {
      primary: '#F8FAFC',
      secondary: '#CBD5E1',
      muted: '#94A3B8',
      onPrimary: '#FFFFFF',
    },
  },
};

export const DesignSpacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  screenPadding: 20,
  bottomTabClearance: 112,
} as const;

export const DesignRadius = {
  xs: 10,
  sm: 14,
  md: 20,
  lg: 24,
  xl: 28,
  pill: 999,
} as const;

export const DesignTypography = {
  family: {
    sans: 'System',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  size: {
    caption: 12,
    small: 13,
    body: 15,
    subtitle: 17,
    title: 20,
    heading: 26,
    heroBalance: 38,
  },
  weight: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
    heavy: '800' as const,
  },
} as const;

/**
 * Builds a consistent soft ambient shadow style for glassmorphic cards and floating controls.
 */
export function createSoftShadow(
  mode: ThemeMode,
  elevation: 'sm' | 'md' | 'lg' = 'md',
): ViewStyle {
  const isDark = mode === 'dark';
  const radius = elevation === 'sm' ? 10 : elevation === 'md' ? 18 : 26;
  const height = elevation === 'sm' ? 4 : elevation === 'md' ? 8 : 14;
  return {
    shadowColor: isDark ? '#000000' : '#433872',
    shadowOffset: { width: 0, height },
    shadowOpacity: isDark ? 0.34 : 0.09,
    shadowRadius: radius,
    elevation: elevation === 'sm' ? 3 : elevation === 'md' ? 6 : 10,
  };
}
