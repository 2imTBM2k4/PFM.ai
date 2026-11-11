import * as Notifications from 'expo-notifications';
import {
  AndroidImportance,
  IosAuthorizationStatus,
  SchedulableTriggerInputTypes,
} from 'expo-notifications';
import { Platform } from 'react-native';
import { parseReminderTime } from '@/components/ui/time-field-helpers';
import {
  checkBudgetAlerts,
  clearBudgetNotifications,
  requestBudgetNotifications,
} from '@/features/budgets/mobile';
import {
  clearRecurringNotifications,
  runRecurring,
} from '@/features/recurring/mobile';
import { vi } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';

export const DAILY_EXPENSE_NOTIFICATION_ID = 'pfm-daily-expense-reminder';
export const AI_REPLY_NOTIFICATION_PREFIX = 'pfm-ai-reply-';
const REMINDER_CHANNEL = 'pfm-reminders';

async function hasNotificationPermission() {
  const permission = await Notifications.getPermissionsAsync();
  return (
    permission.granted ||
    permission.ios?.status === IosAuthorizationStatus.PROVISIONAL
  );
}

async function ensureReminderChannel() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL, {
      name: vi.notificationDailyExpenseChannel,
      importance: AndroidImportance.DEFAULT,
      sound: 'default',
    });
  }
}

export { parseReminderTime };

export async function cancelDailyExpenseReminder() {
  try {
    await Notifications.cancelScheduledNotificationAsync(
      DAILY_EXPENSE_NOTIFICATION_ID,
    );
  } catch {
    // Ignore if not scheduled
  }
}

export async function syncDailyExpenseReminder() {
  const prefs = usePreferences.getState();
  await cancelDailyExpenseReminder();
  if (!prefs.notificationsEnabled || !prefs.notifyDailyExpenseReminder) {
    return false;
  }
  try {
    if (!(await hasNotificationPermission())) {
      const requested = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: false, allowSound: true },
      });
      const granted =
        requested.granted ||
        requested.ios?.status === IosAuthorizationStatus.PROVISIONAL;
      if (!granted) return false;
    }
    await ensureReminderChannel();
    const { hour, minute } = parseReminderTime(prefs.dailyExpenseReminderTime);
    await Notifications.scheduleNotificationAsync({
      identifier: DAILY_EXPENSE_NOTIFICATION_ID,
      content: {
        title: vi.dailyExpenseNotificationTitle,
        body: vi.dailyExpenseNotificationBody,
        sound: 'default',
        data: { dailyExpenseReminder: true, showBanner: true },
      },
      trigger: {
        type: SchedulableTriggerInputTypes.DAILY,
        hour,
        minute,
        ...(Platform.OS === 'android' ? { channelId: REMINDER_CHANNEL } : {}),
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function notifyAIReplyCompleted(replyPreview?: string) {
  const prefs = usePreferences.getState();
  if (!prefs.notificationsEnabled || !prefs.notifyAIReply) return false;
  try {
    if (!(await hasNotificationPermission())) return false;
    await ensureReminderChannel();
    const cleanPreview = replyPreview?.trim().replace(/\s+/g, ' ');
    const body =
      cleanPreview && cleanPreview.length > 0
        ? cleanPreview.length > 110
          ? `${cleanPreview.slice(0, 107)}…`
          : cleanPreview
        : vi.aiReplyNotificationBody;
    await Notifications.scheduleNotificationAsync({
      identifier: `${AI_REPLY_NOTIFICATION_PREFIX}${Date.now()}`,
      content: {
        title: vi.aiReplyNotificationTitle,
        body,
        sound: 'default',
        data: { aiReply: true, showBanner: true },
      },
      trigger:
        Platform.OS === 'android' ? { channelId: REMINDER_CHANNEL } : null,
    });
    return true;
  } catch {
    return false;
  }
}

export async function syncAllNotificationSchedules() {
  const prefs = usePreferences.getState();
  if (!prefs.notificationsEnabled) {
    await cancelDailyExpenseReminder();
    await clearBudgetNotifications();
    await clearRecurringNotifications();
    return;
  }
  await syncDailyExpenseReminder();
  await checkBudgetAlerts();
  try {
    await runRecurring(true);
  } catch {
    // Ignore recurring errors during notification sync
  }
}

export async function toggleMasterNotifications(enabled: boolean) {
  await usePreferences.getState().setNotificationsEnabled(enabled);
  if (enabled) {
    await requestBudgetNotifications();
  }
  await syncAllNotificationSchedules();
}
