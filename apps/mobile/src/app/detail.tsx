import { useLocalSearchParams, useRouter } from 'expo-router';
import { NativeRouteGuard } from '@/components/native-route-guard';
import { WalletManager } from '@/features/wallets/wallet-manager';
import { GoalManager } from '@/features/goals/goal-manager';
import { RecurringManager } from '@/features/recurring/recurring-manager';
import { DebtManager } from '@/features/debts/debt-manager';
import { CategoryManager } from '@/features/categories/category-manager';
import { AppearanceSettingsView } from '@/features/settings/appearance-settings-view';
import { BackupSettingsView } from '@/features/backup/backup-settings-view';
import { SecuritySettingsView } from '@/features/lock/security-settings-view';
import { NotificationSettingsView } from '@/features/notifications/notification-settings-view';
import { NotificationsView } from '@/features/notifications/notifications-view';
import { View } from 'react-native';
import { useEffect } from 'react';
import { FloatingTabBar } from '@/components/ui/floating-tab-bar';
import { APP_TAB_ITEMS, handleQuickAction } from '@/components/app-tabs.shared';
import { useIsTabBarVisible, usePreferences } from '@/state/preferences';
import { vi } from '@/messages/vi';

/** Keeps primary destinations available while drilling down within a tab. */
function DetailTabBar({ routeKey }: { routeKey: string }) {
  const router = useRouter();
  const visible = useIsTabBarVisible();
  useEffect(() => {
    usePreferences.getState().setTabBarVisible(true);
  }, []);
  const labels: Record<string, string> = {
    index: vi.overview,
    budgets: vi.statsTabTitle,
    transactions: vi.transactions,
    settings: vi.settings,
  };
  return (
    <FloatingTabBar
      items={APP_TAB_ITEMS.map((item) => ({
        ...item,
        label: labels[item.key] ?? item.label,
      }))}
      activeKey={routeKey}
      visible={visible}
      onSelect={(key) =>
        router.dismissTo(
          key === 'index'
            ? '/'
            : (`/${key}` as '/transactions' | '/settings' | '/budgets'),
        )
      }
      onActionSelect={handleQuickAction}
      addAccessibilityLabel={vi.quickAddMenu}
    />
  );
}

/** Reuses existing managers while letting the native stack own drill-down navigation. */
export default function Detail() {
  const { screen } = useLocalSearchParams<{ screen: string }>();
  const router = useRouter();
  const onClose = () => router.back();
  const content =
    screen === 'wallets' ? (
      <WalletManager onClose={onClose} />
    ) : screen === 'goals' ? (
      <GoalManager guardRouteKey="index" onClose={onClose} />
    ) : screen === 'recurring' ? (
      <RecurringManager onClose={onClose} />
    ) : screen === 'debts' ? (
      <DebtManager onClose={onClose} />
    ) : screen === 'categories' ? (
      <CategoryManager onClose={onClose} />
    ) : screen === 'appearance' ? (
      <AppearanceSettingsView onClose={onClose} />
    ) : screen === 'backup' ? (
      <BackupSettingsView onClose={onClose} />
    ) : screen === 'security' ? (
      <SecuritySettingsView onClose={onClose} />
    ) : screen === 'notifications' ? (
      <NotificationSettingsView onClose={onClose} />
    ) : (
      <NotificationsView onClose={onClose} />
    );
  const routeKey =
    screen === 'wallets' || screen === 'goals' || screen === 'alerts'
      ? 'index'
      : screen === 'recurring' || screen === 'debts'
        ? 'transactions'
        : 'settings';
  return (
    <View style={{ flex: 1 }}>
      <NativeRouteGuard routeKey={routeKey} />
      {content}
      <DetailTabBar routeKey={routeKey} />
    </View>
  );
}
