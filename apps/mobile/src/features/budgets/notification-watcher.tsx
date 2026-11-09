import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import {
  AI_REPLY_NOTIFICATION_PREFIX,
  DAILY_EXPENSE_NOTIFICATION_ID,
  syncDailyExpenseReminder,
} from '@/features/notifications/notification-settings-service';
import { useApp } from '@/state/app';
import { usePreferences } from '@/state/preferences';
import { BUDGET_NOTIFICATION_PREFIX, checkBudgetAlerts } from './mobile';

export function BudgetNotificationWatcher() {
  const ready = useApp((state) => state.status === 'ready' && state.onboarded);
  const wallets = useApp((state) => state.wallets);
  const router = useRouter();
  useEffect(() => {
    if (ready) {
      void checkBudgetAlerts();
      void syncDailyExpenseReminder();
    }
  }, [ready, wallets]);
  useEffect(() => {
    if (!ready) return;
    const active = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkBudgetAlerts();
    });
    const response = (event: Notifications.NotificationResponse | null) => {
      const id = event?.notification.request.identifier ?? '';
      if (id.startsWith(BUDGET_NOTIFICATION_PREFIX)) {
        router.navigate({
          pathname: '/budgets',
          params: { tab: 'budgets' },
        });
        Notifications.clearLastNotificationResponse();
      } else if (id === DAILY_EXPENSE_NOTIFICATION_ID) {
        usePreferences.getState().openAddTransaction('manual');
        Notifications.clearLastNotificationResponse();
      } else if (id.startsWith(AI_REPLY_NOTIFICATION_PREFIX)) {
        usePreferences.getState().openChat();
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
