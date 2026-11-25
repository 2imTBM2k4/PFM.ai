import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { quotaService } from '../src/services/quota-service';
import { rateLimitService } from '../src/services/rate-limit-service';
import { upstreamAiService } from '../src/services/upstream-ai';

const previous = { ...config };
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const unsigned = [
  { alg: 'RS256', kid: 'quota-test' },
  {
    iss: 'accounts.google.com',
    aud: 'quota-client',
    sub: 'quota-user',
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
]
  .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
  .join('.');
const auth = {
  authorization: `Bearer ${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`,
};
let app: FastifyInstance;
const fetchModel = vi.fn<typeof fetch>();
const toolReply = () =>
  Response.json({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'plan_savings_goal', arguments: '{}' },
            },
          ],
        },
      },
    ],
  });
function agent(index: number) {
  return app.inject({
    method: 'POST',
    url: '/v1/advice/step',
    headers: auth,
    payload: {
      turn: {
        version: 1,
        turnId: `turn-${index}`,
        userMessageId: `m-${index}`,
        sessionId: 's',
        scenarioId: 'scenario',
        stateRevision: 1,
        language: 'vi',
        currency: 'VND',
      },
      messages: [{ role: 'user', content: 'Tính kế hoạch tiết kiệm giúp tôi' }],
      allowedTools: ['plan_savings_goal'],
      allowTools: true,
      stream: false,
    },
  });
}
function legacy(index: number) {
  return app.inject({
    method: 'POST',
    url: '/v1/advice/plan',
    headers: auth,
    payload: {
      requestId: `11111111-2222-4333-8444-${String(index).padStart(12, '0')}`,
      question: 'Quỹ dự phòng là gì?',
    },
  });
}
beforeEach(async () => {
  Object.assign(config, {
    nodeEnv: 'test',
    unlimitedAiTesting: false,
    dailyLimitPerDevice: 1,
    agentModelAllowlist: ['quota-model'],
    modelChainFree: ['quota-model'],
  });
  vi.stubEnv('GOOGLE_WEB_CLIENT_ID', 'quota-client');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        keys: [
          {
            ...publicKey.export({ format: 'jwk' }),
            kid: 'quota-test',
            alg: 'RS256',
          },
        ],
      }),
    ),
  );
  quotaService.resetForTesting();
  rateLimitService.resetForTesting();
  fetchModel.mockReset().mockImplementation(async () => toolReply());
  upstreamAiService.setFetchForTesting(fetchModel);
  app = buildApp({ logger: false });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  upstreamAiService.setFetchForTesting(fetch);
  Object.assign(config, previous);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('blocks an agent during legacy planning, then charges only the verified legacy completion', async () => {
  let complete!: (response: Response) => void;
  fetchModel.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = legacy(1);
  await vi.waitFor(() => expect(fetchModel).toHaveBeenCalledOnce());
  const denied = await agent(1);
  expect(denied.statusCode).toBe(429);
  expect(denied.json().code).toBe('QUOTA_EXCEEDED_DEVICE');
  expect(fetchModel).toHaveBeenCalledOnce();
  complete(
    Response.json({
      choices: [
        {
          message: {
            content: '{"metrics":[],"scenario":{"conversationFacts":[]}}',
          },
        },
      ],
    }),
  );
  const plan = await pending;
  expect(plan.statusCode).toBe(200);
  expect(quotaService.checkQuota('quota-user', 'authenticated').remaining).toBe(
    1,
  );
  fetchModel.mockImplementation(async () =>
    Response.json({
      choices: [
        {
          message: {
            content:
              'Quỹ dự phòng giúp bạn chuẩn bị cho những chi phí bất ngờ.',
          },
        },
      ],
    }),
  );
  const answer = await app.inject({
    method: 'POST',
    url: '/v1/advice/complete',
    headers: auth,
    payload: {
      requestId: '11111111-2222-4333-8444-000000000001',
      question: 'Quỹ dự phòng là gì?',
      planToken: plan.json().planToken,
      results: {},
    },
  });
  expect(answer.statusCode).toBe(200);
  expect(quotaService.checkQuota('quota-user', 'authenticated').remaining).toBe(
    0,
  );
});
it('blocks a legacy model while an agent holds the final daily slot', async () => {
  expect((await agent(1)).statusCode).toBe(200);
  const denied = await legacy(1);
  expect(denied.statusCode).toBe(429);
  expect(denied.json().code).toBe('QUOTA_EXCEEDED_DEVICE');
  expect(fetchModel).toHaveBeenCalledOnce();
});
it('rolls back the sliding reservation after daily denial so three later legacy questions still fit', async () => {
  quotaService.consumeQuota('quota-user', 'authenticated');
  expect((await agent(1)).statusCode).toBe(429);
  quotaService.resetForTesting();
  config.dailyLimitPerDevice = 10;
  fetchModel.mockImplementation(async () =>
    Response.json({
      choices: [
        {
          message: {
            content: '{"metrics":[],"scenario":{"conversationFacts":[]}}',
          },
        },
      ],
    }),
  );
  for (let index = 1; index <= 3; index++)
    expect((await legacy(index)).statusCode).toBe(200);
  expect((await legacy(4)).statusCode).toBe(429);
  expect(fetchModel).toHaveBeenCalledTimes(3);
});
it('reserves the last daily slot atomically between two concurrent agent turns', async () => {
  let complete!: (response: Response) => void;
  fetchModel.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = agent(1);
  await vi.waitFor(() => expect(fetchModel).toHaveBeenCalledOnce());
  expect((await agent(2)).statusCode).toBe(429);
  expect(fetchModel).toHaveBeenCalledOnce();
  complete(toolReply());
  expect((await pending).statusCode).toBe(200);
  expect(quotaService.checkQuota('quota-user', 'authenticated').remaining).toBe(
    0,
  );
});
