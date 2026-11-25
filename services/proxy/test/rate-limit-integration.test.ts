import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { rateLimitService } from '../src/services/rate-limit-service';
import { quotaService } from '../src/services/quota-service';
import { upstreamAiService } from '../src/services/upstream-ai';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwtBody = [
  { alg: 'RS256', kid: 'rate-test' },
  {
    iss: 'accounts.google.com',
    aud: 'rate-client',
    sub: 'verified-rate-user',
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
]
  .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
  .join('.');
const token = `${jwtBody}.${sign('RSA-SHA256', Buffer.from(jwtBody), privateKey).toString('base64url')}`;
const saved = {
  unlimited: config.unlimitedAiTesting,
  nodeEnv: config.nodeEnv,
  chain: config.modelChainFree,
};
const auth = { authorization: `Bearer ${token}` };
const payload = (index: number) => ({
  requestId: `11111111-2222-4333-8444-${String(index).padStart(12, '0')}`,
  question: 'Quỹ dự phòng là gì?',
});
const modelReply = (content: string) =>
  new Response(
    JSON.stringify({
      model: 'rate-model',
      choices: [{ message: { content } }],
    }),
  );
let modelCalls = 0;
beforeEach(() => {
  config.unlimitedAiTesting = true;
  config.nodeEnv = 'test';
  config.modelChainFree = ['rate-model'];
  rateLimitService.resetForTesting();
  quotaService.resetForTesting();
  modelCalls = 0;
  vi.stubEnv('GOOGLE_WEB_CLIENT_ID', 'rate-client');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            keys: [
              {
                ...publicKey.export({ format: 'jwk' }),
                kid: 'rate-test',
                alg: 'RS256',
              },
            ],
          }),
        ),
    ),
  );
  upstreamAiService.setFetchForTesting(async () => {
    modelCalls++;
    return modelReply(
      JSON.stringify({
        metrics: [],
        scenario: { conversationFacts: [] },
        groups: [],
      }),
    );
  });
});
afterEach(() => {
  config.unlimitedAiTesting = saved.unlimited;
  config.nodeEnv = saved.nodeEnv;
  config.modelChainFree = saved.chain;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it('enforces the authenticated sliding window through HTTP, shares devices and rounds up', async () => {
  let clock = Date.now();
  const beginning = clock;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const app = buildApp();
  try {
    for (const [index, second] of [0, 60, 120].entries()) {
      clock = beginning + second * 1000;
      const response = await app.inject({
        method: 'POST',
        url: '/v1/advice/plan',
        headers: { ...auth, 'x-device-id': String(index) },
        payload: payload(index),
      });
      expect(response.statusCode).toBe(200);
    }
    clock = beginning + 240_001;
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/advice/plan',
      headers: auth,
      payload: payload(4),
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(modelCalls).toBe(3);
    clock = beginning + 421_000;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/advice/plan',
          headers: auth,
          payload: payload(5),
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
  }
});
it('counts plan and completion once, refunds a failed completion, and isolates guest login', async () => {
  const app = buildApp();
  const headers = { 'x-device-id': 'verified-rate-user' };
  try {
    const plan = await app.inject({
      method: 'POST',
      url: '/v1/advice/plan',
      headers,
      payload: payload(1),
    });
    expect(plan.statusCode).toBe(200);
    upstreamAiService.setFetchForTesting(async () => {
      throw new Error('PRIVATE timeout amount 123');
    });
    const failed = await app.inject({
      method: 'POST',
      url: '/v1/advice/complete',
      headers,
      payload: { ...payload(1), planToken: plan.json().planToken, results: {} },
    });
    expect(failed.statusCode).toBe(503);
    upstreamAiService.setFetchForTesting(async () =>
      modelReply(
        JSON.stringify({
          metrics: [],
          scenario: { conversationFacts: [] },
          groups: [],
        }),
      ),
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/advice/plan',
          headers,
          payload: payload(2),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/advice/plan',
          headers,
          payload: payload(3),
        })
      ).statusCode,
    ).toBe(429);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/advice/plan',
          headers: { 'x-device-id': 'new-device' },
          payload: payload(3),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/advice/plan',
          headers: auth,
          payload: payload(3),
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
  }
});
it('logs verified bypass use, never bypasses guests, and keeps the IP limit even in testing', async () => {
  vi.stubEnv('RATE_LIMIT_BYPASS_SUBS', 'verified-rate-user,guest-device');
  const records: string[] = [];
  const app = buildApp({
    logger: {
      stream: {
        write: (line) => {
          records.push(line);
        },
      },
    },
  });
  try {
    for (let i = 0; i < 4; i++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/advice/plan',
            headers: auth,
            payload: payload(i),
          })
        ).statusCode,
      ).toBe(200);
    expect(records.slice(0, 4).map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bypass_used: true,
          auth_mode: 'authenticated',
        }),
      ]),
    );
    const headers = { 'x-device-id': 'guest-device' };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/advice/plan',
          headers,
          payload: payload(5),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/advice/plan',
          headers,
          payload: payload(6),
        })
      ).json().code,
    ).toBe('GUEST_RATE_LIMIT_EXCEEDED');
    for (let i = 6; i < 30; i++)
      await app.inject({
        method: 'POST',
        url: '/v1/advice/plan',
        headers: auth,
        payload: payload(i + 1),
      });
    const ipBlocked = await app.inject({
      method: 'POST',
      url: '/v1/advice/plan',
      headers: auth,
      payload: payload(31),
    });
    expect(ipBlocked.statusCode).toBe(429);
    expect(Number(ipBlocked.headers['retry-after'])).toBeGreaterThan(300);
    expect(modelCalls).toBe(29);
    const wire = records.join('');
    for (const secret of [
      'verified-rate-user',
      'guest-device',
      token,
      'amount',
      'device_id',
      'hash',
      'sub',
    ])
      expect(wire).not.toContain(secret);
  } finally {
    await app.close();
  }
});
it('shares the guest quota between receipt vision and text without logging image or receipt data', async () => {
  const previous = config.receiptVisionModel;
  config.receiptVisionModel = 'vision-test';
  const records: string[] = [];
  const app = buildApp({
    logger: {
      stream: {
        write: (line) => {
          records.push(line);
        },
      },
    },
  });
  try {
    upstreamAiService.setFetchForTesting(async () => {
      modelCalls++;
      return modelReply(
        JSON.stringify({
          merchant: 'PRIVATE-MERCHANT',
          totalMinor: 87000,
          currency: 'VND',
          occurredOn: '2026-11-16',
          categoryKey: null,
        }),
      );
    });
    const headers = { 'x-device-id': 'receipt-guest' };
    const scan = await app.inject({
      method: 'POST',
      url: '/v1/receipts/scan',
      headers,
      payload: { imageBase64: '/9j/2Q==', mimeType: 'image/jpeg' },
    });
    expect(scan.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/advice/plan',
          headers,
          payload: payload(1),
        })
      ).statusCode,
    ).toBe(429);
    expect(modelCalls).toBe(1);
    const log = JSON.parse(records[0]);
    expect(log.intent).toBe('entry');
    expect(log.model).toBe('vision-test');
    expect(Object.keys(log)).toHaveLength(9);
    for (const secret of [
      'PRIVATE-MERCHANT',
      '87000',
      '/9j/2Q==',
      'receipt-guest',
      'image_url',
      'amount',
      'hash',
    ])
      expect(records.join('')).not.toContain(secret);
  } finally {
    config.receiptVisionModel = previous;
    await app.close();
  }
});
