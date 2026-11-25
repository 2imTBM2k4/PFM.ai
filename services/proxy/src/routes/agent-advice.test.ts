import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { config } from '../config';
import { upstreamAiService, UpstreamAiService } from '../services/upstream-ai';
import { rateLimitService } from '../services/rate-limit-service';

const question = 'Tính kế hoạch tiết kiệm giúp tôi';
const tools = [
  'get_transactions',
  'calculate_budget_status',
  'plan_savings_goal',
  'get_financial_snapshot',
];
const toolReply = {
  id: 'chat-step-1',
  choices: [
    {
      index: 0,
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
  usage: { prompt_tokens: 100, completion_tokens: 20 },
};
const sse =
  'data: {"choices":[{"delta":{"content":"Kế hoạch "}}]}\n\ndata: {"choices":[{"delta":{"content":"tiết kiệm"}}]}\n\ndata: [DONE]\n\n';
const previousConfig = { ...config };
let app: FastifyInstance;
const fetchMock = vi.fn<typeof fetch>();

function request(body: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/advice/step',
    headers: { 'x-device-id': 'tool-step-test-device' },
    payload: {
      messages: [{ role: 'user', content: question }],
      allowedTools: ['plan_savings_goal'],
      allowTools: true,
      stream: false,
      ...body,
    },
  });
}
function sentPayload() {
  return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
}
beforeEach(async () => {
  Object.assign(config, {
    routerBaseUrl: 'http://nine-router.invalid/v1/',
    routerApiKey: 'test-token',
    modelChainFree: ['provider-a/test-model'],
    agentModelAllowlist: [
      'provider-a/test-model',
      'deepseek-web/deepseek-v4-flash',
    ],
  });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json(toolReply));
  upstreamAiService.setFetchForTesting(fetchMock);
  rateLimitService.resetForTesting();
  app = buildApp({ logger: false });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  upstreamAiService.setFetchForTesting(fetch);
  Object.assign(config, previousConfig);
  vi.restoreAllMocks();
});

