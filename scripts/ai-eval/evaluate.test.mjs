import { expect, it, vi } from 'vitest';
import {
  EVALUATION_SOURCE_URLS,
  evaluateCase,
  summarize,
} from './evaluate.mjs';

const fixture = {
  id: 'test-1',
  group: 'overview',
  question: 'Tóm tắt thu nhập',
  intent: 'general',
  summary: { income: 3000000 },
  calculations: [],
  requiredNumbers: [3000000],
};
const config = {
  model: 'cx/test',
  baseUrl: 'http://localhost:20128/v1',
  apiKey: 'TEST_SECRET',
  prompt: 'Use only supplied numbers.',
};
const reply = (answer, status = 200) => ({
  model: 'cx/test',
  status,
  latencyMs: 10,
  answer,
  promptTokens: 100,
  completionTokens: 20,
});

it('invalidates cached evaluations when the production number verifier changes', () => {
  expect(
    EVALUATION_SOURCE_URLS.some((url) =>
      url.pathname.endsWith(
        '/packages/domain/src/guardrails/verify-numbers.ts',
      ),
    ),
  ).toBe(true);
});

it('retries incorrect numbers once on the same route and records before/after separately', async () => {
  const complete = vi
    .fn()
    .mockResolvedValueOnce(reply('Thu nhập 99 đồng.'))
    .mockResolvedValueOnce(reply('Thu nhập 3 triệu.'));
  const records = await evaluateCase(fixture, config, [], 2, complete);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls.map(([options]) => options.model)).toEqual([
    'cx/test',
    'cx/test',
  ]);
  expect(records.map((r) => r.judgement.strictNumbersValid)).toEqual([
    false,
    true,
  ]);
  expect(records.map((r) => r.attempt)).toEqual([1, 2]);
  expect(JSON.stringify(records)).not.toContain('TEST_SECRET');
});
it('stops at auth/quota failure and respects the remaining request budget', async () => {
  for (const status of [401, 403, 429, 503]) {
    const complete = vi.fn().mockResolvedValue(reply(null, status));
    expect(await evaluateCase(fixture, config, [], 2, complete)).toHaveLength(
      1,
    );
    expect(complete).toHaveBeenCalledOnce();
  }
  const complete = vi.fn().mockResolvedValue(reply('99 đồng.'));
  expect(await evaluateCase(fixture, config, [], 1, complete)).toHaveLength(1);
  expect(await evaluateCase(fixture, config, [], 0, complete)).toEqual([]);
  expect(complete).toHaveBeenCalledOnce();
});
it('resumes without repeating a completed case and can finish an interrupted retry', async () => {
  const complete = vi.fn().mockResolvedValue(reply('Thu nhập 3 triệu.'));
  const first = await evaluateCase(fixture, config, [], 1, complete);
  expect(await evaluateCase(fixture, config, first, 2, complete)).toEqual([]);
  const failed = {
    ...first[0],
    answer: '99 đồng.',
    judgement: { strictNumbersValid: false, missingRequired: [3000000] },
  };
  const next = await evaluateCase(fixture, config, [failed], 2, complete);
  expect(next.map((r) => r.attempt)).toEqual([2]);
});
it('reports failed and incomplete coverage without inventing human ratings', () => {
  const report = summarize(
    [
      {
        caseId: 'a',
        model: 'm',
        group: 'overview',
        attempt: 1,
        ...reply('99 đồng.'),
        model: 'm',
        judgement: {
          strictNumbersValid: false,
          productionNumbersValid: true,
          missingRequired: [3000000],
        },
      },
      {
        caseId: 'a',
        model: 'm',
        group: 'overview',
        attempt: 2,
        ...reply('3 triệu.'),
        model: 'm',
        judgement: {
          strictNumbersValid: true,
          productionNumbersValid: true,
          missingRequired: [],
        },
      },
      {
        caseId: 'b',
        model: 'm',
        group: 'refusal',
        attempt: 1,
        ...reply(null, 429),
        model: 'm',
        judgement: null,
      },
    ],
    ['m'],
    80,
  );
  expect(report.models[0]).toMatchObject({
    attemptedCases: 2,
    completedCases: 1,
    expectedCases: 80,
    strictFirstPassRate: 0,
    strictFinalPassRate: 1,
    humanRefusalAccuracy: null,
    humanVietnameseFluency: null,
  });
});

it('ensures proxy and evaluation share the exact same ADVICE_SYSTEM_PROMPT', async () => {
  const { ADVICE_SYSTEM_PROMPT } = await import('../../packages/domain/src/index.ts');
  const { SYSTEM_PROMPT } = await import('../../services/proxy/src/services/upstream-ai.ts');
  expect(SYSTEM_PROMPT).toBe(ADVICE_SYSTEM_PROMPT);
});

it('includes the advice prompt guardrail source in EVALUATION_SOURCE_URLS for fingerprinting', () => {
  expect(
    EVALUATION_SOURCE_URLS.some((url) =>
      url.pathname.endsWith(
        '/packages/domain/src/guardrails/advice-prompt.ts',
      ),
    ),
  ).toBe(true);
});

it('contains all required guardrail rules in ADVICE_SYSTEM_PROMPT', async () => {
  const { ADVICE_SYSTEM_PROMPT } = await import('../../packages/domain/src/index.ts');
  expect(ADVICE_SYSTEM_PROMPT).toContain('Purchase affordability');
  expect(ADVICE_SYSTEM_PROMPT).toContain('Loan & installment');
  expect(ADVICE_SYSTEM_PROMPT).toContain('untrusted');
  expect(ADVICE_SYSTEM_PROMPT).toContain('No links');
  expect(ADVICE_SYSTEM_PROMPT).toContain('Do not recommend specific financial products');
  expect(ADVICE_SYSTEM_PROMPT).toContain('Never reveal');
});
