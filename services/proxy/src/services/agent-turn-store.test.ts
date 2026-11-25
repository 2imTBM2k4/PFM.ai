import { describe, expect, it } from 'vitest';
import {
  AgentTurnStore,
  hashAgentTurnValue,
  type AgentTurnBinding,
} from './agent-turn-store';

const prefixHash = hashAgentTurnValue([
  { role: 'user', content: 'synthetic question' },
]);
const nextHash = hashAgentTurnValue([
  { role: 'user', content: 'synthetic question' },
  { role: 'assistant', content: 'synthetic selection' },
]);
const binding: AgentTurnBinding = {
  identity: { mode: 'authenticated', sub: 'user-A' },
  turnId: 'turn-A',
  userMessageId: 'message-A',
  sessionId: 'session-A',
  scenarioId: 'scenario-A',
  stateRevision: 2,
  model: 'test-model',
  language: 'vi',
  currency: 'VND',
  questionHash: hashAgentTurnValue('synthetic question'),
  policyHash: hashAgentTurnValue({ grants: ['plan_savings_goal'] }),
};
function setup(maxEntries = 1000) {
  let wall = 1_800_000_000_000;
  let tick = 0;
  return {
    store: new AgentTurnStore({
      wallNow: () => wall,
      monotonicNow: () => tick,
      maxEntries,
    }),
    advance(ms: number) {
      wall += ms;
      tick += ms;
    },
    setWall(value: number) {
      wall = value;
    },
  };
}
function started(store: AgentTurnStore, value = binding) {
  const result = store.begin(value, prefixHash);
  if (result.status !== 'accepted') throw new Error('Expected a new turn.');
  expect(store.markModelStarted(result.lease)).toEqual({
    status: 'started',
    timeoutMs: 15_000,
  });
  return result;
}
function continuation(store: AgentTurnStore, value = binding) {
  const first = started(store, value);
  const result = store.checkpoint(first.lease, nextHash);
  if (result.status !== 'issued') throw new Error('Expected a continuation.');
  return { ...result, lease: first.lease };
}

describe('agent turn fingerprints', () => {
  it('hashes JSON objects independently of key insertion order', () => {
    expect(hashAgentTurnValue({ b: 2, a: 1 })).toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    );
    expect(hashAgentTurnValue({ a: 1, b: 2 })).toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    );
  });
  it('keeps array order while sorting nested object keys', () => {
    expect(hashAgentTurnValue([{ b: 2, a: 1 }])).toBe(
      hashAgentTurnValue([{ a: 1, b: 2 }]),
    );
    expect(hashAgentTurnValue([1, 2])).not.toBe(hashAgentTurnValue([2, 1]));
  });
  it.each([
    { label: 'undefined', value: undefined },
    { label: 'NaN', value: NaN },
    { label: 'infinity', value: Infinity },
    { label: 'bigint', value: 1n },
    { label: 'Date', value: new Date(0) },
    { label: 'sparse array', value: new Array(1) },
    { label: 'undefined object property', value: { missing: undefined } },
  ])('rejects non-JSON input: $label', ({ value }) => {
    expect(() => hashAgentTurnValue(value)).toThrow(
      'Invalid turn fingerprint input.',
    );
  });
  it('rejects cycles, excessive depth and oversized UTF-8 rather than trimming evidence', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    let deep: unknown = 1;
    for (let i = 0; i < 34; i++) deep = [deep];
    for (const value of [cycle, deep, 'đ'.repeat(9000)])
      expect(() => hashAgentTurnValue(value)).toThrow(
        'Invalid turn fingerprint input.',
      );
  });
});

