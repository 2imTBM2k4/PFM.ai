import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('expo', () => ({ uuid: { v4: () => 'test-chat-session' } }));
vi.mock('@/features/recurring/mobile', () => ({
  runRecurring: async () => {
    operations.runs++;
    return { wallets: [], created: operations.created };
  },
  clearRecurringNotifications: async () => {
    operations.calls.push('clear-recurring');
    if (operations.failRecurring) throw new Error('RECURRING_CLEANUP_FAILED');
  },
}));

const operations = vi.hoisted(() => ({
  calls: [] as string[],
  failDatabase: false,
  failKey: false,
  failNotifications: false,
  failRecurring: false,
  created: 0,
  runs: 0,
  onboarded: false,
  startupError: null as string | null,
}));
vi.mock('@/data/connection', () => ({
  withDatabase: async () => {
    if (operations.startupError) throw new Error(operations.startupError);
    return { onboarded: operations.onboarded, wallets: [] };
  },
  deletePreviewData: async () => {
    operations.calls.push('delete-database');
    if (operations.failDatabase) throw new Error('DATABASE_DELETE_FAILED');
  },
}));
vi.mock('@/features/lock/mobile', () => ({
  pinLock: {
    resetAfterDataDeletion: async () => {
      operations.calls.push('delete-pin');
      if (operations.failKey) throw new Error('PIN_DELETE_FAILED');
    },
  },
  lockSession: {
    getState: () => ({
      initialize: async () => {
        operations.calls.push('reload-lock');
      },
    }),
  },
}));
vi.mock('@/services/logger', () => ({ logAppEvent: () => undefined }));
vi.mock('@/features/budgets/mobile', () => ({
  clearBudgetNotifications: async () => {
    operations.calls.push('clear-notifications');
    if (operations.failNotifications)
      throw new Error('NOTIFICATION_CLEANUP_FAILED');
  },
}));

beforeEach(() => {
  vi.resetModules();
  operations.calls = [];
  operations.failDatabase = false;
  operations.failKey = false;
  operations.failNotifications = false;
  operations.failRecurring = false;
  operations.created = 0;
  operations.runs = 0;
  operations.onboarded = false;
  operations.startupError = null;
});

it.each([
  ['DATABASE_KEY_MISSING', 'databaseKeyError'],
  ['DATABASE_KEY_INVALID', 'databaseKeyError'],
  ['DATABASE_KEY_UNAVAILABLE', 'databaseKeyError'],
  ['DATABASE_CIPHER_UNAVAILABLE', 'databaseBuildError'],
  ['DATABASE_RECOVERY_REQUIRED', 'databaseRecoveryError'],
  ['PRIVATE_NATIVE_ERROR', 'databaseError'],
])(
  'shows a safe startup explanation for %s without deleting data',
  async (error, message) => {
    operations.startupError = error;
    const { useApp } = await import('./app');
    await useApp.getState().initialize();
    expect(useApp.getState()).toMatchObject({
      status: 'error',
      startupError: message,
    });
    expect(operations.calls).toEqual([]);
    operations.startupError = null;
    await useApp.getState().initialize();
    expect(useApp.getState()).toMatchObject({
      status: 'ready',
      startupError: 'databaseError',
    });
  },
);

it('explicit deletion resets sample preferences and pending UI state to new-user defaults', async () => {
  const { usePreferences } = await import('./preferences');
  usePreferences.setState({
    seedEnabled: true,
    language: 'en',
    currency: 'USD',
    isChatOpen: true,
    pendingReceiptAsset: { uri: 'private.jpg', width: 1, height: 1 },
  });
  const { useApp } = await import('./app');
  await useApp.getState().deleteData();
  expect(usePreferences.getState()).toMatchObject({
    seedEnabled: false,
    language: 'vi',
    currency: 'VND',
    isChatOpen: false,
    pendingReceiptAsset: null,
  });
});

