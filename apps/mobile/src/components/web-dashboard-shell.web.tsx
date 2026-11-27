import { usePathname, useRouter } from 'expo-router';
import { type PropsWithChildren, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import {
  useResponsiveLayout,
  WEB_SIDEBAR_WIDTH,
} from '@/constants/responsive-layout';
import {
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { useBackupRuntimeStatus } from '@/features/backup/mobile';
import { vi } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';

const subscribeNoop = () => () => {};

interface SidebarNavItem {
  key: string;
  href: string;
  label: string;
  icon: string;
  activeIcon: string;
  match: (pathname: string) => boolean;
}

/** Web-only desktop dashboard shell with persistent left sidebar (>= 1024px) and mobile passthrough (< 1024px). */
export function WebDashboardShell({ children }: PropsWithChildren) {
  const layoutReady = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  const { isWebDesktop } = useResponsiveLayout();
  const theme = useDesignTheme();
  const palette = useFinancePalette();
  const pathname = usePathname();
  const router = useRouter();
  const themeMode = usePreferences((state) => state.themeMode);
  const setThemeMode = usePreferences((state) => state.setThemeMode);
  const backupRuntime = useBackupRuntimeStatus();
  const { state: backupState, isUploading } = backupRuntime;

  if (!layoutReady || !isWebDesktop) {
    return <>{children}</>;
  }

  const navItems: SidebarNavItem[] = [
    {
      key: 'overview',
      href: '/',
      label: vi.overview,
      icon: 'home-variant-outline',
      activeIcon: 'home-variant',
      match: (path) => path === '/' || path === '/index',
    },
    {
      key: 'transactions',
      href: '/transactions',
      label: vi.transactions,
      icon: 'wallet-outline',
      activeIcon: 'wallet',
      match: (path) => path.startsWith('/transactions'),
    },
    {
      key: 'budgets',
      href: '/budgets',
      label: vi.statsTabTitle,
      icon: 'chart-box-outline',
      activeIcon: 'chart-box',
      match: (path) => path.startsWith('/budgets'),
    },
    {
      key: 'chat',
      href: '/chat',
      label: vi.chat,
      icon: 'robot-outline',
      activeIcon: 'robot',
      match: (path) => path.startsWith('/chat'),
    },
    {
      key: 'settings',
      href: '/settings',
      label: vi.settings,
      icon: 'cog-outline',
      activeIcon: 'cog',
      match: (path) => path.startsWith('/settings'),
    },
  ];

  const isConnected = Boolean(backupState.accountEmail);
  const hasSyncError = Boolean(backupState.lastError);
  const syncColor = isUploading
    ? theme.brand.primaryStrong
    : hasSyncError
      ? palette.danger
      : isConnected
        ? palette.income
        : theme.text.muted;
  const syncIcon = isUploading
    ? 'cloud-sync-outline'
    : hasSyncError
      ? 'cloud-alert-outline'
      : isConnected
        ? 'cloud-check-outline'
        : 'cloud-off-outline';
  const syncLabel = isUploading
    ? vi.backupStatusUploading
    : hasSyncError
      ? vi.backupMenuBadgeIssue
      : isConnected
        ? vi.backupConnectedAccountLabel
        : vi.backupMenuTitle;

  const isDark = themeMode === 'dark';

  return (
    <View style={[localStyles.root, { backgroundColor: theme.sky.upperMid }]}>
      <View
        accessibilityRole="none"
        style={[
          localStyles.sidebar,
          {
            width: WEB_SIDEBAR_WIDTH,
            backgroundColor: theme.card.surfaceElevated,
            borderRightColor: theme.card.border,
          },
        ]}
      >
        <View style={localStyles.brandSection}>
          <View
            style={[
              localStyles.brandIcon,
              { backgroundColor: theme.brand.primarySoft },
            ]}
          >
            <Icon
              source="wallet-bifold"
              size={22}
              color={theme.brand.primaryStrong}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text
              variant="titleMedium"
              style={{ fontWeight: '800', color: theme.text.primary }}
            >
              {vi.appName}
            </Text>
            <Text
              variant="labelSmall"
              numberOfLines={1}
              style={{ color: theme.text.muted }}
            >
              {backupState.accountEmail ?? vi.overview}
            </Text>
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={vi.addTransaction}
          onPress={() => router.push('/add-transaction' as never)}
          style={({ pressed }) => [
            localStyles.primaryCta,
            {
              backgroundColor: theme.brand.primaryStrong,
              opacity: pressed ? 0.88 : 1,
            },
          ]}
        >
          <Icon source="plus" size={20} color="#FFFFFF" />
          <Text
            variant="labelLarge"
            style={{ color: '#FFFFFF', fontWeight: '700' }}
          >
            {vi.addTransaction}
          </Text>
        </Pressable>

        <View style={localStyles.navList}>
          {navItems.map((item) => {
            const active = item.match(pathname);
            return (
              <Pressable
                key={item.key}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: active }}
                onPress={() => {
                  if (!active) {
                    router.navigate(item.href as never);
                  }
                }}
                style={({ pressed }) => [
                  localStyles.navItem,
                  {
                    backgroundColor: active
                      ? theme.brand.primarySoft
                      : pressed
                        ? theme.card.surfaceSubtle
                        : 'transparent',
                  },
                ]}
              >
                <Icon
                  source={active ? item.activeIcon : item.icon}
                  size={20}
                  color={
                    active ? theme.brand.primaryStrong : theme.text.secondary
                  }
                />
                <Text
                  variant="bodyMedium"
                  numberOfLines={1}
                  style={{
                    flex: 1,
                    fontWeight: active ? '700' : '500',
                    color: active
                      ? theme.brand.primaryStrong
                      : theme.text.primary,
                  }}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View
          style={[
            localStyles.sidebarFooter,
            { borderTopColor: theme.card.border },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={syncLabel}
            onPress={() => router.navigate('/settings' as never)}
            style={({ pressed }) => [
              localStyles.footerRow,
              {
                backgroundColor: pressed
                  ? theme.card.surfaceSubtle
                  : 'transparent',
              },
            ]}
          >
            <Icon source={syncIcon} size={18} color={syncColor} />
            <Text
              variant="labelMedium"
              numberOfLines={1}
              style={{ flex: 1, color: theme.text.secondary, fontWeight: '600' }}
            >
              {syncLabel}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isDark ? vi.settingsThemeLightShort : vi.settingsThemeDarkShort}
            onPress={() => setThemeMode(isDark ? 'light' : 'dark')}
            style={({ pressed }) => [
              localStyles.footerRow,
              {
                backgroundColor: pressed
                  ? theme.card.surfaceSubtle
                  : 'transparent',
              },
            ]}
          >
            <Icon
              source={isDark ? 'weather-sunny' : 'weather-night'}
              size={18}
              color={theme.text.secondary}
            />
            <Text
              variant="labelMedium"
              numberOfLines={1}
              style={{ flex: 1, color: theme.text.secondary, fontWeight: '600' }}
            >
              {isDark ? vi.settingsThemeLightShort : vi.settingsThemeDarkShort}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={localStyles.mainContent}>{children}</View>
    </View>
  );
}

const localStyles = StyleSheet.create({
  root: {
    flex: 1,
    flexDirection: 'row',
    minHeight: '100%',
  },
  sidebar: {
    borderRightWidth: 1,
    paddingHorizontal: DesignSpacing.md,
    paddingVertical: DesignSpacing.lg,
    gap: DesignSpacing.md,
  },
  brandSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 6,
    paddingBottom: 4,
  },
  brandIcon: {
    width: 38,
    height: 38,
    borderRadius: DesignRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: DesignRadius.lg,
  },
  navList: {
    flex: 1,
    gap: 4,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: DesignRadius.md,
  },
  sidebarFooter: {
    borderTopWidth: 1,
    paddingTop: DesignSpacing.sm,
    gap: 4,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: DesignRadius.md,
  },
  mainContent: {
    flex: 1,
    minWidth: 0,
  },
});
