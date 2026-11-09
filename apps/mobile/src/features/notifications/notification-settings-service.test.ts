import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_REPLY_NOTIFICATION_PREFIX,
  DAILY_EXPENSE_NOTIFICATION_ID,
  notifyAIReplyCompleted,
  parseReminderTime,
  syncDailyExpenseReminder,
  toggleMasterNotifications,
} from './notification-settings-service';
import { usePreferences } from '@/state/preferences';

const notificationMocks = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  cancelScheduledNotificationAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
}));

const budgetMocks = vi.hoisted(() => ({
  checkBudgetAlerts: vi.fn(),
  clearBudgetNotifications: vi.fn(),
  requestBudgetNotifications: vi.fn(),
}));

const recurringMocks = vi.hoisted(() => ({
  clearRecurringNotifications: vi.fn(),
  runRecurring: vi.fn(),
}));

vi.mock('expo-notifications', () => ({
  ...notificationMocks,
  AndroidImportance: { DEFAULT: 3 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  SchedulableTriggerInputTypes: { DAILY: 'daily', TIME_INTERVAL: 'timeInterval' },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('@/data/connection', () => ({
  withDatabase: async (task: (db: object) => Promise<unknown>) =>
    task({ runAsync: vi.fn() }),
}));

vi.mock('@/features/budgets/mobile', () => budgetMocks);
vi.mock('@/features/recurring/mobile', () => recurringMocks);

describe('notification-settings-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferences.setState({
      notificationsEnabled: true,
      notifyBudgetAlerts: true,
      notifyDailyExpenseReminder: false,
      dailyExpenseReminderTime: '20:00',
      notifyAIReply: true,
      notifyDebts: true,
      notifyRecurring: true,
    });
    notificationMocks.getPermissionsAsync.mockResolvedValue({
      granted: true,
      status: 'granted',
    });
  });

  it('parses valid HH:mm reminder times and falls back to 20:00', () => {
    expect(parseReminderTime('08:30')).toEqual({ hour: 8, minute: 30 });
    expect(parseReminderTime('21:45')).toEqual({ hour: 21, minute: 45 });
    expect(parseReminderTime('invalid')).toEqual({ hour: 20, minute: 0 });
  });

  it('schedules daily expense reminder when enabled and cancels when disabled', async () => {
    usePreferences.setState({
      notificationsEnabled: true,
      notifyDailyExpenseReminder: true,
      dailyExpenseReminderTime: '21:15',
    });

    const scheduled = await syncDailyExpenseReminder();
    expect(scheduled).toBe(true);
    expect(
      notificationMocks.cancelScheduledNotificationAsync,
    ).toHaveBeenCalledWith(DAILY_EXPENSE_NOTIFICATION_ID);
    expect(notificationMocks.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: DAILY_EXPENSE_NOTIFICATION_ID,
        trigger: expect.objectContaining({
          hour: 21,
          minute: 15,
        }),
      }),
    );

    notificationMocks.scheduleNotificationAsync.mockClear();
    usePreferences.setState({ notifyDailyExpenseReminder: false });
    const cancelled = await syncDailyExpenseReminder();
    expect(cancelled).toBe(false);
    expect(notificationMocks.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('sends AI reply notification with showBanner when enabled', async () => {
    const sent = await notifyAIReplyCompleted('Bạn đã chi 150.000 ₫ hôm nay.');
    expect(sent).toBe(true);
    expect(notificationMocks.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: expect.stringMatching(
          new RegExp(`^${AI_REPLY_NOTIFICATION_PREFIX}`),
        ),
        content: expect.objectContaining({
          body: 'Bạn đã chi 150.000 ₫ hôm nay.',
          data: { aiReply: true, showBanner: true },
        }),
      }),
    );
  });

  it('clears all scheduled notifications when master switch is turned off', async () => {
    await toggleMasterNotifications(false);
    expect(usePreferences.getState().notificationsEnabled).toBe(false);
    expect(
      notificationMocks.cancelScheduledNotificationAsync,
    ).toHaveBeenCalledWith(DAILY_EXPENSE_NOTIFICATION_ID);
    expect(budgetMocks.clearBudgetNotifications).toHaveBeenCalledOnce();
    expect(recurringMocks.clearRecurringNotifications).toHaveBeenCalledOnce();
  });
});