describe('agent turn store', () => {
  it('issues a signed continuation after a model step and keeps the absolute deadline', () => {
    const { store, advance } = setup();
    const first = started(store);
    expect(first.deadline).toBe(1_800_000_030_000);
    expect(first.timeoutMs).toBe(15_000);
    advance(14_000);
    const issued = store.checkpoint(first.lease, nextHash);
    expect(issued.status).toBe('issued');
    if (issued.status !== 'issued') return;
    expect(issued.deadline).toBe(first.deadline);
    const second = store.claim(issued.token, binding, {
      prefixHash: nextHash,
      step: 'select',
      successfulTools: 1,
    });
    expect(second).toMatchObject({
      status: 'accepted',
      deadline: first.deadline,
      timeoutMs: 15_000,
    });
  });

  it('refuses a second begin for the same identity and turn ID', () => {
    const { store } = setup();
    started(store);
    expect(store.begin(binding, prefixHash)).toEqual({
      status: 'rejected',
      reason: 'REPLAY',
    });
    expect(store.begin({ ...binding, stateRevision: 3 }, prefixHash)).toEqual({
      status: 'rejected',
      reason: 'REPLAY',
    });
  });

  it.each([
    { sessionId: 'other' },
    { scenarioId: 'other' },
    { stateRevision: 3 },
    { userMessageId: 'other' },
    { turnId: 'other' },
    { model: 'other' },
    { identity: { mode: 'authenticated' as const, sub: 'other' } },
    { identity: { mode: 'guest' as const, deviceId: 'user-A' } },
    { questionHash: hashAgentTurnValue('another question') },
    { policyHash: hashAgentTurnValue('more tools') },
    { language: 'en' as const },
    { currency: 'USD' as const },
  ])(
    'rejects a changed binding %j before consuming its valid token',
    (override) => {
      const { store } = setup();
      const issued = continuation(store);
      expect(
        store.claim(
          issued.token,
          { ...binding, ...override },
          { prefixHash: nextHash, step: 'select', successfulTools: 0 },
        ),
      ).toEqual({ status: 'rejected', reason: 'INVALID_TOKEN' });
      expect(
        store.claim(issued.token, binding, {
          prefixHash: nextHash,
          step: 'select',
          successfulTools: 0,
        }),
      ).toMatchObject({ status: 'accepted' });
    },
  );

  it('rejects an altered transcript prefix without consuming the token', () => {
    const { store } = setup();
    const issued = continuation(store);
    expect(
      store.claim(issued.token, binding, {
        prefixHash,
        step: 'select',
        successfulTools: 0,
      }),
    ).toEqual({ status: 'rejected', reason: 'INVALID_TOKEN' });
    expect(
      store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 0,
      }),
    ).toMatchObject({ status: 'accepted' });
  });

  it('accepts only one of two concurrent uses of the same continuation', async () => {
    const { store } = setup();
    const issued = continuation(store);
    let admitted = 0;
    const consume = async () => {
      const result = store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 0,
      });
      if (result.status === 'accepted') {
        admitted++;
        await Promise.resolve();
      }
      return result.status;
    };
    expect(await Promise.all([consume(), consume()])).toEqual([
      'accepted',
      'rejected',
    ]);
    expect(admitted).toBe(1);
  });

  it('does not issue two different continuations for the same lease', () => {
    const { store } = setup();
    const issued = continuation(store);
    expect(store.checkpoint(issued.lease, nextHash)).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
  });

  it('invalidates continuations after a fresh store simulates a server restart', () => {
    const issued = continuation(setup().store);
    expect(
      setup().store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 0,
      }),
    ).toEqual({ status: 'rejected', reason: 'INVALID_TOKEN' });
  });

  it('does not expose input identifiers or financial source text in decoded tokens', () => {
    const { store } = setup();
    const sensitive = {
      ...binding,
      turnId: 'private-turn-identifier',
      sessionId: 'private-session-identifier',
      questionHash: hashAgentTurnValue('Thu nhập 12000000'),
      policyHash: hashAgentTurnValue({ amount: 12000000 }),
    };
    const issued = continuation(store, sensitive);
    const decoded = Buffer.from(
      issued.token.split('.')[0],
      'base64url',
    ).toString('utf8');
    for (const text of [
      'private-turn-identifier',
      'private-session-identifier',
      '12000000',
      'Thu nhập',
      'test-model',
      'user-A',
    ])
      expect(decoded).not.toContain(text);
  });

  it('permits three selections and one final without resetting limits or deadline', () => {
    const { store } = setup();
    let issued = continuation(store);
    for (let round = 2; round <= 3; round++) {
      const next = store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 1,
      });
      if (next.status !== 'accepted') throw new Error('Expected selection.');
      store.markModelStarted(next.lease);
      const checkpoint = store.checkpoint(next.lease, nextHash);
      if (checkpoint.status !== 'issued')
        throw new Error('Expected checkpoint.');
      issued = { ...checkpoint, lease: next.lease };
    }
    expect(
      store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 1,
      }),
    ).toEqual({ status: 'rejected', reason: 'STEP_LIMIT' });
    const final = store.claim(issued.token, binding, {
      prefixHash: nextHash,
      step: 'final',
      successfulTools: 1,
    });
    if (final.status !== 'accepted') throw new Error('Expected final.');
    expect(store.markModelStarted(final.lease)).toEqual({
      status: 'started',
      timeoutMs: 15_000,
    });
    expect(store.checkpoint(final.lease, nextHash)).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
    expect(store.finish(final.lease, 'completed')).toEqual({
      status: 'closed',
      outcome: 'completed',
      refund: false,
    });
    expect(store.finish(final.lease, 'failed')).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
    expect(
      store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'final',
        successfulTools: 1,
      }),
    ).toEqual({ status: 'rejected', reason: 'REPLAY' });
  });

  it('refuses a final without verified successful tool results', () => {
    const { store } = setup();
    const issued = continuation(store);
    expect(
      store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'final',
        successfulTools: 0,
      }),
    ).toEqual({ status: 'rejected', reason: 'NO_TOOL_RESULT' });
    expect(
      store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 0,
      }),
    ).toMatchObject({ status: 'accepted' });
  });

  it('caps every step to the remaining turn time and expires exactly at 30 seconds', () => {
    const { store, advance } = setup();
    const issued = continuation(store);
    advance(25_000);
    const final = store.claim(issued.token, binding, {
      prefixHash: nextHash,
      step: 'final',
      successfulTools: 1,
    });
    expect(final).toMatchObject({ status: 'accepted', timeoutMs: 5000 });
    if (final.status !== 'accepted') return;
    store.markModelStarted(final.lease);
    advance(5000);
    expect(store.finish(final.lease, 'completed')).toEqual({
      status: 'closed',
      outcome: 'failed',
      refund: true,
    });
  });

  it('rejects an expired waiting token, including the exact expiry instant', () => {
    const { store, advance } = setup();
    const issued = continuation(store);
    advance(30_000);
    expect(
      store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 0,
      }),
    ).toEqual({ status: 'rejected', reason: 'TURN_EXPIRED' });
  });

  it('does not extend turn lifetime when wall clock moves backward', () => {
    const { store, advance, setWall } = setup();
    const issued = continuation(store);
    setWall(1_700_000_000_000);
    advance(30_000);
    expect(
      store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 0,
      }),
    ).toEqual({ status: 'rejected', reason: 'TURN_EXPIRED' });
  });

  it('does not reopen a completed turn for a refund', () => {
    const { store } = setup();
    const issued = continuation(store);
    const final = store.claim(issued.token, binding, {
      prefixHash: nextHash,
      step: 'final',
      successfulTools: 1,
    });
    if (final.status !== 'accepted') throw new Error('Expected final.');
    store.markModelStarted(final.lease);
    store.finish(final.lease, 'completed');
    expect(store.begin(binding, prefixHash)).toEqual({
      status: 'rejected',
      reason: 'REPLAY',
    });
    expect(store.finish(final.lease, 'failed')).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
  });

  it('closes clarification without a model call or a failure refund', () => {
    const { store } = setup();
    const issued = continuation(store);
    const close = store.claim(issued.token, binding, {
      prefixHash: nextHash,
      step: 'close',
      successfulTools: 0,
    });
    if (close.status !== 'accepted') throw new Error('Expected close.');
    expect(close.timeoutMs).toBe(0);
    expect(store.markModelStarted(close.lease)).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
    expect(store.finish(close.lease, 'clarification')).toEqual({
      status: 'closed',
      outcome: 'clarification',
      refund: false,
    });
  });

  it('rejects forged leases and repeated model admission', () => {
    const { store } = setup();
    const first = started(store);
    expect(store.markModelStarted(first.lease)).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
    expect(store.checkpoint({ step: 'select' }, nextHash)).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
    expect(store.finish({ step: 'final' }, 'completed')).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
  });

  it('never reports success for an unfinished selection step', () => {
    const { store } = setup();
    const first = started(store);
    expect(store.finish(first.lease, 'completed')).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
    expect(store.finish(first.lease, 'failed')).toEqual({
      status: 'closed',
      outcome: 'failed',
      refund: true,
    });
  });

  it('blocks new attempts after two failed model turns for five minutes', () => {
    const { store, advance } = setup();
    for (const turnId of ['failure-1', 'failure-2']) {
      const first = started(store, { ...binding, turnId });
      expect(store.finish(first.lease, 'failed')).toEqual({
        status: 'closed',
        outcome: 'failed',
        refund: true,
      });
    }
    const third = { ...binding, turnId: 'third' };
    expect(store.begin(third, prefixHash)).toEqual({
      status: 'rejected',
      reason: 'FAILURE_LIMIT',
    });
    expect(
      store.begin(
        { ...third, identity: { mode: 'authenticated', sub: 'other-user' } },
        prefixHash,
      ),
    ).toMatchObject({ status: 'accepted' });
    advance(300_000);
    expect(store.begin(third, prefixHash)).toMatchObject({
      status: 'accepted',
    });
  });

  it('reserves failure capacity for concurrent turns', () => {
    const { store } = setup();
    const a = started(store, { ...binding, turnId: 'A' });
    const b = started(store, { ...binding, turnId: 'B' });
    expect(store.begin({ ...binding, turnId: 'C' }, prefixHash)).toEqual({
      status: 'rejected',
      reason: 'FAILURE_LIMIT',
    });
    store.finish(a.lease, 'failed');
    store.finish(b.lease, 'failed');
    expect(store.begin({ ...binding, turnId: 'C' }, prefixHash)).toEqual({
      status: 'rejected',
      reason: 'FAILURE_LIMIT',
    });
  });

  it('does not count pre-model failures against the failed-model-attempt guard', () => {
    const { store } = setup();
    for (const turnId of ['A', 'B', 'C']) {
      const first = store.begin({ ...binding, turnId }, prefixHash);
      if (first.status !== 'accepted')
        throw new Error('Expected pre-model turn.');
      expect(store.finish(first.lease, 'failed')).toEqual({
        status: 'closed',
        outcome: 'failed',
        refund: true,
      });
    }
    expect(store.begin({ ...binding, turnId: 'D' }, prefixHash)).toMatchObject({
      status: 'accepted',
    });
  });

  it('counts expired model attempts rather than clearing their failure guard', () => {
    const { store, advance } = setup();
    started(store, { ...binding, turnId: 'A' });
    started(store, { ...binding, turnId: 'B' });
    advance(30_000);
    expect(store.begin({ ...binding, turnId: 'C' }, prefixHash)).toEqual({
      status: 'rejected',
      reason: 'FAILURE_LIMIT',
    });
    advance(300_000);
    expect(store.begin({ ...binding, turnId: 'C' }, prefixHash)).toMatchObject({
      status: 'accepted',
    });
  });

  it('keeps replay tombstones at capacity and reclaims only expired retention records', () => {
    const { store, advance } = setup(1);
    continuation(store);
    const other = {
      ...binding,
      turnId: 'other',
      identity: { mode: 'authenticated' as const, sub: 'other' },
    };
    expect(store.begin(other, prefixHash)).toEqual({
      status: 'rejected',
      reason: 'CAPACITY',
    });
    advance(30_000);
    expect(store.begin(other, prefixHash)).toEqual({
      status: 'rejected',
      reason: 'CAPACITY',
    });
    expect(store.drainExpiredTurns()).toHaveLength(1);
    advance(300_000);
    expect(store.begin(other, prefixHash)).toMatchObject({
      status: 'accepted',
    });
  });

  it('does not let an old internal lease control a reused turn ID after retention', () => {
    const { store, advance } = setup();
    const old = started(store);
    advance(330_000);
    store.drainExpiredTurns();
    const fresh = store.begin(binding, prefixHash);
    expect(fresh.status).toBe('accepted');
    expect(store.finish(old.lease, 'failed')).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
    if (fresh.status === 'accepted')
      expect(store.markModelStarted(fresh.lease)).toEqual({
        status: 'started',
        timeoutMs: 15_000,
      });
  });

  it.each(['', 'not-a-token', 'a.b.c', 'a'.repeat(4097)])(
    'rejects malformed tokens without throwing: %s',
    (token) => {
      expect(
        setup().store.claim(token, binding, {
          prefixHash: nextHash,
          step: 'select',
          successfulTools: 0,
        }),
      ).toEqual({ status: 'rejected', reason: 'INVALID_TOKEN' });
    },
  );

  it('rejects signature and payload tampering without burning the authentic continuation', () => {
    const { store } = setup();
    const issued = continuation(store);
    const [payload, signature] = issued.token.split('.');
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    const altered = Buffer.from(
      JSON.stringify({
        ...decoded,
        selections: 0,
        expiresAt: decoded.expiresAt + 1_000_000,
      }),
    ).toString('base64url');
    for (const token of [
      `${altered}.${signature}`,
      `${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`,
      `${payload}.${signature}=`,
    ]) {
      expect(
        store.claim(token, binding, {
          prefixHash: nextHash,
          step: 'select',
          successfulTools: 0,
        }),
      ).toEqual({ status: 'rejected', reason: 'INVALID_TOKEN' });
    }
    expect(
      store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 0,
      }),
    ).toMatchObject({ status: 'accepted' });
  });

  it('does not resurrect an expiry observed after a forward clock jump and rollback', () => {
    const { store, setWall } = setup();
    const issued = continuation(store);
    setWall(1_800_000_040_000);
    expect(
      store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 0,
      }),
    ).toEqual({ status: 'rejected', reason: 'TURN_EXPIRED' });
    setWall(1_800_000_000_000);
    expect(
      store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 0,
      }),
    ).toEqual({ status: 'rejected', reason: 'REPLAY' });
  });

  it('does not resurrect an expired running lease after a clock rollback', () => {
    const { store, setWall } = setup();
    const first = started(store);
    setWall(1_800_000_040_000);
    expect(store.checkpoint(first.lease, nextHash)).toEqual({
      status: 'rejected',
      reason: 'TURN_EXPIRED',
    });
    setWall(1_800_000_000_000);
    expect(store.checkpoint(first.lease, nextHash)).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
  });

  it('does not allow a final to complete without starting its model step', () => {
    const { store } = setup();
    const issued = continuation(store);
    const final = store.claim(issued.token, binding, {
      prefixHash: nextHash,
      step: 'final',
      successfulTools: 1,
    });
    if (final.status !== 'accepted') throw new Error('Expected final.');
    expect(store.finish(final.lease, 'completed')).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
  });

  it('prevents decreasing success counters or injecting impossible counters', () => {
    const { store } = setup();
    const issued = continuation(store);
    for (const successfulTools of [-1, 0.5, 7, NaN]) {
      expect(
        store.claim(issued.token, binding, {
          prefixHash: nextHash,
          step: 'select',
          successfulTools,
        }),
      ).toEqual({ status: 'rejected', reason: 'INVALID_TOKEN' });
    }
    const next = store.claim(issued.token, binding, {
      prefixHash: nextHash,
      step: 'select',
      successfulTools: 1,
    });
    if (next.status !== 'accepted') throw new Error('Expected selection.');
    store.markModelStarted(next.lease);
    const second = store.checkpoint(next.lease, nextHash);
    if (second.status !== 'issued') throw new Error('Expected checkpoint.');
    expect(
      store.claim(second.token, binding, {
        prefixHash: nextHash,
        step: 'final',
        successfulTools: 0,
      }),
    ).toEqual({ status: 'rejected', reason: 'INVALID_INPUT' });
  });

  it('releases the failure reservation on a successful final', () => {
    const { store } = setup();
    const issued = continuation(store);
    started(store, { ...binding, turnId: 'B' });
    expect(store.begin({ ...binding, turnId: 'C' }, prefixHash)).toMatchObject({
      status: 'rejected',
      reason: 'FAILURE_LIMIT',
    });
    const final = store.claim(issued.token, binding, {
      prefixHash: nextHash,
      step: 'final',
      successfulTools: 1,
    });
    if (final.status !== 'accepted') throw new Error('Expected final.');
    store.markModelStarted(final.lease);
    store.finish(final.lease, 'completed');
    expect(store.begin({ ...binding, turnId: 'C' }, prefixHash)).toMatchObject({
      status: 'accepted',
    });
  });

  it.each([
    { sessionId: '' },
    { scenarioId: '' },
    { stateRevision: -1 },
    { stateRevision: 0.5 },
    { stateRevision: Number.MAX_SAFE_INTEGER + 1 },
    { model: '' },
    { turnId: '' },
    { userMessageId: '' },
    { questionHash: 'not-a-digest' },
    { policyHash: 'not-a-digest' },
  ])('rejects invalid initial binding %j', (override) => {
    expect(
      setup().store.begin({ ...binding, ...override }, prefixHash),
    ).toEqual({ status: 'rejected', reason: 'INVALID_INPUT' });
  });

  it('rejects missing identity and malformed source fingerprints without creating a turn', () => {
    const { store } = setup();
    // @ts-expect-error Exercise untrusted initial input before a route is wired.
    expect(store.begin({ ...binding, identity: null }, prefixHash)).toEqual({
      status: 'rejected',
      reason: 'INVALID_INPUT',
    });
    expect(store.begin(binding, 'bad-prefix')).toEqual({
      status: 'rejected',
      reason: 'INVALID_INPUT',
    });
    expect(store.begin(binding, prefixHash)).toMatchObject({
      status: 'accepted',
    });
  });

  it('does not issue a continuation before the current model step starts', () => {
    const { store } = setup();
    const first = store.begin(binding, prefixHash);
    if (first.status !== 'accepted') throw new Error('Expected new turn.');
    expect(store.checkpoint(first.lease, nextHash)).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
    store.markModelStarted(first.lease);
    expect(store.checkpoint(first.lease, 'bad-prefix')).toEqual({
      status: 'rejected',
      reason: 'INVALID_INPUT',
    });
    expect(store.checkpoint(first.lease, nextHash)).toMatchObject({
      status: 'issued',
    });
  });

  it('keeps a consumed nonce invalid after the next nonce is issued', () => {
    const { store } = setup();
    const first = continuation(store);
    const second = store.claim(first.token, binding, {
      prefixHash: nextHash,
      step: 'select',
      successfulTools: 0,
    });
    if (second.status !== 'accepted') throw new Error('Expected second step.');
    store.markModelStarted(second.lease);
    const issued = store.checkpoint(second.lease, nextHash);
    expect(issued.status).toBe('issued');
    expect(
      store.claim(first.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 0,
      }),
    ).toEqual({ status: 'rejected', reason: 'REPLAY' });
  });

  it('does not let client-provided counters or deadlines into a claim', () => {
    const { store } = setup();
    const issued = continuation(store);
    expect(
      store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'select',
        successfulTools: 0,
        // @ts-expect-error A client must not reset signed deadline or server counters.
        deadline: 9_999_999_999_999,
        selections: 0,
      }),
    ).toEqual({ status: 'rejected', reason: 'INVALID_TOKEN' });
  });

  it('does not mutate the binding or expose its private holding object through a token', () => {
    const { store } = setup();
    const input = structuredClone(binding);
    const before = structuredClone(input);
    const first = started(store, input);
    const issued = store.checkpoint(first.lease, nextHash);
    expect(input).toEqual(before);
    expect(Object.isFrozen(first.lease)).toBe(true);
    if (issued.status !== 'issued') throw new Error('Expected continuation.');
    expect(
      Object.keys(
        JSON.parse(
          Buffer.from(issued.token.split('.')[0], 'base64url').toString('utf8'),
        ),
      ).sort(),
    ).toEqual([
      'binding',
      'expiresAt',
      'finals',
      'key',
      'nonce',
      'prefix',
      'selections',
      'v',
    ]);
  });

  it('reports abandoned expired turns once using only hashed settlement metadata', () => {
    const { store, advance } = setup();
    const first = started(store);
    store.checkpoint(first.lease, nextHash);
    advance(30_000);
    expect(store.drainExpiredTurns()).toEqual([
      {
        turnKeyHash: first.turnKeyHash,
        identityHash: hashAgentTurnValue(binding.identity),
        refund: true,
        modelStarted: true,
      },
    ]);
    expect(store.drainExpiredTurns()).toEqual([]);
    expect(store.finish(first.lease, 'failed')).toEqual({
      status: 'rejected',
      reason: 'INVALID_TRANSITION',
    });
  });

  it('reports expirations detected by a claim, not only by the sweep', () => {
    const { store, advance } = setup();
    const issued = continuation(store);
    advance(30_000);
    store.claim(issued.token, binding, {
      prefixHash: nextHash,
      step: 'select',
      successfulTools: 0,
    });
    expect(store.drainExpiredTurns()).toHaveLength(1);
    expect(store.drainExpiredTurns()).toEqual([]);
  });

  it('retains undelivered expiration settlements beyond tombstone retention', () => {
    const { store, advance } = setup(1);
    const first = started(store);
    store.checkpoint(first.lease, nextHash);
    advance(330_000);
    expect(store.begin({ ...binding, turnId: 'other' }, prefixHash)).toEqual({
      status: 'rejected',
      reason: 'CAPACITY',
    });
    expect(store.drainExpiredTurns()).toMatchObject([
      { turnKeyHash: first.turnKeyHash, refund: true },
    ]);
    expect(
      store.begin({ ...binding, turnId: 'other' }, prefixHash),
    ).toMatchObject({ status: 'accepted' });
  });

  it('does not deliver an automatic refund twice after an explicit finish', () => {
    const { store, advance } = setup();
    const first = started(store);
    advance(30_000);
    expect(store.finish(first.lease, 'failed')).toEqual({
      status: 'closed',
      outcome: 'failed',
      refund: true,
    });
    expect(store.drainExpiredTurns()).toEqual([]);
  });

  it('rejects late model checkpoints at 15 seconds even before the turn expires', () => {
    const { store, advance } = setup();
    const first = started(store);
    advance(15_000);
    expect(store.checkpoint(first.lease, nextHash)).toEqual({
      status: 'rejected',
      reason: 'STEP_EXPIRED',
    });
    expect(store.drainExpiredTurns()).toMatchObject([
      { turnKeyHash: first.turnKeyHash, refund: true },
    ]);
  });

  it('recomputes model timeout at actual admission after preparation time', () => {
    const { store, advance } = setup();
    const first = store.begin(binding, prefixHash);
    if (first.status !== 'accepted') throw new Error('Expected turn.');
    advance(26_000);
    expect(store.markModelStarted(first.lease)).toEqual({
      status: 'started',
      timeoutMs: 4000,
    });
  });

  it('keeps a completed selection alive while waiting for tool results', () => {
    const { store, advance } = setup();
    const issued = continuation(store);
    advance(16_000);
    expect(store.drainExpiredTurns()).toEqual([]);
    expect(
      store.claim(issued.token, binding, {
        prefixHash: nextHash,
        step: 'final',
        successfulTools: 1,
      }),
    ).toMatchObject({ status: 'accepted', timeoutMs: 14_000 });
  });

  it('ignores abandoned reservations that never started a model call', () => {
    const { store, advance } = setup();
    store.begin({ ...binding, turnId: 'A' }, prefixHash);
    store.begin({ ...binding, turnId: 'B' }, prefixHash);
    advance(30_000);
    expect(store.begin({ ...binding, turnId: 'C' }, prefixHash)).toMatchObject({
      status: 'accepted',
    });
  });
});
