import { usePathname, useRouter } from 'expo-router';
import { type PropsWithChildren, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import {
  createWebGlassStyle,
  createWebTransitionStyle,
} from '@/constants/motion';
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

/** Web-only desktop dashboard shell with frosted glass sidebar (>= 1024px) and mobile passthrough (< 1024px). */
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
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

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
  const sidebarSurface = isDark
    ? 'rgba(24, 24, 27, 0.78)'
    : 'rgba(255, 255, 255, 0.78)';
  const hoverSurface = isDark
    ? 'rgba(255, 255, 255, 0.06)'
    : 'rgba(17, 24, 39, 0.04)';

  return (
    <View style={[localStyles.root, { backgroundColor: theme.sky.upperMid }]}>
      <View
        accessibilityRole="none"
        style={[
          localStyles.sidebar,
          createWebGlassStyle(24, 180),
          {
            width: WEB_SIDEBAR_WIDTH,
            backgroundColor: sidebarSurface,
            borderRightColor: theme.card.border,
          },
        ]}
      >
        <View style={localStyles.brandSection}>
          <View
            style={[
              localStyles.brandIcon,
              {
                backgroundColor: theme.brand.primarySoft,
                borderColor: theme.brand.primaryBorder,
                borderWidth: 1,
              },
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
          onHoverIn={() => setHoveredKey('cta')}
          onHoverOut={() => setHoveredKey(null)}
          style={({ pressed }) => [
            localStyles.primaryCta,
            createWebTransitionStyle(),
            {
              backgroundColor: theme.brand.primaryStrong,
              opacity: pressed ? 0.92 : 1,
              transform: [
                {
                  translateY: hoveredKey === 'cta' && !pressed ? -1.5 : 0,
                },
                { scale: pressed ? 0.98 : 1 },
              ],
            },
            {
              boxShadow:
                hoveredKey === 'cta'
                  ? `0 10px 24px ${theme.brand.primaryGlow}`
                  : `0 4px 14px ${theme.brand.primaryGlow}`,
            } as unknown as ViewStyle,
          ]}
        >
          <Icon source="plus" size={20} color={theme.text.onPrimary} />
          <Text
            variant="labelLarge"
            style={{ color: theme.text.onPrimary, fontWeight: '700' }}
          >
            {vi.addTransaction}
          </Text>
        </Pressable>

        <View style={localStyles.navList}>
          {navItems.map((item) => {
            const active = item.match(pathname);
            const hovered = hoveredKey === item.key;
            return (
              <Pressable
                key={item.key}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: active }}
                onHoverIn={() => setHoveredKey(item.key)}
                onHoverOut={() => setHoveredKey(null)}
                onPress={() => {
                  if (!active) {
                    router.navigate(item.href as never);
                  }
                }}
                style={({ pressed }) => [
                  localStyles.navItem,
                  createWebTransitionStyle(),
                  {
                    backgroundColor: active
                      ? theme.brand.primarySoft
                      : pressed
                        ? theme.card.surfaceSubtle
                        : hovered
                          ? hoverSurface
                          : 'transparent',
                    transform: [{ translateX: hovered && !active ? 2 : 0 }],
                  },
                ]}
              >
                <View
                  style={[
                    localStyles.activeAccent,
                    createWebTransitionStyle(),
                    {
                      backgroundColor: active
                        ? theme.brand.primaryStrong
                        : 'transparent',
                      opacity: active ? 1 : 0,
                    },
                  ]}
                />
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
            onHoverIn={() => setHoveredKey('sync')}
            onHoverOut={() => setHoveredKey(null)}
            onPress={() => router.navigate('/settings' as never)}
            style={({ pressed }) => [
              localStyles.footerRow,
              createWebTransitionStyle(),
              {
                backgroundColor: pressed
                  ? theme.card.surfaceSubtle
                  : hoveredKey === 'sync'
                    ? hoverSurface
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
            accessibilityLabel={
              isDark
                ? vi.settingsThemeLightShort
                : vi.settingsThemeDarkShort
            }
            onHoverIn={() => setHoveredKey('theme')}
            onHoverOut={() => setHoveredKey(null)}
            onPress={() => setThemeMode(isDark ? 'light' : 'dark')}
            style={({ pressed }) => [
              localStyles.footerRow,
              createWebTransitionStyle(),
              {
                backgroundColor: pressed
                  ? theme.card.surfaceSubtle
                  : hoveredKey === 'theme'
                    ? hoverSurface
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
              {isDark
                ? vi.settingsThemeLightShort
                : vi.settingsThemeDarkShort}
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
    position: 'relative',
  },
  activeAccent: {
    position: 'absolute',
    left: 2,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: DesignRadius.pill,
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