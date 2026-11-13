import MaterialCommunityIcons from '@/components/platform-icon';
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
  Stack,
  useRouter,
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
  configureFonts,
} from 'react-native-paper';
import { Onboarding } from '@/components/onboarding';
import { Screen } from '@/components/screen';
import { DesignColors, DesignTextStyles } from '@/constants/design-tokens';
import { vi } from '@/messages/vi';
import { useApp } from '@/state/app';
import { usePreferences } from '@/state/preferences';
import { LockGate } from '@/features/lock/lock-gate';
import { BackupWatcher } from '@/features/backup/mobile';
import { BudgetNotificationWatcher } from '@/features/budgets/notification-watcher';
import { RecurringWatcher } from '@/features/recurring/watcher';
import { DeleteDataControl } from '@/components/delete-data-control';

export const unstable_settings = { initialRouteName: '(tabs)' };

/**
 * Global route error boundary fallback screen.
 */
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return (
    <Screen title={vi.appName} hasTabBar={false}>
      <Text>{vi.screenError}</Text>
      <Button hitSlop={4} onPress={retry}>
        {vi.retry}
      </Button>
    </Screen>
  );
}

/**
 * Root layout synchronizing native appearance, semantic type styles, and navigation.
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
    // Keep system controls synchronized with the selected app appearance.
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
    roundness: 12,
    fonts: configureFonts({ config: DesignTextStyles }),
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
  const startupError = useApp((state) => state.startupError);
  const onboarded = useApp((state) => state.onboarded);
  const initialize = useApp((state) => state.initialize);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  return status === 'error' ? (
    <Screen title={vi.appName} hasTabBar={false}>
      <Text accessibilityRole="alert">
        {Platform.OS === 'web' ? vi.expoGoOnly : vi[startupError]}
      </Text>
      <Button hitSlop={4} onPress={initialize}>
        {vi.retry}
      </Button>
      <DeleteDataControl />
    </Screen>
  ) : status !== 'ready' ? (
    <Screen title={vi.appName} hasTabBar={false}>
      <ActivityIndicator accessibilityLabel={vi.loading} />
      <Text>{vi.loading}</Text>
    </Screen>
  ) : !onboarded ? (
    <Onboarding />
  ) : (
    <>
      <BudgetNotificationWatcher />
      <RecurringWatcher />
      <BackupWatcher />
      <ApplicationNavigator />
    </>
  );
}

/** Presents primary destinations, drill-down screens and focused tasks with native navigation. */
function ApplicationNavigator() {
  const router = useRouter();
  const tokens = DesignColors[usePreferences((state) => state.themeMode)];
  const addOpen = usePreferences((state) => state.isAddTransactionOpen);
  const chatOpen = usePreferences((state) => state.isChatOpen);
  useEffect(() => {
    if (addOpen) router.push('/add-transaction');
  }, [addOpen, router]);
  useEffect(() => {
    if (chatOpen) router.push('/chat');
  }, [chatOpen, router]);
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: tokens.sky.upperMid },
        gestureEnabled: true,
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="detail" />
      <Stack.Screen
        name="add-transaction"
        options={{
          presentation: Platform.OS === 'ios' ? 'formSheet' : 'modal',
          sheetAllowedDetents: [1],
          sheetGrabberVisible: true,
          sheetCornerRadius: 28,
        }}
      />
      <Stack.Screen
        name="chat"
        options={{
          presentation: Platform.OS === 'ios' ? 'formSheet' : 'modal',
          sheetAllowedDetents: [1],
          sheetGrabberVisible: true,
          sheetCornerRadius: 28,
        }}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
