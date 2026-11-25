import { expect, it } from 'vitest';
import buildConfig, { flags } from './app.config';

it('declares state-backed context disabled, agent loop enabled, and preserves other app configuration', () => {
  expect(flags.useStateBackedContext).toBe(false);
  expect(flags.useAgentLoop).toBe(true);
  const result = buildConfig({
    config: {
      name: 'PFM.ai',
      slug: 'pfm-ai',
      extra: { existing: 'keep', flags: { existingFlag: true } },
    },
    projectRoot: '.',
    staticConfigPath: null,
    packageJsonPath: null,
  });
  expect(result.extra).toMatchObject({
    existing: 'keep',
    flags: {
      existingFlag: true,
      useStateBackedContext: false,
      useAgentLoop: true,
    },
  });
});
