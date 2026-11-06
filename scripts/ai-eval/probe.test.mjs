import { expect, it, vi } from 'vitest';
import { probeRouter } from './probe.mjs';

const options = {
  baseUrl: 'http://127.0.0.1:20128/v1',
  apiKey: 'TEST_SECRET',
  model: 'cx/test',
};

it('measures the full answer body rather than headers alone', async () => {
  let time = 100;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
  try {
    const result = await probeRouter(options, async () => {
      time = 110;
      return {
        status: 200,
        ok: true,
        json: async () => {
          time = 250;
          return { choices: [{ message: { content: 'OK' } }] };
        },
      };
    });
    expect(result.latencyMs).toBe(150);
  } finally {
    clock.mockRestore();
  }
});

it('sends only a fixed synthetic prompt to the pinned local model and returns metadata', async () => {
  const send = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          model: 'cx/test',
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }),
        { status: 200 },
      ),
  );
  const result = await probeRouter(options, send);
  const [url, request] = send.mock.calls[0];
  expect(url).toBe('http://127.0.0.1:20128/v1/chat/completions');
  expect(request.headers.Authorization).toBe('Bearer TEST_SECRET');
  expect(request.redirect).toBe('error');
  expect(JSON.parse(request.body)).toEqual({
    model: 'cx/test',
    messages: [{ role: 'user', content: 'Trả lời duy nhất chữ OK.' }],
    max_tokens: 128,
    stream: false,
  });
  expect(result).toMatchObject({
    status: 200,
    replyMatches: true,
    promptTokens: 10,
    completionTokens: 1,
  });
  expect(JSON.stringify(result)).not.toContain('TEST_SECRET');
});

it('reports an auth failure without echoing response bodies or retrying', async () => {
  const send = vi.fn(
    async () => new Response('TEST_SECRET PRIVATE_BODY', { status: 401 }),
  );
  const result = await probeRouter(options, send);
  expect(send).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ status: 401, replyMatches: false });
  expect(JSON.stringify(result)).not.toMatch(/TEST_SECRET|PRIVATE_BODY/);
});

it.each([
  { ...options, baseUrl: 'https://example.com/v1' },
  { ...options, baseUrl: 'http://secret@localhost:20128/v1' },
  { ...options, baseUrl: 'http://localhost:20128/v1?key=secret' },
  { ...options, apiKey: '' },
  { ...options, model: '' },
])('rejects unsafe or missing configuration before sending', async (input) => {
  const send = vi.fn();
  await expect(probeRouter(input, send)).rejects.toThrow(
    'PROBE_CONFIG_INVALID',
  );
  expect(send).not.toHaveBeenCalled();
});

it('does not treat an empty model reply as a successful probe', async () => {
  const result = await probeRouter(
    options,
    async () => new Response(JSON.stringify({ choices: [] })),
  );
  expect(result.replyMatches).toBe(false);
});

it('never includes transport errors in its output', async () => {
  await expect(
    probeRouter(options, async () => {
      throw new Error('TEST_SECRET');
    }),
  ).rejects.toThrow(/^PROBE_CONNECTION_FAILED$/);
});
