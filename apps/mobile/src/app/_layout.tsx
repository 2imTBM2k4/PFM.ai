import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
  type ErrorBoundaryProps,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { Appearance, Platform, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  MD3DarkTheme,
  MD3LightTheme,
  PaperProvider,
  Text,
} from 'react-native-paper';
import AppTabs from '@/components/app-tabs';
import { Onboarding } from '@/components/onboarding';
import { Screen } from '@/components/screen';
import { DesignColors } from '@/constants/design-tokens';
import { vi } from '@/messages/vi';
import { useApp } from '@/state/app';
import { usePreferences } from '@/state/preferences';
import { LockGate } from '@/features/lock/lock-gate';
import { BudgetNotificationWatcher } from '@/features/budgets/notification-watcher';
import { RecurringWatcher } from '@/features/recurring/watcher';

/**
 * Global route error boundary fallback screen.
 */
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return (
    <Screen title={vi.appName}>
      <Text>{vi.screenError}</Text>
      <Button onPress={retry}>{vi.retry}</Button>
    </Screen>
  );
}

/**
 * Root application layout synchronizing native iOS appearance, Pastel Sunset tokens, and tabs.
 */
export default function RootLayout() {
  const themeMode = usePreferences((state) => state.themeMode);
  const hydratePreferences = usePreferences(
    (state) => state.hydratePreferences,
  );
  const dark = themeMode === 'dark';
  const tokens = DesignColors[themeMode];

  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => undefined);
    void hydratePreferences();
  }, [hydratePreferences]);

  useEffect(() => {
    // Synchronize native iOS/Android window color scheme with the app's selected themeMode
    // so NativeTabs Liquid Glass and native surfaces stay bright in Light Mode even if OS Dark Mode is on.
    try {
      Appearance.setColorScheme(themeMode);
    } catch {
      // Ignore if unsupported on web
    }
    void SystemUI.setBackgroundColorAsync(tokens.sky.upperMid).catch(
      () => undefined,
    );
  }, [themeMode, tokens.sky.upperMid]);

  const base = dark ? MD3DarkTheme : MD3LightTheme;
  const theme = {
    ...base,
    roundness: 20,
    colors: {
      ...base.colors,
      primary: tokens.brand.primaryStrong,
      onPrimary: tokens.text.onPrimary,
      primaryContainer: tokens.brand.primarySoft,
      onPrimaryContainer: tokens.brand.primaryText,
      secondary: tokens.brand.primary,
      secondaryContainer: tokens.brand.primarySoft,
      onSecondaryContainer: tokens.brand.primaryText,
      background: tokens.sky.upperMid,
      surface: tokens.card.surfaceElevated,
      surfaceVariant: tokens.card.surfaceSubtle,
      onSurfaceVariant: tokens.text.secondary,
      onBackground: tokens.text.primary,
      onSurface: tokens.text.primary,
      outline: tokens.text.muted,
      outlineVariant: tokens.card.border,
      error: tokens.finance.expense,
      errorContainer: tokens.finance.expenseSoft,
      onErrorContainer: tokens.finance.expenseText,
    },
  };
  const navigation = dark ? DarkTheme : DefaultTheme;
  return (
    <PaperProvider
      theme={theme}
      settings={{ icon: (props) => <MaterialCommunityIcons {...props} /> }}
    >
      <ThemeProvider
        value={{
          ...navigation,
          colors: {
            ...navigation.colors,
            primary: tokens.brand.primary,
            background: tokens.sky.upperMid,
            card: tokens.card.surfaceElevated,
            text: tokens.text.primary,
            border: tokens.card.border,
          },
        }}
      >
        <View style={[styles.root, { backgroundColor: tokens.sky.upperMid }]}>
          <StatusBar style={dark ? 'light' : 'dark'} />
          <LockGate>
            <ApplicationContent />
          </LockGate>
        </View>
      </ThemeProvider>
    </PaperProvider>
  );
}

/**
 * Manages database initialization, onboarding state, and main tab rendering.
 */
function ApplicationContent() {
  const status = useApp((state) => state.status);
  const onboarded = useApp((state) => state.onboarded);
  const initialize = useApp((state) => state.initialize);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  return status === 'error' ? (
    <Screen title={vi.appName}>
      <Text accessibilityRole="alert">
        {Platform.OS === 'web' ? vi.expoGoOnly : vi.databaseError}
      </Text>
      <Button onPress={initialize}>{vi.retry}</Button>
    </Screen>
  ) : status !== 'ready' ? (
    <Screen title={vi.appName}>
      <ActivityIndicator accessibilityLabel={vi.loading} />
      <Text>{vi.loading}</Text>
    </Screen>
  ) : !onboarded ? (
    <Onboarding />
  ) : (
    <>
      <BudgetNotificationWatcher />
      <RecurringWatcher />
      <AppTabs />
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
