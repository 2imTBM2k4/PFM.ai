import { beforeEach, expect, it, vi } from 'vitest';
import { usePreferences } from './preferences';
import { vi as messages } from '@/messages/vi';

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  remove: vi.fn(),
  write: vi.fn(),
}));
vi.mock('@/data/connection', () => ({
  withDatabase: async (task: (db: object) => Promise<unknown>) =>
    task({ runAsync: mocks.write }),
}));
vi.mock('@/data/seed-data', () => ({
  applyDevSeedData: mocks.apply,
  removeDevSeedData: mocks.remove,
}));

beforeEach(() => {
  vi.resetAllMocks();
  usePreferences.setState({
    seedEnabled: false,
    language: 'vi',
    pendingChatAction: null,
  });
});

it('consumes a requested chat camera action exactly once', () => {
  usePreferences.getState().requestChatCamera();
  expect(usePreferences.getState().consumeChatAction()).toBe('camera');
  expect(usePreferences.getState().consumeChatAction()).toBeNull();
});

it('handles openChatWithReceipt and consumes receipt asset exactly once', () => {
  usePreferences
    .getState()
    .openChatWithReceipt({ uri: 'file://receipt.jpg', width: 800, height: 600 });
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
