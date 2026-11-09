import * as Notifications from 'expo-notifications';
import { AndroidImportance, IosAuthorizationStatus } from 'expo-notifications';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { monthKey, today } from '@pfm/domain';
import { withDatabase } from '@/data/connection';
import { vi } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';
import { processBudgetAlerts } from './alerts';

export const BUDGET_NOTIFICATION_PREFIX = 'pfm-budget-';
const CHANNEL = 'pfm-budget';
export const useBudgetNotifications = create<{
  status: 'unknown' | 'granted' | 'denied' | 'error';
}>(() => ({ status: 'unknown' }));

Notifications.setNotificationHandler({
  handleNotification: async (notification?: Notifications.Notification) => {
    const showBanner = Boolean(
      (
        notification?.request?.content?.data as
          | { showBanner?: boolean }
          | undefined
      )?.showBanner,
    );
    return {
      shouldShowBanner: showBanner,
      shouldShowList: true,
      shouldPlaySound: showBanner,
      shouldSetBadge: false,
    };
  },
});

function permissionGranted(
  permission: Notifications.NotificationPermissionsStatus,
) {
  const granted =
    permission.granted ||
    permission.ios?.status === IosAuthorizationStatus.PROVISIONAL;
  useBudgetNotifications.setState({ status: granted ? 'granted' : 'denied' });
  return granted;
}

async function ensureChannel() {
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: vi.budgetNotificationChannel,
      importance: AndroidImportance.DEFAULT,
      sound: 'default',
    });
}

let pending: Promise<void> | undefined;
export function checkBudgetAlerts() {
  const prefs = usePreferences.getState();
  if (!prefs.notificationsEnabled || !prefs.notifyBudgetAlerts) {
    return Promise.resolve();
  }
  pending ??= withDatabase((db) =>
    processBudgetAlerts(
      db,
      monthKey(today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' })),
      {
        hasPermission: async () =>
          permissionGranted(await Notifications.getPermissionsAsync()),
        send: async (id, month, threshold) => {
          await ensureChannel();
          await Notifications.scheduleNotificationAsync({
            identifier: `${BUDGET_NOTIFICATION_PREFIX}${id}-${month}-${threshold}`,
            content: {
              title: vi.budgetNotificationTitle,
              body:
                threshold === 100
                  ? vi.budgetNotificationReachedBody
                  : vi.budgetNotificationBody,
              sound: 'default',
              data: { budgetAlert: true },
            },
            trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
          });
        },
      },
    ),
  )
    .catch(() => {
      useBudgetNotifications.setState({ status: 'error' });
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
}

export async function requestBudgetNotifications() {
  try {
    await ensureChannel();
    if (
      permissionGranted(
        await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowBadge: false, allowSound: true },
        }),
      )
    )
      await checkBudgetAlerts();
  } catch {
    useBudgetNotifications.setState({ status: 'error' });
  }
}

export async function testBudgetNotification() {
  await ensureChannel();
  if (!permissionGranted(await Notifications.getPermissionsAsync()))
    return false;
  await Notifications.scheduleNotificationAsync({
    identifier: `${BUDGET_NOTIFICATION_PREFIX}test`,
    content: {
      title: vi.budgetNotificationTitle,
      body: vi.budgetNotificationTestBody,
      sound: 'default',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 5,
      repeats: false,
      ...(Platform.OS === 'android' ? { channelId: CHANNEL } : {}),
    },
  });
  return true;
}

export async function clearBudgetNotifications() {
  await pending;
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const notification of scheduled)
    if (notification.identifier.startsWith(BUDGET_NOTIFICATION_PREFIX))
      await Notifications.cancelScheduledNotificationAsync(
        notification.identifier,
      );
  const presented = await Notifications.getPresentedNotificationsAsync();
  for (const notification of presented)
    if (notification.request.identifier.startsWith(BUDGET_NOTIFICATION_PREFIX))
      await Notifications.dismissNotificationAsync(
        notification.request.identifier,
      );
  useBudgetNotifications.setState({ status: 'unknown' });
}