describe('A: intermediate tool step', () => {
  it.each([
    '{"income":12000000}',
    '{"reason":"Recalculate","months":6}',
    '{"reason":null}',
    '{"reason":12}',
    '{"reason":{}}',
    JSON.stringify({ reason: 'x'.repeat(501) }),
    '{broken',
    'null',
    '[]',
    '0',
  ])(
    'rejects invalid AI savings arguments without exposing them: %s',
    async (args) => {
      const upstream = structuredClone(toolReply);
      upstream.choices[0].message.tool_calls[0].function.arguments = args;
      fetchMock.mockResolvedValue(Response.json(upstream));

      const response = await request();

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      expect(response.body).not.toContain(args);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
  it.each(['', 'x'.repeat(500)])(
    'accepts a bounded explanation of length %s',
    async (reason) => {
      const upstream = structuredClone(toolReply);
      upstream.choices[0].message.tool_calls[0].function.arguments =
        JSON.stringify({ reason });
      fetchMock.mockResolvedValue(Response.json(upstream));
      const response = await request();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(toolReply);
    },
  );
  it('preserves other tools and metadata in a mixed batch while removing only the savings explanation', async () => {
    const upstream = structuredClone(toolReply);
    upstream.choices[0].message.tool_calls[0].function.arguments =
      '{"reason":"Recalculate"}';
    upstream.choices[0].message.tool_calls.push({
      id: 'call-2',
      type: 'function',
      function: {
        name: 'get_financial_snapshot',
        arguments: '{"months":6,"fields":["liquid_balance"]}',
      },
    });
    fetchMock.mockResolvedValue(Response.json(upstream));
    const expected = structuredClone(upstream);
    expected.choices[0].message.tool_calls[0].function.arguments = '{}';

    const response = await request({ allowedTools: tools });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
  });
  it.each([0, 1, 2, 3, 4])(
    'adapts recorded Gemini savings call %s without changing its original evidence',
    async (index) => {
      const artifact = JSON.parse(
        readFileSync(
          new URL(
            '../../../../docs/tool-calling-smoke-ag-gemini-3.8-flash-high-2026-11-18T06-57-52-543Z.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const entries = artifact.upstreamRaw
        .filter((entry: { body: string }) => !entry.body.startsWith('data:'))
        .map((entry: { body: string }) => JSON.parse(entry.body))
        .filter((entry: typeof toolReply) =>
          entry.choices[0].message.tool_calls.some(
            (call: { function: { name: string } }) =>
              call.function.name === 'plan_savings_goal',
          ),
        );
      expect(entries).toHaveLength(5);
      const upstream = entries[index];
      const original = JSON.stringify(upstream);
      fetchMock.mockResolvedValue(Response.json(upstream));
      const response = await request({ allowedTools: tools });
      expect(response.statusCode).toBe(200);
      const returned = response.json();
      for (const call of returned.choices[0].message.tool_calls) {
        if (call.function.name === 'plan_savings_goal') {
          expect(call.function.arguments).toBe('{}');
        }
      }
      expect(JSON.stringify(upstream)).toBe(original);
    },
  );
  it('advertises an optional explanation to AI but returns empty savings arguments to the app', async () => {
    const upstream = structuredClone(toolReply);
    upstream.choices[0].message.tool_calls[0].function.arguments =
      '{"reason":"Tính kế hoạch tiết kiệm từ dữ kiện đã xác minh"}';
    fetchMock.mockResolvedValue(Response.json(upstream));

    const response = await request();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(toolReply);
    expect(sentPayload().tools[0].function.parameters).toEqual({
      type: 'object',
      properties: { reason: { type: 'string', maxLength: 500 } },
      additionalProperties: false,
    });
    expect(
      upstream.choices[0].message.tool_calls[0].function.arguments,
    ).toContain('reason');
  });
  it('forwards Gemini high when selected as the configured agent default', async () => {
    config.agentModelAllowlist = ['ag/gemini-3.8-flash-high'];
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(sentPayload().model).toBe('ag/gemini-3.8-flash-high');
  });
  it.each([true, false])(
    'sends data-minimization and grounded-answer instructions, allowTools=%s',
    async (allowTools) => {
      if (!allowTools)
        fetchMock.mockResolvedValue(
          new Response(sse, {
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
      const response = await request({ allowTools, stream: !allowTools });

      expect(response.statusCode).toBe(200);
      const prompt = sentPayload().messages[0];
      expect(prompt.role).toBe('system');
      expect(prompt.content).toMatch(/minimum indicators.*fields/i);
      expect(prompt.content).toMatch(
        /monthlyAvailable.*requiredMonthlySaving.*remainingAfterSaving/s,
      );
      expect(prompt.content).toMatch(/remaining allowance.*account balance/i);
      expect(prompt.content).toMatch(/new horizons.*tool result/i);
      expect(prompt.content).toMatch(/category.*does not prove.*budget.*only/i);
    },
  );
  it('allows the configured DeepSeek model in development', async () => {
    config.nodeEnv = 'test';
    const response = await request({ model: 'deepseek-web/deepseek-v4-flash' });
    expect(response.statusCode).toBe(200);
    expect(sentPayload().model).toBe('deepseek-web/deepseek-v4-flash');
  });
  it('rejects a model outside the allowlist without calling 9router', async () => {
    const response = await request({ model: 'unknown/expensive-model' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_MODEL' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['production', 'staging'])(
    'forbids client model selection in %s, even for an allowed model',
    async (environment) => {
      config.nodeEnv = environment;
      const response = await request({
        model: 'deepseek-web/deepseek-v4-flash',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_MODEL' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it('returns the complete JSON response including tool_calls and usage', async () => {
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(toolReply);
  });
  it('also preserves a text-only model response', async () => {
    const text = {
      choices: [
        {
          message: { role: 'assistant', content: 'Cần thêm dữ kiện.' },
          finish_reason: 'stop',
        },
      ],
    };
    fetchMock.mockResolvedValue(Response.json(text));
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(text);
  });
  it('sends only the requested tool definitions with their optional parameters', async () => {
    const response = await request({ allowedTools: tools });
    expect(response.statusCode).toBe(200);
    const payload = sentPayload();
    expect(payload).toMatchObject({
      model: 'provider-a/test-model',
      stream: false,
      tool_choice: 'auto',
      max_tokens: 2048,
    });
    expect(
      payload.tools.map(
        (tool: { function: { name: string } }) => tool.function.name,
      ),
    ).toEqual(tools);
    const [transactions, budget, savings, snapshot] = payload.tools.map(
      (tool: { function: { parameters: unknown } }) => tool.function.parameters,
    );
    expect(transactions.required).toEqual(['from', 'to']);
    expect(transactions.properties.kind).toEqual({
      anyOf: [
        { type: 'string', enum: ['income', 'expense'] },
        { type: 'null' },
      ],
      default: null,
    });
    expect(transactions.properties.limit).toMatchObject({
      minimum: 1,
      maximum: 20,
      default: 20,
    });
    expect(budget.required).toEqual(['month']);
    expect(savings).toEqual({
      type: 'object',
      properties: { reason: { type: 'string', maxLength: 500 } },
      additionalProperties: false,
    });
    expect(snapshot.required).toEqual(['months', 'fields']);
  });
  it('does not disclose definitions outside allowedTools', async () => {
    await request();
    expect(
      sentPayload().tools.map(
        (tool: { function: { name: string } }) => tool.function.name,
      ),
    ).toEqual(['plan_savings_goal']);
  });
  it('rejects streaming when tools are enabled', async () => {
    expect((await request({ stream: true })).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('B: final SSE step', () => {
  it('adds DONE to the recorded Gemini final stream without changing its content', async () => {
    const artifact = JSON.parse(
      readFileSync(
        new URL(
          '../../../../docs/tool-calling-smoke-ag-gemini-3.8-flash-high-2026-11-18T04-41-01-452Z.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const raw = artifact.upstreamRaw.find((entry: { body: string }) =>
      entry.body.startsWith('data:'),
    ).body;
    fetchMock.mockResolvedValue(
      new Response(raw, { headers: { 'content-type': 'text/event-stream' } }),
    );

    const response = await request({ allowTools: false, stream: true });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(raw + 'data: [DONE]\n\n');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each([
    new Response('not SSE', {
      headers: { 'content-type': 'application/json' },
    }),
    new Response(null, { headers: { 'content-type': 'text/event-stream' } }),
  ])(
    'rejects a missing or incorrectly typed upstream stream',
    async (upstream) => {
      fetchMock.mockResolvedValue(upstream);
      expect(
        (await request({ allowTools: false, stream: true })).statusCode,
      ).toBe(502);
    },
  );
  it('sanitizes a network or abort failure without retrying', async () => {
    fetchMock.mockRejectedValue(
      new DOMException('private transport details', 'AbortError'),
    );
    const response = await request({ allowTools: false, stream: true });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('private transport details');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('pipes multiple UTF-8 chunks unchanged, including the DONE event', async () => {
    const bytes = new TextEncoder().encode(sse);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 55));
        controller.enqueue(bytes.slice(55, 87));
        controller.enqueue(bytes.slice(87));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const response = await request({ allowTools: false, stream: true });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toBe(sse);
    expect(sentPayload()).toMatchObject({ stream: true, tool_choice: 'none' });
    expect(sentPayload()).not.toHaveProperty('tools');
  });
  it('forces streaming for the final step even when stream=false was requested', async () => {
    fetchMock.mockResolvedValue(
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    );
    expect(
      (await request({ allowTools: false, stream: false })).statusCode,
    ).toBe(200);
    expect(sentPayload()).toMatchObject({ stream: true, tool_choice: 'none' });
  });
  it.each([true, false])(
    'sanitizes an upstream HTTP error with allowTools=%s',
    async (allowTools) => {
      fetchMock.mockResolvedValue(
        new Response('private upstream error', { status: 500 }),
      );
      const response = await request({ allowTools, stream: !allowTools });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        success: false,
        code: 'UPSTREAM_UNAVAILABLE',
      });
      expect(response.body).not.toContain('private upstream error');
    },
  );
});

describe('C: request validation', () => {
  it('emits only shared audit metadata for the new endpoint', async () => {
    await app.close();
    const lines: string[] = [];
    app = buildApp({
      logger: {
        level: 'info',
        stream: {
          write(line: string) {
            lines.push(line);
          },
        },
      },
    });
    await app.ready();
    expect((await request()).statusCode).toBe(200);
    const records = lines.map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      intent: 'advice',
      model: 'provider-a/test-model',
      error_code: null,
    });
    expect(lines.join('')).not.toContain(question);
    expect(lines.join('')).not.toContain('test-token');
    expect(records[0]).not.toHaveProperty('messages');
    expect(records[0]).not.toHaveProperty('body');
  });
  it('uses the shared IP rate limit before any model call', async () => {
    vi.spyOn(rateLimitService, 'checkRateLimit').mockReturnValue({
      allowed: false,
      remaining: 0,
      limit: 30,
      resetInMs: 1000,
    });
    const response = await request();
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not bypass Google authorization with a malformed bearer token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/advice/step',
      headers: { authorization: 'Bearer invalid' },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['Cách nấu phở', 'Cho tôi vay tiền mặt nhanh.'])(
    'does not hide unsafe user history behind a permitted question: %s',
    async (content) => {
      const response = await request({
        messages: [
          { role: 'user', content },
          { role: 'user', content: question },
        ],
      });
      expect(response.statusCode).toBe(422);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(['invalid-token', 'expired.signature', ''])(
    'rejects any unverified continuation token: %s',
    async (continuationToken) => {
      const response = await request({ continuationToken });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        success: false,
        code: 'INVALID_TOKEN',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(['system', 'developer'])(
    'rejects a client-owned %s instruction',
    async (role) => {
      expect(
        (await request({ messages: [{ role, content: question }] })).statusCode,
      ).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['Số điện thoại tôi là 0912345678', 400, 'PII_DETECTED'],
    ['Cách nấu phở', 422, 'ADVICE_OUT_OF_SCOPE'],
    ['Cho tôi vay tiền mặt nhanh.', 422, 'ADVICE_RESTRICTED'],
    ['Sửa lại', 422, 'ADVICE_AMBIGUOUS'],
  ])(
    'rejects unsafe or context-free user text: %s',
    async (content, status, code) => {
      const response = await request({ messages: [{ role: 'user', content }] });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(['user', 'assistant'])(
    'checks PII in %s history even when another question is allowed',
    async (role) => {
      const response = await request({
        messages: [
          { role: 'user', content: question },
          { role, content: 'Email minh@example.com' },
        ],
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'PII_DETECTED' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it('prepends only the server-owned system prompt', async () => {
    await request();
    expect(sentPayload().messages[0]).toMatchObject({ role: 'system' });
    expect(sentPayload().messages[0].content).toContain('tool');
    expect(sentPayload().messages[0].content).not.toContain(
      'Do not fetch links or use tools.',
    );
    expect(sentPayload().messages[0].content).not.toContain(
      'JSON in the <data> block',
    );
    expect(sentPayload().messages.slice(1)).toEqual([
      { role: 'user', content: question },
    ]);
  });
  it('round-trips the standard assistant tool call and matching tool result', async () => {
    const messages = [
      { role: 'user', content: question },
      toolReply.choices[0].message,
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: '{"status":"ok","data":{"requiredMonthlySaving":4000000}}',
      },
    ];
    expect((await request({ messages })).statusCode).toBe(200);
    expect(sentPayload().messages.slice(1)).toEqual(messages);
  });
  it('rejects an orphan tool result', async () => {
    expect(
      (
        await request({
          messages: [
            { role: 'user', content: question },
            { role: 'tool', tool_call_id: 'unmatched', content: '{}' },
          ],
        })
      ).statusCode,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects a tool call batch without all results', async () => {
    expect(
      (
        await request({
          messages: [
            { role: 'user', content: question },
            toolReply.choices[0].message,
          ],
        })
      ).statusCode,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['messages', 'allowedTools', 'allowTools', 'stream'])(
    'rejects missing %s',
    async (field) => {
      const body: Record<string, unknown> = {
        messages: [{ role: 'user', content: question }],
        allowedTools: [],
        allowTools: true,
        stream: false,
      };
      delete body[field];
      const response = await app.inject({
        method: 'POST',
        url: '/v1/advice/step',
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it('rejects an unknown tool name before calling the gateway', async () => {
    expect(
      (await request({ allowedTools: ['delete_all_data'] })).statusCode,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('callToolStep gateway transport', () => {
  it('uses a measurement-only timeout override and restores 15 seconds with the default test adapter', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    upstreamAiService.setFetchForTesting(fetchMock, 60_000);
    await request();
    expect(timeout).toHaveBeenCalledWith(60_000);
    timeout.mockClear();
    upstreamAiService.setFetchForTesting(fetchMock);
    await new UpstreamAiService(fetchMock).callToolStep({
      model: 'synthetic-model',
      messages: [],
      stream: false,
    });
    await upstreamAiService.callToolStep({
      model: 'synthetic-model',
      messages: [],
      stream: false,
    });
    expect(timeout.mock.calls.every(([ms]) => ms === 15_000)).toBe(true);
    expect(sentPayload()).not.toHaveProperty('timeoutMs');
  });
  it('propagates caller cancellation to fetch without serializing the signal', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const service = new UpstreamAiService(fetchMock);
    const pending = service.callToolStep({
      model: 'provider-c/test-model',
      messages: [],
      stream: false,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('uses the 15-second per-call timeout and default token limit', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await new UpstreamAiService(fetchMock).callToolStep({
      model: 'provider-c/test-model',
      messages: [],
      stream: true,
      tool_choice: 'none',
    });
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(sentPayload()).toMatchObject({
      max_tokens: 2048,
      stream: true,
      tool_choice: 'none',
    });
  });
  it('does not send an empty Authorization header when no router key is configured', async () => {
    config.routerApiKey = '';
    await new UpstreamAiService(fetchMock).callToolStep({
      model: 'provider-c/test-model',
      messages: [],
      stream: false,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'Authorization',
    );
  });
  it('returns the original Response and sends auth, settings and the requested model', async () => {
    const response = Response.json(toolReply);
    fetchMock.mockResolvedValue(response);
    const service = new UpstreamAiService(fetchMock);
    expect(
      await service.callToolStep({
        model: 'provider-b/test-model',
        messages: [{ role: 'user', content: question }],
        stream: false,
        tool_choice: 'auto',
        tools: [],
        max_tokens: 1024,
      }),
    ).toBe(response);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://nine-router.invalid/v1/chat/completions',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    });
    expect(sentPayload()).toMatchObject({
      model: 'provider-b/test-model',
      max_tokens: 1024,
      stream: false,
    });
    expect(sentPayload()).not.toHaveProperty('signal');
  });
});