it('forgotten-PIN deletion works before financial data is initialized, removes data before PIN, and restarts onboarding', async () => {
  const { useApp } = await import('./app');
  expect(useApp.getState().status).toBe('idle');
  await useApp.getState().deleteData();
  expect(operations.calls).toEqual([
    'clear-recurring',
    'delete-database',
    'clear-notifications',
    'delete-pin',
    'reload-lock',
  ]);
  expect(useApp.getState()).toMatchObject({
    status: 'ready',
    onboarded: false,
    wallets: [],
    deleting: false,
    deleteFailed: false,
  });
});

it('failed database deletion preserves the PIN and blocks financial screens until a successful retry', async () => {
  operations.failDatabase = true;
  const { useApp } = await import('./app');
  await useApp.getState().deleteData();
  expect(operations.calls).toEqual(['clear-recurring', 'delete-database']);
  expect(useApp.getState()).toMatchObject({
    status: 'error',
    deleteFailed: true,
    deleting: false,
    wallets: [],
  });
  operations.failDatabase = false;
  await useApp.getState().deleteData();
  expect(operations.calls).toEqual([
    'clear-recurring',
    'delete-database',
    'clear-recurring',
    'delete-database',
    'clear-notifications',
    'delete-pin',
    'reload-lock',
  ]);
  expect(useApp.getState().deleteFailed).toBe(false);
});

it('failed secure-key deletion blocks reinitialization and can be retried', async () => {
  operations.failKey = true;
  const { useApp } = await import('./app');
  await useApp.getState().deleteData();
  expect(operations.calls).toEqual([
    'clear-recurring',
    'delete-database',
    'clear-notifications',
    'delete-pin',
  ]);
  expect(useApp.getState().deleteFailed).toBe(true);
  operations.failKey = false;
  await useApp.getState().deleteData();
  expect(useApp.getState()).toMatchObject({
    status: 'ready',
    deleteFailed: false,
  });
});

it('double-tapping delete schedules only one destructive operation', async () => {
  const { useApp } = await import('./app');
  await Promise.all([
    useApp.getState().deleteData(),
    useApp.getState().deleteData(),
  ]);
  expect(operations.calls).toEqual([
    'clear-recurring',
    'delete-database',
    'clear-notifications',
    'delete-pin',
    'reload-lock',
  ]);
});

it('blocks reset completion if native notification cleanup fails and permits retry', async () => {
  operations.failNotifications = true;
  const { useApp } = await import('./app');
  await useApp.getState().deleteData();
  expect(operations.calls).toEqual([
    'clear-recurring',
    'delete-database',
    'clear-notifications',
  ]);
  expect(useApp.getState().deleteFailed).toBe(true);
  operations.failNotifications = false;
  await useApp.getState().deleteData();
  expect(useApp.getState().deleteFailed).toBe(false);
});

it('stops deletion before database removal if recurring notification cleanup fails', async () => {
  const { useApp } = await import('./app');
  operations.failRecurring = true;
  await useApp.getState().deleteData();
  expect(operations.calls).toEqual(['clear-recurring']);
  expect(useApp.getState().deleteFailed).toBe(true);
  operations.failRecurring = false;
  await useApp.getState().deleteData();
  expect(useApp.getState().deleteFailed).toBe(false);
});

it('refreshes automatic-entry observers only when new occurrences were created', async () => {
  const { useApp } = await import('./app');
  useApp.setState({ status: 'ready', onboarded: true });
  operations.created = 1;
  await useApp.getState().refreshRecurring();
  expect(useApp.getState().recurringVersion).toBe(1);
  operations.created = 0;
  await useApp.getState().refreshRecurring();
  expect(useApp.getState().recurringVersion).toBe(1);
});

it('processes recurring entries once before exposing an onboarded app as ready', async () => {
  const { useApp } = await import('./app');
  operations.onboarded = true;
  await useApp.getState().initialize();
  expect(operations.runs).toBe(1);
  expect(useApp.getState()).toMatchObject({ status: 'ready', onboarded: true });
});
