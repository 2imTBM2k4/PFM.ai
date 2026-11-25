import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { upstreamAiService } from '../src/services/upstream-ai';
import { config } from '../src/config';

afterEach(() => {
  vi.restoreAllMocks();
});
it('logs exactly nine whitelisted metadata fields for success and rejection without payloads or credentials', async () => {
  const records: string[] = [];
  const app = buildApp({
    logger: { stream: { write: (line: string) => records.push(line) } },
  });
  let stage = 0;
  upstreamAiService.setFetchForTesting(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  stage++ === 0
                    ? JSON.stringify({
                        metrics: [],
                        scenario: { conversationFacts: [] },
                        groups: [],
                      })
                    : 'Ngân sách là cách phân bổ thu nhập.',
              },
            },
          ],
        }),
      ),
  );
  const payload = {
    requestId: '11111111-2222-4333-8444-555555555555',
    question: 'Ngân sách là gì?',
  };
  try {
    const plan = await app.inject({
      method: 'POST',
      url: '/v1/advice/plan',
      headers: { 'x-device-id': 'private-device' },
      payload,
    });
    expect(plan.statusCode).toBe(200);
    await app.inject({
      method: 'POST',
      url: '/v1/advice/complete',
      headers: { 'x-device-id': 'private-device' },
      payload: { ...payload, planToken: plan.json().planToken, results: {} },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/advice/plan',
      headers: { authorization: 'Bearer SECRET-TOKEN' },
      payload,
    });
    const logs = records.map((record) => JSON.parse(record));
    expect(logs).toHaveLength(3);
    for (const log of logs) {
      expect(Object.keys(log).sort()).toEqual(
        [
          'request_id',
          'model',
          'latency_ms',
          'intent',
          'tool_calls',
          'fallback_used',
          'bypass_used',
          'auth_mode',
          'error_code',
        ].sort(),
      );
      expect(log.auth_mode).toBe('guest');
      expect(log.latency_ms).toBeGreaterThanOrEqual(0);
    }
    expect(logs[2].error_code).toBe('INVALID_TOKEN');
    const wire = records.join('');
    for (const secret of [
      'private-device',
      'SECRET-TOKEN',
      'Ngân sách là gì?',
      'amount',
      'device_id',
      'wallet_id',
      'merchant',
      'hash',
      'sub',
    ])
      expect(wire).not.toContain(secret);
  } finally {
    await app.close();
  }
});
it('does not print raw provider errors, and requests bounded output tokens', async () => {
  const consoleError = vi.spyOn(console, 'error');
  const previous = config.modelChainFree;
  config.modelChainFree = ['test-model'];
  try {
    upstreamAiService.setFetchForTesting(async (_url, options) => {
      expect(JSON.parse(options!.body as string).max_tokens).toBe(2048);
      throw new Error('PRIVATE amount 999 merchant secret');
    });
    await expect(
      upstreamAiService.callPrompt('system', 'private'),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    config.modelChainFree = previous;
  }
});
