import * as ImagePicker from 'expo-image-picker';
import { Tabs, useRouter } from 'expo-router';
import type { ComponentProps } from 'react';
import { Alert } from 'react-native';
import {
  FloatingTabBar,
  type TabBarItem,
} from '@/components/ui/floating-tab-bar';
import { useResponsiveLayout } from '@/constants/responsive-layout';
import { useDesignTheme } from '@/constants/theme';
import { vi } from '@/messages/vi';
import { useIsTabBarVisible, usePreferences } from '@/state/preferences';
import { isAnyGuardSaving, requestTabSwitch } from '@/utils/unsaved-changes';

export type ExpoBottomTabBarProps = Parameters<
  NonNullable<ComponentProps<typeof Tabs>['tabBar']>
>[0];

/**
 * Primary navigation tabs. AI Chat lives in the separate "+" action menu.
 */
export const APP_TAB_ITEMS: readonly TabBarItem[] = [
  {
    key: 'index',
    label: vi.overview,
    icon: 'home-variant-outline',
    activeIcon: 'home-variant',
    iosIcon: 'house',
    iosActiveIcon: 'house.fill',
  },
  {
    key: 'budgets',
    label: vi.budgetsTabTitle,
    icon: 'chart-box-outline',
    activeIcon: 'chart-box',
    iosIcon: 'chart.bar',
    iosActiveIcon: 'chart.bar.fill',
  },
  {
    key: 'transactions',
    label: vi.transactions,
    icon: 'wallet-outline',
    activeIcon: 'wallet',
    iosIcon: 'wallet.bifold',
    iosActiveIcon: 'wallet.bifold.fill',
  },
  {
    key: 'settings',
    label: vi.settings,
    icon: 'cog-outline',
    activeIcon: 'cog',
    iosIcon: 'gearshape',
    iosActiveIcon: 'gearshape.fill',
  },
] as const;

/**
 * Custom bottom tab bar adapter bridging Expo Router's BottomTabBarProps to FloatingTabBar.
 * Hides the floating tab bar on the 'chat' route (Option 1.B) so the AI composer sits flush at the bottom.
 */
export function CustomBottomTabBar({
  state,
  emitter,
  navigateToTab,
  insets,
}: ExpoBottomTabBarProps) {
  const router = useRouter();
  const { isDuoClosedPortrait } = useResponsiveLayout();
  const isTabBarVisible = useIsTabBarVisible();

  const activeRoute = state.routes[state.index];
  const activeRouteName = activeRoute?.name ?? 'index';

  // Preserve the edge-to-edge chat composer except when the closed Duo needs
  // the persistent right-side navigation rail.
  if (activeRouteName === 'chat' && !isDuoClosedPortrait) {
    return null;
  }

  const handleSelectTab = (routeName: string) => {
    if (routeName === activeRouteName) {
      usePreferences.getState().setTabBarVisible(true);
      const targetRoute = state.routes.find((r) => r.name === routeName);
      if (targetRoute) {
        emitter.emit({
          type: 'tabPress',
          target: targetRoute.key,
          canPreventDefault: true,
        });
      }
      return;
    }
    requestTabSwitch(activeRouteName, () => {
      usePreferences.getState().setTabBarVisible(true);
      const targetRoute = state.routes.find((r) => r.name === routeName);
      if (!targetRoute) {
        router.navigate(routeName === 'index' ? '/' : (`/${routeName}` as never));
        return;
      }
      const event = emitter.emit({
        type: 'tabPress',
        target: targetRoute.key,
        canPreventDefault: true,
      });
      if (!event.defaultPrevented) {
        navigateToTab(targetRoute.key);
      }
    });
  };

  const captureReceiptFromTab = async (source: 'camera' | 'library') => {
    try {
      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          Alert?.alert?.(vi.receiptCameraDenied);
          return;
        }
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ['images'],
        });
        if (!result.canceled && result.assets?.[0]) {
          usePreferences.getState().openChatWithReceipt(result.assets[0]);
        }
      } else {
        const permission =
          await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          Alert?.alert?.(vi.receiptCameraDenied);
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: false,
        });
        if (!result.canceled && result.assets?.[0]) {
          usePreferences.getState().openChatWithReceipt(result.assets[0]);
        }
      }
    } catch {
      Alert?.alert?.(vi.receiptScanFailed);
    }
  };

  const handleActionSelect = (action: 'manual' | 'camera' | 'chat') => {
    if (isAnyGuardSaving()) {
      return;
    }
    if (action === 'manual') {
      usePreferences.getState().openAddTransaction('manual');
      return;
    }
    if (action === 'camera') {
      Alert?.alert?.(vi.receiptScan, vi.receiptChooseSource, [
        { text: vi.cancel, style: 'cancel' },
        {
          text: vi.receiptTakePhoto,
          onPress: () => {
            void captureReceiptFromTab('camera');
          },
        },
        {
          text: vi.receiptChoosePhoto,
          onPress: () => {
            void captureReceiptFromTab('library');
          },
        },
      ]);
      return;
    }
    if (action === 'chat') {
      usePreferences.getState().openChat();
      return;
    }
  };

  return (
    <FloatingTabBar
      visible={isTabBarVisible}
      items={APP_TAB_ITEMS.map((item) => ({
        ...item,
        label:
          (
            {
              index: vi.overview,
              budgets: vi.statsTabTitle,
              transactions: vi.transactions,
              settings: vi.settings,
            } as Record<string, string>
          )[item.key] ?? item.label,
      }))}
      activeKey={activeRouteName}
      onSelect={handleSelectTab}
      onActionSelect={handleActionSelect}
      addAccessibilityLabel={vi.quickAddMenu}
      bottomInset={insets.bottom}
    />
  );
}

/**
 * Root Tab Navigator using Expo Router's JavaScript <Tabs> and the custom FloatingTabBar.
 */
export default function AppTabs() {
  const theme = useDesignTheme();

  return (
    <Tabs
      tabBar={(props) => <CustomBottomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        animation: 'fade',
        sceneStyle: { backgroundColor: theme.sky.upperMid },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: vi.overview,
          tabBarAccessibilityLabel: vi.overview,
        }}
      />
      <Tabs.Screen
        name="budgets"
        options={{
          title: vi.statsTabTitle,
          tabBarAccessibilityLabel: vi.statsTabTitle,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: vi.chat,
          tabBarAccessibilityLabel: vi.chat,
        }}
      />
      <Tabs.Screen
        name="transactions"
        options={{
          title: vi.transactions,
          tabBarAccessibilityLabel: vi.transactions,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: vi.settings,
          tabBarAccessibilityLabel: vi.settings,
        }}
      />
    </Tabs>
  );
}
