import { expect, it, vi } from 'vitest';
import { createLockSession } from './session';

function fixture(enabled = true) {
  let now = 100000;
  const port = {
    status: vi.fn(async () => ({ enabled, blockedUntil: 0, attempts: 0 })),
    verify: vi.fn(async (_pin: string) => true),
  };
  const session = createLockSession(port, () => now);
  return {
    session,
    port,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

it.each([
  'DATABASE_KEY_MISSING',
  'DATABASE_KEY_INVALID',
  'DATABASE_KEY_UNAVAILABLE',
])('shows a database key error for %s and allows retry', async (code) => {
  const { session, port } = fixture(false);
  port.status.mockRejectedValueOnce(new Error(code));
  await session.getState().initialize();
  expect(session.getState()).toMatchObject({
    status: 'error',
    storageError: 'databaseKeyError',
  });
  await session.getState().initialize();
  expect(session.getState()).toMatchObject({
    status: 'unlocked',
    storageError: 'pinStorageError',
  });
  port.status.mockRejectedValueOnce(new Error(code));
  await expect(session.getState().refresh()).rejects.toThrow(code);
  expect(session.getState()).toMatchObject({
    status: 'error',
    storageError: 'databaseKeyError',
  });
});

it('preview deferral skips all PIN reads/verifications, keeps the app accessible and still conceals background content', async () => {
  const port = {
    status: vi.fn(async () => {
      throw new Error('MUST_NOT_READ_PIN');
    }),
    verify: vi.fn(async (_pin: string) => {
      throw new Error('MUST_NOT_DERIVE_PIN');
    }),
  };
  const session = createLockSession(port, () => 100000, false);
  await session.getState().initialize();
  expect(session.getState().status).toBe('unlocked');
  await session.getState().refresh();
  session.getState().lock();
  session.getState().setVisible(false);
  expect(session.getState().visible).toBe(false);
  session.getState().setVisible(true);
  expect(session.getState().status).toBe('unlocked');
  expect(await session.getState().unlock('123456')).toBe('cancelled');
  expect(port.status).not.toHaveBeenCalled();
  expect(port.verify).not.toHaveBeenCalled();
});

it('cold start stays gated until storage is read and requires PIN when enabled', async () => {
  const { session } = fixture();
  expect(session.getState().status).toBe('checking');
  await session.getState().initialize();
  expect(session.getState().status).toBe('locked');
  expect(await session.getState().unlock('123456')).toBe('unlocked');
  expect(session.getState().status).toBe('unlocked');
});

it('allows startup without PIN but fails closed if secure storage is unreadable', async () => {
  const { session, port } = fixture(false);
  await session.getState().initialize();
  expect(session.getState().status).toBe('unlocked');
  port.status.mockRejectedValueOnce(new Error('STORAGE_UNAVAILABLE'));
  await session.getState().initialize();
  expect(session.getState().status).toBe('error');
});

it('conceals immediately, resumes before 60s, locks exactly at 60s and rejects clock rollback', async () => {
  const { session, advance } = fixture();
  await session.getState().initialize();
  await session.getState().unlock('123456');
  session.getState().setVisible(false);
  expect(session.getState().visible).toBe(false);
  advance(59999);
  session.getState().setVisible(true);
  expect(session.getState().status).toBe('unlocked');
  session.getState().setVisible(false);
  advance(60000);
  session.getState().setVisible(true);
  expect(session.getState().status).toBe('locked');
  await session.getState().unlock('123456');
  session.getState().setVisible(false);
  advance(-1);
  session.getState().setVisible(true);
  expect(session.getState().status).toBe('locked');
});

it('a successful verification finishing after backgrounding or manual locking cannot unlock the app', async () => {
  const { session, port } = fixture();
  await session.getState().initialize();
  let finish!: (valid: boolean) => void;
  port.verify.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const verifying = session.getState().unlock('123456');
  session.getState().setVisible(false);
  session.getState().setVisible(true);
  finish(true);
  expect(await verifying).toBe('cancelled');
  expect(session.getState().status).toBe('locked');
});

it('failed verification retains the locked state and publishes persisted retry delay', async () => {
  const { session, port } = fixture();
  await session.getState().initialize();
  port.verify.mockResolvedValueOnce(false);
  port.status.mockResolvedValueOnce({
    enabled: true,
    blockedUntil: 105000,
    attempts: 3,
  });
  expect(await session.getState().unlock('000000')).toBe('invalid');
  expect(session.getState().status).toBe('locked');
  expect(session.getState().blockedUntil).toBe(105000);
});

it('manual lock is immediate and refreshing settings cannot unlock an enabled locked session', async () => {
  const { session } = fixture();
  await session.getState().initialize();
  await session.getState().unlock('123456');
  session.getState().lock();
  await session.getState().refresh();
  expect(session.getState().status).toBe('locked');
});

it('manual locking cancels an in-flight unlock and double-tapping does not start another verifier', async () => {
  const { session, port } = fixture();
  await session.getState().initialize();
  let finish!: (valid: boolean) => void;
  port.verify.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = session.getState().unlock('123456');
  expect(await session.getState().unlock('123456')).toBe('cancelled');
  expect(port.verify).toHaveBeenCalledOnce();
  session.getState().lock();
  finish(true);
  expect(await first).toBe('cancelled');
  expect(session.getState().status).toBe('locked');
});

it('a PIN enabled while concealed requires unlocking, and settings storage errors fail closed', async () => {
  const { session, port } = fixture(false);
  await session.getState().initialize();
  session.getState().setVisible(false);
  port.status.mockResolvedValueOnce({
    enabled: true,
    blockedUntil: 0,
    attempts: 0,
  });
  await session.getState().refresh();
  expect(session.getState().status).toBe('locked');
  port.status.mockRejectedValueOnce(new Error('STORAGE_UNAVAILABLE'));
  await expect(session.getState().refresh()).rejects.toThrow(
    'STORAGE_UNAVAILABLE',
  );
  expect(session.getState().status).toBe('error');
});
