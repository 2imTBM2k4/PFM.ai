import { Tabs, useRouter } from 'expo-router';
import type { ComponentProps } from 'react';
import {
  FloatingTabBar,
  type TabBarItem,
} from '@/components/ui/floating-tab-bar';
import { useDesignTheme } from '@/constants/theme';
import { vi } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';

export type ExpoBottomTabBarProps = Parameters<
  NonNullable<ComponentProps<typeof Tabs>['tabBar']>
>[0];

/**
 * The 5 main application tabs ordered and mapped to match the reference design:
 * Home (index), Chart/Stats (budgets), AI Sparkles (chat), Wallet/Transactions (transactions), More (settings).
 */
export const APP_TAB_ITEMS: readonly TabBarItem[] = [
  {
    key: 'index',
    label: vi.overview,
    icon: 'home-variant-outline',
    activeIcon: 'home-variant',
  },
  {
    key: 'budgets',
    label: vi.statsTabTitle,
    icon: 'chart-box-outline',
    activeIcon: 'chart-box',
  },
  {
    key: 'chat',
    label: vi.chat,
    icon: 'creation',
    activeIcon: 'creation',
  },
  {
    key: 'transactions',
    label: vi.transactions,
    icon: 'wallet-outline',
    activeIcon: 'wallet',
  },
  {
    key: 'settings',
    label: vi.settings,
    icon: 'cog-outline',
    activeIcon: 'cog',
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

  const activeRoute = state.routes[state.index];
  const activeRouteName = activeRoute?.name ?? 'index';

  // Per Option 1.B: hide the floating tab bar when inside the Chat screen
  if (activeRouteName === 'chat') {
    return null;
  }

  const handleSelectTab = (routeName: string) => {
    const targetRoute = state.routes.find((r) => r.name === routeName);
    if (!targetRoute) {
      router.navigate(routeName === 'index' ? '/' : (`/${routeName}` as never));
      return;
    }
    const isFocused = targetRoute.key === activeRoute?.key;
    const event = emitter.emit({
      type: 'tabPress',
      target: targetRoute.key,
      canPreventDefault: true,
    });
    if (!isFocused && !event.defaultPrevented) {
      navigateToTab(targetRoute.key);
    }
  };

  const handleAddTransactionPress = () => {
    usePreferences.getState().requestAddTransaction('manual');
    const txRoute = state.routes.find((r) => r.name === 'transactions');
    if (txRoute) {
      navigateToTab(txRoute.key);
    } else {
      router.navigate('/transactions');
    }
  };

  return (
    <FloatingTabBar
      items={APP_TAB_ITEMS.map((item) => ({
        ...item,
        label: ({ index: vi.overview, budgets: vi.statsTabTitle, chat: vi.chat, transactions: vi.transactions, settings: vi.settings } as Record<string, string>)[item.key] ?? item.label,
      }))}
      activeKey={activeRouteName}
      onSelect={handleSelectTab}
      onAddPress={handleAddTransactionPress}
      addAccessibilityLabel={vi.addTransaction}
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
