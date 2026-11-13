import { beforeEach, expect, it, vi } from 'vitest';
import { isDevSeedToolsEnabled, usePreferences } from './preferences';
import { vi as messages } from '@/messages/vi';

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  remove: vi.fn(),
  write: vi.fn(),
  readFirst: vi.fn(),
}));
vi.mock('@/data/connection', () => ({
  withDatabase: async (task: (db: object) => Promise<unknown>) =>
    task({ runAsync: mocks.write, getFirstAsync: mocks.readFirst }),
}));
vi.mock('@/data/seed-data', () => ({
  applyDevSeedData: mocks.apply,
  removeDevSeedData: mocks.remove,
}));

beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  usePreferences.setState({
    seedEnabled: false,
    language: 'vi',
    pendingChatAction: null,
  });
});

it('keeps navigation hidden while a form owns it despite scroll requests', () => {
  const release = usePreferences.getState().holdTabBarHidden();
  usePreferences.getState().setTabBarVisible(true);
  expect(usePreferences.getState().isTabBarVisible).toBe(false);
  release();
  expect(usePreferences.getState().isTabBarVisible).toBe(true);
});

it('waits for all forms to close and safely ignores repeated releases', () => {
  const releaseFirst = usePreferences.getState().holdTabBarHidden();
  const releaseSecond = usePreferences.getState().holdTabBarHidden();
  releaseFirst();
  releaseFirst();
  usePreferences.getState().setTabBarVisible(true);
  expect(usePreferences.getState().isTabBarVisible).toBe(false);
  releaseSecond();
  expect(usePreferences.getState().isTabBarVisible).toBe(true);
});

it('consumes a requested chat camera action exactly once', () => {
  usePreferences.getState().requestChatCamera();
  expect(usePreferences.getState().consumeChatAction()).toBe('camera');
  expect(usePreferences.getState().consumeChatAction()).toBeNull();
});

it('handles openChatWithReceipt and consumes receipt asset exactly once', () => {
  usePreferences.getState().openChatWithReceipt({
    uri: 'file://receipt.jpg',
    width: 800,
    height: 600,
  });
  expect(usePreferences.getState().isChatOpen).toBe(true);
  expect(usePreferences.getState().consumeReceiptAsset()).toEqual({
    uri: 'file://receipt.jpg',
    width: 800,
    height: 600,
  });
  expect(usePreferences.getState().consumeReceiptAsset()).toBeNull();
});

it('switches catalog language and persists the selection', async () => {
  await usePreferences.getState().setLanguage('en');
  expect(messages.overview).toBe('Overview');
  expect(mocks.write).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO settings'),
    'pref_language',
    'en',
  );
  await usePreferences.getState().setLanguage('vi');
  expect(messages.overview).toBe('Tổng quan');
});

it('keeps the sample switch enabled and reports failure when removal fails', async () => {
  usePreferences.setState({ seedEnabled: true });
  mocks.remove.mockRejectedValue(new Error('FOREIGN KEY constraint failed'));
  await expect(usePreferences.getState().setSeedEnabled(false)).rejects.toThrow(
    'FOREIGN KEY',
  );
  expect(usePreferences.getState().seedEnabled).toBe(true);
  expect(mocks.write).not.toHaveBeenCalled();
});

it('does not claim samples are enabled when insertion fails', async () => {
  mocks.apply.mockRejectedValue(new Error('WRITE_FAILED'));
  await expect(usePreferences.getState().setSeedEnabled(true)).rejects.toThrow(
    'WRITE_FAILED',
  );
  expect(usePreferences.getState().seedEnabled).toBe(false);
  expect(mocks.write).not.toHaveBeenCalled();
});

it('changes sample switch state only after data and preference writes finish', async () => {
  let finish!: () => void;
  mocks.apply.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const save = usePreferences.getState().setSeedEnabled(true);
  expect(usePreferences.getState().seedEnabled).toBe(false);
  finish();
  await save;
  expect(usePreferences.getState().seedEnabled).toBe(true);
  expect(mocks.apply).toHaveBeenCalledOnce();
});

it('persists notification preferences and reminder time', async () => {
  await usePreferences.getState().setNotificationsEnabled(false);
  expect(usePreferences.getState().notificationsEnabled).toBe(false);
  expect(mocks.write).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO settings'),
    'pref_notifications_enabled',
    'false',
  );

  await usePreferences.getState().setNotifyDailyExpenseReminder(true);
  await usePreferences.getState().setDailyExpenseReminderTime('21:30');
  expect(usePreferences.getState().notifyDailyExpenseReminder).toBe(true);
  expect(usePreferences.getState().dailyExpenseReminderTime).toBe('21:30');
  expect(mocks.write).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO settings'),
    'pref_daily_expense_time',
    '21:30',
  );
});

it('hides dev seed tools and forces seedEnabled to false outside __DEV__ without deleting data', async () => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  expect(isDevSeedToolsEnabled()).toBe(false);

  // Even if pref_seed_enabled is 'true' in the database, hydrating outside __DEV__ must keep seedEnabled false and not remove data.
  mocks.readFirst.mockImplementation(async (_sql: string, key: string) => {
    if (key === 'pref_seed_enabled') return { value: 'true' };
    return null;
  });
  await usePreferences.getState().hydratePreferences();
  expect(usePreferences.getState().seedEnabled).toBe(false);
  expect(mocks.remove).not.toHaveBeenCalled();

  // Attempting to toggle seedEnabled outside __DEV__ is a no-op and never modifies the database.
  await usePreferences.getState().setSeedEnabled(true);
  expect(usePreferences.getState().seedEnabled).toBe(false);
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();

  // In __DEV__, hydrating reads pref_seed_enabled = 'true' as true.
  (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  expect(isDevSeedToolsEnabled()).toBe(true);
  await usePreferences.getState().hydratePreferences();
  expect(usePreferences.getState().seedEnabled).toBe(true);
});
