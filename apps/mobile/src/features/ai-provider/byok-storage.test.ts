import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BYOK_STORAGE_KEY,
  clearByokConfig,
  getActiveByokHeaders,
  readByokConfig,
  saveByokConfig,
  testByokConnection,
} from './byok-storage';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe('Web BYOK localStorage & headers', () => {
  const originalWindow = globalThis.window;
  const originalExpoOs = process.env.EXPO_OS;

  beforeEach(() => {
    process.env.EXPO_OS = 'web';
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: createMemoryStorage() },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalExpoOs === undefined) delete process.env.EXPO_OS;
    else process.env.EXPO_OS = originalExpoOs;
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  });

  it('saves, reads, produces active headers on Web, and clears cleanly', () => {
    expect(getActiveByokHeaders()).toEqual({});

    saveByokConfig({
      enabled: true,
      preset: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      model: 'gemini-2.5-flash',
      apiKey: 'AIza-test-key',
    });

    expect(window.localStorage.getItem(BYOK_STORAGE_KEY)).toBeTruthy();
    expect(readByokConfig()).toEqual({
      enabled: true,
      preset: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.5-flash',
      apiKey: 'AIza-test-key',
    });
    expect(getActiveByokHeaders()).toEqual({
      'x-byok-base-url':
        'https://generativelanguage.googleapis.com/v1beta/openai',
      'x-byok-api-key': 'AIza-test-key',
      'x-byok-model': 'gemini-2.5-flash',
    });

    clearByokConfig();
    expect(getActiveByokHeaders()).toEqual({});
  });

  it('never activates BYOK headers on iOS or Android (Option A: Web only)', () => {
    saveByokConfig({
      enabled: true,
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
    });
    process.env.EXPO_OS = 'ios';
    expect(getActiveByokHeaders()).toEqual({});
    process.env.EXPO_OS = 'android';
    expect(getActiveByokHeaders()).toEqual({});
  });

  it('calls /v1/byok/test with BYOK headers and handles success/failure', async () => {
    const fetchOk = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, model: 'gpt-4o-mini' }), {
        status: 200,
      }),
    );
    const resOk = await testByokConnection(
      {
        baseUrl: 'https://api.openai.com/v1/',
        model: 'gpt-4o-mini',
        apiKey: 'sk-test',
      },
      'https://proxy.example',
      fetchOk as unknown as typeof fetch,
    );
    expect(resOk).toEqual({ ok: true, model: 'gpt-4o-mini' });
    expect(fetchOk).toHaveBeenCalledWith(
      'https://proxy.example/v1/byok/test',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-byok-base-url': 'https://api.openai.com/v1',
          'x-byok-api-key': 'sk-test',
          'x-byok-model': 'gpt-4o-mini',
        }),
      }),
    );

    const fetchFail = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'API Key rejected' }), {
        status: 400,
      }),
    );
    const resFail = await testByokConnection(
      {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'bad-key',
      },
      'https://proxy.example',
      fetchFail as unknown as typeof fetch,
    );
    expect(resFail).toEqual({ ok: false, message: 'API Key rejected' });
  });
});
