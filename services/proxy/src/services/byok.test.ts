import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { parseByokHeaders, validateByokBaseUrl } from './byok';
import { upstreamAiService } from './upstream-ai';

describe('BYOK validation & SSRF protection', () => {
  it('accepts valid HTTPS OpenAI-compatible provider URLs and strips trailing slashes', () => {
    expect(validateByokBaseUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1',
    );
    expect(
      validateByokBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai'),
    ).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(validateByokBaseUrl('https://openrouter.ai/api/v1///')).toBe(
      'https://openrouter.ai/api/v1',
    );
  });

  it.each([
    'http://api.openai.com/v1',
    'https://localhost/v1',
    'https://sub.localhost/v1',
    'https://127.0.0.1/v1',
    'https://10.0.0.5/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://172.16.0.1/v1',
    'https://192.168.1.10/v1',
    'https://[::1]/v1',
    'https://metadata.google.internal/v1',
    'https://2130706433/v1',
    'https://user:pass@api.openai.com/v1',
  ])('rejects unsafe or non-HTTPS URL: %s', (badUrl) => {
    expect(() => validateByokBaseUrl(badUrl)).toThrow();
  });

  it('returns null when no BYOK headers are provided and rejects partial headers', () => {
    expect(parseByokHeaders({})).toBeNull();
    expect(() =>
      parseByokHeaders({ 'x-byok-api-key': 'sk-only' }),
    ).toThrow();
    expect(
      parseByokHeaders({
        'x-byok-base-url': 'https://api.openai.com/v1/',
        'x-byok-api-key': 'sk-test-secret-123',
        'x-byok-model': 'gpt-4o-mini',
      }),
    ).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-secret-123',
      model: 'gpt-4o-mini',
    });
  });
});

describe('BYOK proxy endpoints, CORS & key privacy', () => {
  afterEach(() => {
    upstreamAiService.setFetchForTesting(fetch);
  });

  it('allows BYOK headers in CORS preflight', async () => {
    const app = buildApp({ logger: false });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/byok/test',
    });
    expect(res.statusCode).toBe(204);
    const allowedHeaders = String(
      res.headers['access-control-allow-headers'] ?? '',
    ).toLowerCase();
    expect(allowedHeaders).toContain('x-byok-base-url');
    expect(allowedHeaders).toContain('x-byok-api-key');
    expect(allowedHeaders).toContain('x-byok-model');
    await app.close();
  });

  it('forwards /v1/byok/test to user provider and never leaks API key in logs or response', async () => {
    const logs: string[] = [];
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ model: 'gpt-4o-mini' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    upstreamAiService.setFetchForTesting(fetchMock as unknown as typeof fetch);

    const app = buildApp({
      logger: {
        stream: {
          write(line: string) {
            logs.push(line);
          },
        },
      },
    });

    const secretKey = 'sk-super-secret-byok-key-9999';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/byok/test',
      headers: {
        'x-device-id': 'web-device-1',
        'x-byok-base-url': 'https://api.openai.com/v1',
        'x-byok-api-key': secretKey,
        'x-byok-model': 'gpt-4o-mini',
      },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, model: 'gpt-4o-mini' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect((calledInit.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${secretKey}`,
    );
    expect(res.body).not.toContain(secretKey);
    expect(logs.join('\n')).not.toContain(secretKey);
    await app.close();
  });

  it('rejects SSRF attempt on /v1/byok/test before any outbound fetch', async () => {
    const fetchMock = vi.fn();
    upstreamAiService.setFetchForTesting(fetchMock as unknown as typeof fetch);

    const app = buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/byok/test',
      headers: {
        'x-device-id': 'web-device-1',
        'x-byok-base-url': 'https://169.254.169.254/latest',
        'x-byok-api-key': 'sk-test',
        'x-byok-model': 'gpt-4o-mini',
      },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });
});
