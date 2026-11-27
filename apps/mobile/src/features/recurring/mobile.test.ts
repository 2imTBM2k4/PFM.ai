import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecurringRow } from '@/data/recurring';

const native = vi.hoisted(() => ({
  granted: true,
  provisional: false,
  platform: 'ios',
  requests: [] as {
    identifier: string;
    content: { title: string; body: string; data: unknown };
    trigger: { type: string; date: Date; channelId?: string };
  }[],
  scheduled: [] as { identifier: string }[],
  cancelled: [] as string[],
  dismissed: [] as string[],
  prompts: 0,
  channels: 0,
  fail: false,
  generated: 0,
  blocked: false,
  inactive: false,
  permissionWait: undefined as Promise<void> | undefined,
  scheduleGate: undefined as Promise<void> | undefined,
  onSchedule: undefined as (() => void) | undefined,
  balance: 100,
  debts: [] as { id: string; due_on: string | null; outstanding: number }[],
}));
vi.mock('expo', () => ({ uuid: { v4: () => 'uuid' } }));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.platform;
    },
  },
}));
vi.mock('@/data/connection', () => ({
  withDatabase: async (task: (db: unknown) => Promise<unknown>) =>
    task({ getAllAsync: async () => [] }),
}));
vi.mock('@/data/repository', () => ({
  listWallets: async () => [{ id: 'wallet', balance: native.balance }],
}));
vi.mock('@/data/debts', () => ({ listDebts: async () => native.debts }));
vi.mock('@/data/recurring', () => ({
  generateRecurring: async () => {
    native.generated++;
    return { created: 1, hasMore: false };
  },
  scheduleOf: (row: RecurringRow) => ({
    startOn: row.start_on,
    endOn: row.end_on,
    frequency: row.frequency,
    intervalCount: row.interval_count,
  }),
  listRecurringRules: async () => [
    {
      id: 'rule',
      start_on: '2026-10-27',
      end_on: '2026-10-28',
      frequency: 'daily',
      interval_count: 1,
      last_generated_on: null,
      is_active: native.inactive ? 0 : 1,
      blocked: native.blocked ? 1 : 0,
    },
  ],
}));
vi.mock('expo-notifications', () => ({
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  AndroidImportance: { DEFAULT: 3 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
  getPermissionsAsync: async () => ({
    granted: native.granted,
    ios: { status: native.provisional ? 3 : 0 },
  }),
  requestPermissionsAsync: async () => {
    native.prompts++;
    await native.permissionWait;
  },
  setNotificationChannelAsync: async () => {
    native.channels++;
  },
  getAllScheduledNotificationsAsync: async () => native.scheduled,
  scheduleNotificationAsync: async (item: (typeof native.requests)[number]) => {
    native.onSchedule?.();
    await native.scheduleGate;
    if (native.fail) throw new Error('schedule');
    native.requests.push(item);
    native.scheduled.push({ identifier: item.identifier });
    return item.identifier;
  },
  cancelScheduledNotificationAsync: async (id: string) => {
    native.cancelled.push(id);
    native.scheduled = native.scheduled.filter(
      (item) => item.identifier !== id,
    );
  },
  getPresentedNotificationsAsync: async () => [
    { request: { identifier: 'pfm-recurring-old' } },
    { request: { identifier: 'pfm-budget-test' } },
  ],
  dismissNotificationAsync: async (id: string) => {
    native.dismissed.push(id);
  },
}));
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T01:00:00Z'));
  Object.assign(native, {
    granted: true,
    provisional: false,
    platform: 'ios',
    requests: [],
    scheduled: [],
    cancelled: [],
    dismissed: [],
    prompts: 0,
    channels: 0,
    fail: false,
    generated: 0,
    blocked: false,
    inactive: false,
    permissionWait: undefined,
    scheduleGate: undefined,
    onSchedule: undefined,
    balance: 100,
    debts: [],
  });
});
afterEach(() => vi.useRealTimers());

