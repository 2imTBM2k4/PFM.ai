import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useApp } from '@/state/app';
import { BUDGET_NOTIFICATION_PREFIX, checkBudgetAlerts } from './mobile';

export function BudgetNotificationWatcher() {
  const ready = useApp((state) => state.status === 'ready' && state.onboarded);
  const wallets = useApp((state) => state.wallets);
  const router = useRouter();
  useEffect(() => {
    if (ready) void checkBudgetAlerts();
  }, [ready, wallets]);
  useEffect(() => {
    if (!ready) return;
    const active = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkBudgetAlerts();
    });
    const response = (event: Notifications.NotificationResponse | null) => {
      if (
        event?.notification.request.identifier.startsWith(
          BUDGET_NOTIFICATION_PREFIX,
        )
      ) {
        router.navigate({
          pathname: '/budgets',
          params: { tab: 'budgets' },
        });
        Notifications.clearLastNotificationResponse();
      }
    };
    const listener =
      Notifications.addNotificationResponseReceivedListener(response);
    void Notifications.getLastNotificationResponseAsync()
      .then(response)
      .catch(() => undefined);
    return () => {
      active.remove();
      listener.remove();
    };
  }, [ready, router]);
  return null;
}
