import { expect, it, vi } from 'vitest';
import { completeDirectProvider } from './direct-provider.mjs';

const config = {
  provider: 'cloudflare',
  accountId: 'a'.repeat(32),
  apiKey: 'SECRET_TEST_KEY',
  model: '@cf/zai-org/glm-4.7-flash',
  messages: [{ role: 'user', content: 'Synthetic question' }],
};

it('uses the fixed Cloudflare endpoint and keeps the key out of results', async () => {
  const send = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      model: config.model,
      choices: [{ message: { content: 'Câu trả lời' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 7 },
    }),
  });
  const result = await completeDirectProvider(config, send);
  expect(send.mock.calls[0][0]).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1/chat/completions`,
  );
  expect(result).toMatchObject({
    status: 200,
    answer: 'Câu trả lời',
    promptTokens: 4,
  });
  expect(JSON.stringify(result)).not.toContain(config.apiKey);
});

it('uses Groq only when selected and rejects unknown or malformed destinations', async () => {
  const send = vi.fn().mockResolvedValue({ ok: false, status: 429 });
  expect(
    (await completeDirectProvider({ ...config, provider: 'groq' }, send))
      .status,
  ).toBe(429);
  expect(send.mock.calls[0][0]).toBe(
    'https://api.groq.com/openai/v1/chat/completions',
  );
  for (const invalid of [
    { provider: 'unknown' },
    { accountId: 'https://attacker.example' },
    { apiKey: '' },
    { model: 'bad model' },
  ])
    await expect(
      completeDirectProvider({ ...config, ...invalid }, send),
    ).rejects.toThrow('EVAL_CONFIG_INVALID');
  expect(send).toHaveBeenCalledOnce();
});
