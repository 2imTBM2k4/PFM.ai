import { uuid } from 'expo';
import * as Notifications from 'expo-notifications';
import {
  AndroidImportance,
  IosAuthorizationStatus,
  SchedulableTriggerInputTypes,
} from 'expo-notifications';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { today } from '@pfm/domain';
import { withDatabase } from '@/data/connection';
import { generateRecurring, listRecurringRules } from '@/data/recurring';
import { listWallets } from '@/data/repository';
import { listDebts, type DebtRow } from '@/data/debts';
import {
  buildDebtReminders,
  DEBT_NOTIFICATION_PREFIX,
} from '@/features/debts/reminders';
import { vi } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';
import {
  buildRecurringReminders,
  RECURRING_NOTIFICATION_PREFIX,
} from './reminders';

const CHANNEL = 'pfm-recurring';
const isManagedReminder = (id: string) =>
  id.startsWith(RECURRING_NOTIFICATION_PREFIX) ||
  id.startsWith(DEBT_NOTIFICATION_PREFIX);
export const useRecurringStatus = create<{
  error: boolean;
  permission: 'unknown' | 'granted' | 'denied';
  hasMore: boolean;
}>(() => ({ error: false, permission: 'unknown', hasMore: false }));
let pending: ReturnType<typeof processRecurring> | undefined;
let resetVersion = 0;

async function ensureChannel() {
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: vi.scheduledReminderChannel,
      importance: AndroidImportance.DEFAULT,
      sound: 'default',
    });
}

async function reconcileReminders(
  rules: Awaited<ReturnType<typeof listRecurringRules>>,
  exclusions: Set<string>,
  now: Date,
  debts: DebtRow[],
) {
  const permission = await Notifications.getPermissionsAsync();
  const granted =
    permission.granted ||
    permission.ios?.status === IosAuthorizationStatus.PROVISIONAL;
  useRecurringStatus.setState({ permission: granted ? 'granted' : 'denied' });
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const own = scheduled.filter((item) => isManagedReminder(item.identifier));
  // shortcut: finite window replenishes on open/resume, add background replenishment if needed before release.
  const capacity = Math.max(
    0,
    Math.min(32, 48 - (scheduled.length - own.length)),
  );
  const prefs = usePreferences.getState();
  const masterEnabled = prefs.notificationsEnabled;
  const allowRecurring = masterEnabled && prefs.notifyRecurring;
  const allowDebts = masterEnabled && prefs.notifyDebts;
  const desired =
    granted && masterEnabled
      ? [
          ...(allowRecurring
            ? buildRecurringReminders(rules, exclusions, now, capacity)
            : []),
          ...(allowDebts ? buildDebtReminders(debts, now) : []),
        ]
          .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
          .slice(0, capacity)
      : [];
  const ids = new Set(desired.map((item) => item.id));
  for (const item of own)
    if (!ids.has(item.identifier))
      await Notifications.cancelScheduledNotificationAsync(item.identifier);
  if (!granted) return;
  await ensureChannel();
  for (const item of desired) {
    if (own.some((existing) => existing.identifier === item.id)) continue;
    await Notifications.scheduleNotificationAsync({
      identifier: item.id,
      content: {
        title: item.id.startsWith(DEBT_NOTIFICATION_PREFIX)
          ? vi.debtNotificationTitle
          : vi.recurringNotificationTitle,
        body: item.id.startsWith(DEBT_NOTIFICATION_PREFIX)
          ? vi.debtNotificationBody
          : vi.recurringNotificationBody,
        sound: 'default',
        data: item.id.startsWith(DEBT_NOTIFICATION_PREFIX)
          ? { debtReminder: true }
          : { recurring: true },
      },
      trigger: {
        type: SchedulableTriggerInputTypes.DATE,
        date: new Date(item.at),
        ...(Platform.OS === 'android' ? { channelId: CHANNEL } : {}),
      },
    });
  }
}

async function processRecurring() {
  const now = new Date(),
    date = today({ now: () => now, timeZone: 'Asia/Ho_Chi_Minh' });
  try {
    const data = await withDatabase(async (db) => {
      const result = await generateRecurring(db, date, now.toISOString(), () =>
        uuid.v4(),
      );
      const exclusions = await db.getAllAsync<{ rule: string; date: string }>(
        `SELECT recurring_rule_id rule,occurred_on date FROM recurring_skips WHERE occurred_on>? UNION SELECT recurring_rule_id rule,occurred_on date FROM transactions WHERE recurring_rule_id IS NOT NULL AND occurred_on>?`,
        date,
        date,
      );
      return {
        ...result,
        rules: await listRecurringRules(db),
        debts: await listDebts(db),
        exclusions,
      };
    });
    useRecurringStatus.setState({ hasMore: data.hasMore, error: false });
    try {
      await reconcileReminders(
        data.rules,
        new Set(data.exclusions.map((item) => `${item.rule}/${item.date}`)),
        now,
        data.debts,
      );
    } catch {
      useRecurringStatus.setState({ error: true });
    }
    return { wallets: await withDatabase(listWallets), created: data.created };
  } catch (error) {
    useRecurringStatus.setState({ error: true });
    throw error;
  }
}

export function runRecurring(
  recheck = false,
): ReturnType<typeof processRecurring> {
  if (pending && recheck) {
    const version = resetVersion;
    return pending.then((result) =>
      version === resetVersion ? runRecurring(true) : result,
    );
  }
  pending ??= processRecurring().finally(() => {
    pending = undefined;
  });
  return pending;
}

export async function requestRecurringNotifications() {
  const version = resetVersion;
  try {
    await ensureChannel();
    await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: false, allowSound: true },
    });
    if (version === resetVersion) await runRecurring(true);
  } catch {
    useRecurringStatus.setState({ error: true });
  }
}

export async function clearRecurringNotifications() {
  resetVersion++;
  await pending?.catch(() => undefined);
  for (const item of await Notifications.getAllScheduledNotificationsAsync())
    if (isManagedReminder(item.identifier))
      await Notifications.cancelScheduledNotificationAsync(item.identifier);
  for (const item of await Notifications.getPresentedNotificationsAsync())
    if (isManagedReminder(item.request.identifier))
      await Notifications.dismissNotificationAsync(item.request.identifier);
  useRecurringStatus.setState({
    error: false,
    permission: 'unknown',
    hasMore: false,
  });
}
