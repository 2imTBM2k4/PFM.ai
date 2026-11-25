import { expect, it } from 'vitest';
import { SlidingMessageLimit } from '../src/middleware/rate-limit';

const user = { mode: 'authenticated' as const, sub: 'google-user' };
const guest = { mode: 'guest' as const, deviceId: 'device' };
it('slides from the oldest counted message and rounds Retry-After up', () => {
  let time = 0;
  const limit = new SlidingMessageLimit(() => time);
  for (const second of [0, 60, 120]) {
    time = second * 1000;
    const admission = limit.reserve(user, String(second));
    expect(admission.allowed).toBe(true);
    if (admission.allowed) admission.finish(true);
  }
  time = 240_000;
  expect(limit.reserve(user, 'four')).toEqual({
    allowed: false,
    retryAfter: 60,
  });
  time = 240_001;
  expect(limit.reserve(user, 'four')).toEqual({
    allowed: false,
    retryAfter: 60,
  });
  time = 300_001;
  expect(limit.reserve(user, 'four').allowed).toBe(true);
  time = 421_001;
  expect(limit.reserve(user, 'five').allowed).toBe(true);
});
it('isolates guest devices and Google subjects, and does not reset an existing subject on login', () => {
  const limit = new SlidingMessageLimit();
  const first = limit.reserve(guest, 'one');
  if (first.allowed) first.finish(true);
  expect(limit.reserve(guest, 'two').allowed).toBe(false);
  expect(limit.reserve({ ...guest, deviceId: 'other' }, 'two').allowed).toBe(
    true,
  );
  const sameStringUser = { mode: 'authenticated' as const, sub: 'device' };
  for (let i = 0; i < 3; i++) {
    const admission = limit.reserve(sameStringUser, String(i));
    expect(admission.allowed).toBe(true);
    if (admission.allowed) admission.finish(true);
  }
  expect(limit.reserve(sameStringUser, 'again').allowed).toBe(false);
});
it('counts the plan and completion once, refunds failures, and reserves concurrent slots', () => {
  const limit = new SlidingMessageLimit();
  const plan = limit.reserve(guest, 'message', undefined, 'plan');
  if (plan.allowed) plan.finish(true);
  const completion = limit.reserve(guest, 'message', undefined, 'complete');
  expect(completion.allowed).toBe(true);
  if (completion.allowed) completion.finish(false, true);
  const retry = limit.reserve(guest, 'retry');
  expect(retry.allowed).toBe(true);
  expect(limit.reserve(guest, 'concurrent').allowed).toBe(false);
  if (retry.allowed) retry.finish(false);
  expect(limit.reserve(guest, 'new').allowed).toBe(true);
});
it('permits only verified Google bypass subjects in dev/test, never a guest or production', () => {
  const limit = new SlidingMessageLimit();
  const environment = {
    nodeEnv: 'development',
    bypassSubs: 'google-user,device',
  };
  expect(limit.reserve(user, 'one', environment)).toMatchObject({
    allowed: true,
    bypassUsed: true,
  });
  const first = limit.reserve(guest, 'one', environment);
  if (first.allowed) first.finish(true);
  expect(limit.reserve(guest, 'two', environment).allowed).toBe(false);
  for (let i = 0; i < 3; i++) {
    const result = limit.reserve(user, String(i), {
      ...environment,
      nodeEnv: 'production',
    });
    if (result.allowed) result.finish(true);
  }
  expect(
    limit.reserve(user, 'four', { ...environment, nodeEnv: 'production' })
      .allowed,
  ).toBe(false);
});
it('does not let replaying the same model stage create unlimited provider calls', () => {
  const limit = new SlidingMessageLimit();
  const environment = { nodeEnv: 'production', bypassSubs: '' };
  const plan = limit.reserve(guest, 'same', environment, 'plan');
  if (plan.allowed) plan.finish(true);
  expect(limit.reserve(guest, 'same', environment, 'plan').allowed).toBe(false);
  const completion = limit.reserve(guest, 'same', environment, 'complete');
  expect(completion.allowed).toBe(true);
  if (completion.allowed) completion.finish(true);
  expect(limit.reserve(guest, 'same', environment, 'complete').allowed).toBe(
    false,
  );
});
