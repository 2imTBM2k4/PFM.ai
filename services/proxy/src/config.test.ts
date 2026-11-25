import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('defaults agent requests to cx/gpt-5.6-sol without changing the legacy chain', async () => {
  vi.stubEnv('AGENT_MODEL_ALLOWLIST', undefined);
  vi.stubEnv('MODEL_CHAIN_FREE', 'legacy/one,legacy/two');
  vi.resetModules();

  const { config } = await import('./config');

  expect(config.agentModelAllowlist).toEqual([
    'cx/gpt-5.6-sol',
    'legacy/one',
    'legacy/two',
  ]);
  expect(config.modelChainFree).toEqual(['legacy/one', 'legacy/two']);
});

it('preserves an explicit administrator agent allowlist', async () => {
  vi.stubEnv('AGENT_MODEL_ALLOWLIST', ' admin/only, admin/only ');
  vi.resetModules();

  const { config } = await import('./config');

  expect(config.agentModelAllowlist).toEqual(['admin/only']);
});

it('defaults rate-limit and quota bypasses to false in production unless explicitly enabled for personal use', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DISABLE_CHAT_RATE_LIMIT', undefined);
  vi.stubEnv('UNLIMITED_AI_TESTING', undefined);
  vi.resetModules();
  const prodDefault = (await import('./config')).config;
  expect(prodDefault.disableChatRateLimit).toBe(false);
  expect(prodDefault.unlimitedAiTesting).toBe(false);

  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DISABLE_CHAT_RATE_LIMIT', 'true');
  vi.stubEnv('UNLIMITED_AI_TESTING', 'true');
  vi.resetModules();
  const prodPersonal = (await import('./config')).config;
  expect(prodPersonal.disableChatRateLimit).toBe(true);
  expect(prodPersonal.unlimitedAiTesting).toBe(true);
});
