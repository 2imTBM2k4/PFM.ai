import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { quotaService } from '../src/services/quota-service';
import { rateLimitService } from '../src/services/rate-limit-service';
import { upstreamAiService } from '../src/services/upstream-ai';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwtInput = [
  { alg: 'RS256', kid: 'test' },
  {
    iss: 'accounts.google.com',
    aud: 'client',
    sub: 'verified-google-user',
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
]
  .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
  .join('.');
const jwt = `${jwtInput}.${sign('RSA-SHA256', Buffer.from(jwtInput), privateKey).toString('base64url')}`;
const originalLimit = config.dailyLimitPerDevice;
const originalUnlimited = config.unlimitedAiTesting;
afterEach(() => {
  config.dailyLimitPerDevice = originalLimit;
  config.unlimitedAiTesting = originalUnlimited;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('binds plans and daily quota to the verified subject across devices, preventing a guest from reusing the plan', async () => {
  vi.stubEnv('GOOGLE_WEB_CLIENT_ID', 'client');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            keys: [
              {
                ...publicKey.export({ format: 'jwk' }),
                kid: 'test',
                alg: 'RS256',
              },
            ],
          }),
        ),
    ),
  );
  config.unlimitedAiTesting = false;
  config.dailyLimitPerDevice = 1;
  quotaService.resetForTesting();
  rateLimitService.resetForTesting();
  upstreamAiService.setFetchForTesting(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  metrics: [],
                  groups: [],
                  scenario: { conversationFacts: [] },
                }),
              },
            },
          ],
        }),
      ),
  );
  const app = buildApp({ logger: false });
  const input = {
    requestId: '11111111-2222-4333-8444-555555555555',
    question: 'Ngân sách là gì?',
  };
  const headers = {
    authorization: `Bearer ${jwt}`,
    'x-device-id': 'device-one',
  };
  try {
    const plan = await app.inject({
      method: 'POST',
      url: '/v1/advice/plan',
      headers,
      payload: input,
    });
    expect(plan.statusCode).toBe(200);
    const payload = { ...input, planToken: plan.json().planToken, results: {} };
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/advice/complete',
      headers: { 'x-device-id': 'verified-google-user' },
      payload,
    });
    expect(forged.statusCode).toBe(400);
    upstreamAiService.setFetchForTesting(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Ngân sách giúp phân bổ thu nhập theo nhu cầu.',
                },
              },
            ],
          }),
        ),
    );
    const complete = await app.inject({
      method: 'POST',
      url: '/v1/advice/complete',
      headers: { ...headers, 'x-device-id': 'device-two' },
      payload,
    });
    expect(complete.statusCode).toBe(200);
    expect(quotaService.checkQuota('verified-google-user', 'authenticated').remaining).toBe(0);
    const limited = await app.inject({
      method: 'POST',
      url: '/v1/advice/plan',
      headers,
      payload: input,
    });
    expect(limited.statusCode).toBe(429);
  } finally {
    await app.close();
  }
});
