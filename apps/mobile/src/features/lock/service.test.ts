import { scryptSync } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { PinLock, type LockStorage } from './service';

let value: string | null;
let now: number;
let storage: LockStorage;
let lock: PinLock;
const derive = async (pin: string, salt: string) =>
  scryptSync(pin, salt, 32, {
    N: 128,
    r: 8,
    p: 1,
    maxmem: 4 * 1024 * 1024,
  }).toString('hex');
const createLock = () =>
  new PinLock(
    storage,
    derive,
    () => '11'.repeat(32),
    () => now,
  );

it('checks storage writability before expensive enrollment derivation', async () => {
  let derived = false;
  storage.checkWritable = async () => {
    throw new Error('WRITE_UNAVAILABLE');
  };
  const enrollment = new PinLock(
    storage,
    async () => {
      derived = true;
      return 'aa'.repeat(32);
    },
    () => '11'.repeat(32),
    () => now,
  );
  await expect(enrollment.enable('123456')).rejects.toThrow(
    'WRITE_UNAVAILABLE',
  );
  expect(derived).toBe(false);
  expect(value).toBeNull();
});

it('removes even a corrupt PIN record only through the explicit data-deletion reset', async () => {
  value = '{broken';
  await lock.resetAfterDataDeletion();
  expect((await lock.status()).enabled).toBe(false);
});

beforeEach(() => {
  value = null;
  now = 100000;
  storage = {
    get: async () => value,
    set: async (next) => {
      value = next;
    },
    remove: async () => {
      value = null;
    },
  };
  lock = createLock();
});

it('validates PINs and stores only a salted verifier', async () => {
  await expect(lock.enable('12345')).rejects.toThrow('PIN_INVALID');
  await expect(lock.enable('abcdef')).rejects.toThrow('PIN_INVALID');
  expect(value).toBeNull();
  await lock.enable('123456');
  expect(JSON.parse(value!).verifier).toBe(
    await derive('123456', '11'.repeat(32)),
  );
  expect(value).not.toContain('123456');
  expect(await lock.verify('654321')).toBe(false);
  expect(await lock.verify('123456')).toBe(true);
  expect((await lock.status()).attempts).toBe(0);
});

it('preserves increasing delays across service restarts', async () => {
  await lock.enable('123456');
  await lock.verify('000000');
  await lock.verify('000000');
  await lock.verify('000000');
  lock = createLock();
  expect((await lock.status()).blockedUntil).toBe(105000);
  await expect(lock.verify('123456')).rejects.toThrow('PIN_DELAYED');
  now = 105000;
  expect(await lock.verify('000000')).toBe(false);
  expect((await lock.status()).blockedUntil).toBe(115000);
  now = 115000;
  expect(await lock.verify('123456')).toBe(true);
});

it('requires the old PIN before replacing or disabling an existing PIN', async () => {
  await lock.enable('123456');
  await expect(lock.enable('222222')).rejects.toThrow('PIN_ALREADY_ENABLED');
  expect(await lock.change('000000', '222222')).toBe(false);
  expect(await lock.verify('123456')).toBe(true);
  expect(await lock.change('123456', '222222')).toBe(true);
  expect(await lock.verify('123456')).toBe(false);
  expect(await lock.disable('222222')).toBe(true);
  expect((await lock.status()).enabled).toBe(false);
});

it('fails closed for corrupt records and secure storage failures', async () => {
  value = '{broken';
  await expect(lock.status()).rejects.toThrow('PIN_RECORD_INVALID');
  value = JSON.stringify({
    version: 1,
    salt: 'bad',
    verifier: 'bad',
    attempts: 0,
    blockedUntil: 0,
  });
  await expect(lock.verify('123456')).rejects.toThrow('PIN_RECORD_INVALID');
  value = null;
  storage.set = async () => {
    throw new Error('STORAGE_UNAVAILABLE');
  };
  await expect(lock.enable('123456')).rejects.toThrow('STORAGE_UNAVAILABLE');
  expect((await lock.status()).enabled).toBe(false);
});

it('persists an attempt before deriving, so interrupted verification does not reset retries', async () => {
  await lock.enable('123456');
  const interrupted = new PinLock(
    storage,
    async () => {
      throw new Error('INTERRUPTED');
    },
    () => '22'.repeat(32),
    () => now,
  );
  await expect(interrupted.verify('000000')).rejects.toThrow('INTERRUPTED');
  expect((await createLock().status()).attempts).toBe(1);
});