it('generates without an implicit permission prompt, schedules generic 09:00 reminders once and coalesces work', async () => {
  const { runRecurring } = await import('./mobile');
  await Promise.all([runRecurring(), runRecurring()]);
  expect(native.generated).toBe(1);
  expect(native.prompts).toBe(0);
  expect(native.requests).toHaveLength(2);
  expect(native.requests[0].trigger.date.toISOString()).toBe(
    '2026-10-26T02:00:00.000Z',
  );
  expect(native.requests[0].content.body).not.toContain('100');
  await runRecurring();
  expect(native.requests).toHaveLength(2);
});
it('cancels only its own obsolete reminders when paused, blocked or denied; generation still runs', async () => {
  const { runRecurring } = await import('./mobile');
  native.scheduled = [
    { identifier: 'pfm-budget-test' },
    { identifier: 'pfm-recurring-old' },
  ];
  native.blocked = true;
  await runRecurring();
  expect(native.cancelled).toEqual(['pfm-recurring-old']);
  native.blocked = false;
  native.inactive = true;
  await runRecurring();
  expect(native.requests).toHaveLength(0);
  native.inactive = false;
  native.granted = false;
  await runRecurring();
  expect(native.generated).toBe(3);
  expect(native.requests).toHaveLength(0);
});
it('accepts provisional permission and reports native failure without hiding the committed balances', async () => {
  const { runRecurring, useRecurringStatus } = await import('./mobile');
  native.granted = false;
  native.provisional = true;
  native.fail = true;
  expect(await runRecurring()).toMatchObject({
    created: 1,
    wallets: [{ balance: 100 }],
  });
  expect(useRecurringStatus.getState()).toMatchObject({
    error: true,
    permission: 'granted',
  });
  native.fail = false;
  await runRecurring();
  expect(native.requests).toHaveLength(2);
});
it('explicitly requests permission, creates the Android channel and cleans only recurring notifications', async () => {
  const { requestRecurringNotifications, clearRecurringNotifications } =
    await import('./mobile');
  native.platform = 'android';
  await requestRecurringNotifications();
  expect(native.prompts).toBe(1);
  expect(native.channels).toBeGreaterThan(0);
  expect(native.requests[0].trigger.channelId).toBe('pfm-recurring');
  native.scheduled.push({ identifier: 'pfm-budget-test' });
  await clearRecurringNotifications();
  expect(native.scheduled).toEqual([{ identifier: 'pfm-budget-test' }]);
  expect(native.dismissed).toEqual(['pfm-recurring-old']);
});
it('reserves notification capacity used by other features', async () => {
  const { runRecurring } = await import('./mobile');
  native.scheduled = Array.from({ length: 48 }, (_, i) => ({
    identifier: `other-${i}`,
  }));
  await runRecurring();
  expect(native.requests).toHaveLength(0);
  expect(native.cancelled).toHaveLength(0);
});

it('does not restart processing after reset while a permission dialog was open', async () => {
  const { requestRecurringNotifications, clearRecurringNotifications } =
    await import('./mobile');
  let release!: () => void;
  native.permissionWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = requestRecurringNotifications();
  await clearRecurringNotifications();
  release();
  await request;
  expect(native.generated).toBe(0);
  expect(native.requests).toHaveLength(0);
});

it('rechecks a mutation made during native scheduling and reads the latest wallet balance', async () => {
  const { runRecurring } = await import('./mobile');
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    native.onSchedule = resolve;
  });
  native.scheduleGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = runRecurring();
  await entered;
  native.inactive = true;
  native.balance = 500;
  const recheck = runRecurring(true);
  release();
  expect(await first).toMatchObject({ wallets: [{ balance: 500 }] });
  await recheck;
  expect(native.generated).toBe(2);
  expect(native.scheduled).toEqual([]);
});

it('shares the reminder window with debt due dates and cancels on date change or settlement', async () => {
  const { runRecurring, clearRecurringNotifications } =
    await import('./mobile');
  native.debts = [{ id: 'loan', due_on: '2026-10-27', outstanding: 600000 }];
  await runRecurring();
  const debt = native.requests.find((item) =>
    item.identifier.startsWith('pfm-debt-'),
  )!;
  expect(debt.trigger.date.toISOString()).toBe('2026-10-26T02:00:00.000Z');
  expect(debt.content.body).not.toContain('600000');
  native.debts[0].due_on = '2026-10-28';
  await runRecurring();
  expect(native.cancelled).toContain('pfm-debt-loan-2026-10-27');
  expect(
    native.scheduled.some(
      (item) => item.identifier === 'pfm-debt-loan-2026-10-28',
    ),
  ).toBe(true);
  native.debts[0].outstanding = 0;
  await runRecurring();
  expect(
    native.scheduled.some((item) => item.identifier.startsWith('pfm-debt-')),
  ).toBe(false);
  native.scheduled.push(
    { identifier: 'pfm-debt-another' },
    { identifier: 'pfm-budget-test' },
  );
  await clearRecurringNotifications();
  expect(native.scheduled).toEqual([{ identifier: 'pfm-budget-test' }]);
});

it('skips native notification scheduling on web without reporting sync errors', async () => {
  const {
    clearRecurringNotifications,
    requestRecurringNotifications,
    runRecurring,
    useRecurringStatus,
  } = await import('./mobile');
  const previousPlatform = native.platform;
  native.platform = 'web';
  native.fail = true;
  try {
    const result = await runRecurring();
    expect(result.created).toBeGreaterThanOrEqual(0);
    expect(useRecurringStatus.getState().error).toBe(false);
    await expect(requestRecurringNotifications()).resolves.toBeUndefined();
    await expect(clearRecurringNotifications()).resolves.toBeUndefined();
  } finally {
    native.platform = previousPlatform;
    native.fail = false;
  }
});
