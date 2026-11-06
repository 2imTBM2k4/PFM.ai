import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ADVICE_SYSTEM_PROMPT } from '../../packages/domain/src/guardrails/advice-prompt.ts';
import { cases } from './cases.mjs';
import { completeDirectProvider } from './direct-provider.mjs';
import { judgeAnswer } from './judge.mjs';
import { completeRouter } from './probe.mjs';

export const EVALUATION_SOURCE_URLS = [
  new URL('./judge.mjs', import.meta.url),
  new URL('./evaluate.mjs', import.meta.url),
  new URL('./probe.mjs', import.meta.url),
  new URL('./direct-provider.mjs', import.meta.url),
  new URL(
    '../../packages/domain/src/guardrails/verify-numbers.ts',
    import.meta.url,
  ),
  new URL(
    '../../packages/domain/src/guardrails/advice-prompt.ts',
    import.meta.url,
  ),
];

// Resume only completed synthetic cases; retries never switch model or bypass a quota response.
export async function evaluateCase(
  fixture,
  config,
  prior = [],
  budget = 2,
  complete = completeRouter,
  onRecord = () => {},
) {
  const previous = prior.filter(
    (r) => r.caseId === fixture.id && r.model === config.model,
  );
  const latest = previous.at(-1);
  if (
    latest?.status === 200 &&
    latest.answer &&
    (latest.attempt === 2 ||
      (latest.judgement?.strictNumbersValid &&
        !latest.judgement.missingRequired.length))
  )
    return [];
  const start =
    latest?.status === 200 && latest.answer ? 2 : (latest?.attempt ?? 1);
  const records = [];
  for (
    let attempt = start;
    attempt <= 2 && records.length < budget;
    attempt++
  ) {
    const messages = [
      {
        role: 'system',
        content:
          config.prompt +
          (attempt === 2
            ? '\nRetry: state the requested supplied calculation results explicitly. Do not introduce any number outside data.'
            : ''),
      },
      {
        role: 'user',
        content: `<question>${fixture.question}</question>\n<history></history>\n<data>${JSON.stringify({ intent: fixture.intent, calculations: fixture.calculations, summary: fixture.summary })}</data>`,
      },
    ];
    let result;
    try {
      result = await complete({ ...config, messages, maxTokens: 600 });
    } catch {
      result = {
        model: config.model,
        status: 0,
        answer: null,
        latencyMs: null,
        promptTokens: null,
        completionTokens: null,
        error: 'EVAL_TRANSPORT_FAILED',
      };
    }
    const judgement =
      result.status === 200 && result.answer
        ? judgeAnswer(result.answer, fixture)
        : null;
    const record = {
      caseId: fixture.id,
      group: fixture.group,
      attempt,
      recordedAt: new Date().toISOString(),
      ...result,
      judgement,
    };
    records.push(record);
    onRecord(record);
    if (
      !judgement ||
      (judgement.strictNumbersValid && !judgement.missingRequired.length)
    )
      break;
  }
  return records;
}

const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const rate = (rows, predicate) =>
  rows.length ? rows.filter(predicate).length / rows.length : null;
export function summarize(records, models, expectedCases = cases.length) {
  return {
    humanReview: 'pending',
    models: models.map((model) => {
      const rows = records.filter((r) => r.model === model);
      const first = new Map(),
        last = new Map();
      for (const row of rows) {
        if (row.attempt === 1) first.set(row.caseId, row);
        last.set(row.caseId, row);
      }
      const successful = rows.filter((r) => r.status === 200 && r.answer);
      const finals = [...last.values()].filter(
        (r) => r.status === 200 && r.answer,
      );
      const firsts = [...first.values()].filter(
        (r) => r.status === 200 && r.answer,
      );
      const latency = successful
        .map((r) => r.latencyMs)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const usage = successful.filter(
        (r) => r.promptTokens !== null && r.completionTokens !== null,
      );
      return {
        model,
        requests: rows.length,
        attemptedCases: last.size,
        completedCases: finals.length,
        expectedCases,
        strictFirstPassRate: rate(
          firsts,
          (r) => r.judgement.strictNumbersValid,
        ),
        strictFinalPassRate: rate(
          finals,
          (r) => r.judgement.strictNumbersValid,
        ),
        productionFirstPassRate: rate(
          firsts,
          (r) => r.judgement.productionNumbersValid,
        ),
        requiredNumberCoverage: rate(
          finals,
          (r) => r.judgement.missingRequired.length === 0,
        ),
        unsupportedNumberAnswers: successful.filter(
          (r) => !r.judgement.strictNumbersValid,
        ).length,
        refusalHints: finals.filter(
          (r) => r.group === 'refusal' && r.judgement.refusalHint,
        ).length,
        humanRefusalAccuracy: null,
        humanVietnameseFluency: null,
        latencyMeanMs: mean(latency),
        latencyP50Ms: latency.length
          ? latency[Math.ceil(latency.length * 0.5) - 1]
          : null,
        latencyP95Ms: latency.length
          ? latency[Math.ceil(latency.length * 0.95) - 1]
          : null,
        tokenUsageSamples: usage.length,
        meanPromptTokens: mean(usage.map((r) => r.promptTokens)),
        meanCompletionTokens: mean(usage.map((r) => r.completionTokens)),
        errors: rows
          .filter((r) => r.status !== 200 || !r.answer)
          .map((r) => ({
            caseId: r.caseId,
            status: r.status,
            error: r.error ?? null,
            finishReason: r.finishReason ?? null,
          })),
      };
    }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let lock, lockPath;
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !/^--limit=\d+$/.test(arg)))
      throw new Error('EVAL_CONFIG_INVALID');
    const limit = Number(args[0]?.split('=')[1] ?? cases.length);
    if (!Number.isInteger(limit) || limit < 1 || limit > cases.length)
      throw new Error('EVAL_CONFIG_INVALID');
    const models = (process.env.EVAL_MODELS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (
      !models.length ||
      models.length > 2 ||
      new Set(models).size !== models.length
    )
      throw new Error('EVAL_CONFIG_INVALID');
    const provider = process.env.EVAL_PROVIDER ?? 'local';
    if (!['local', 'cloudflare', 'groq'].includes(provider))
      throw new Error('EVAL_CONFIG_INVALID');
    const baseUrl =
      provider === 'local' ? process.env.ROUTER_BASE_URL : undefined;
    const accountId =
      provider === 'cloudflare' ? process.env.CLOUDFLARE_ACCOUNT_ID : undefined;
    const apiKey =
      provider === 'local'
        ? process.env.ROUTER_API_KEY
        : provider === 'cloudflare'
          ? process.env.CLOUDFLARE_API_TOKEN
          : process.env.GROQ_API_KEY;
    if (!apiKey?.trim()) throw new Error('EVAL_CONFIG_INVALID');
    if (provider === 'cloudflare' && !/^[a-f0-9]{32}$/i.test(accountId ?? ''))
      throw new Error('EVAL_CONFIG_INVALID');
    const prompt = ADVICE_SYSTEM_PROMPT;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          models,
          provider,
          accountId,
          baseUrl,
          prompt,
          cases,
          sources: EVALUATION_SOURCE_URLS.map((url) =>
            readFileSync(url, 'utf8'),
          ),
        }),
      )
      .digest('hex');
    const root = resolve(
      fileURLToPath(new URL('../../dist/ai-eval/', import.meta.url)),
    );
    mkdirSync(root, { recursive: true });
    const journal = resolve(root, `${fingerprint}.jsonl`),
      reportPath = resolve(root, `${fingerprint}.report.json`);
    lockPath = `${journal}.lock`;
    lock = openSync(lockPath, 'wx');
    const records = existsSync(journal)
      ? readFileSync(journal, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    if (!records.length)
      appendFileSync(
        journal,
        JSON.stringify({
          type: 'manifest',
          fingerprint,
          models,
          caseCount: cases.length,
          startedAt: new Date().toISOString(),
        }) + '\n',
      );
    const attempts = records.filter((r) => r.type !== 'manifest');
    let stopped = false;
    for (const model of models) {
      for (const fixture of cases.slice(0, limit)) {
        const next = await evaluateCase(
          fixture,
          { model, provider, accountId, baseUrl, apiKey, prompt },
          attempts,
          Math.min(2, 320 - attempts.length),
          provider === 'local' ? completeRouter : completeDirectProvider,
          (record) => {
            appendFileSync(journal, JSON.stringify(record) + '\n');
            attempts.push(record);
          },
        );
        if (next.length)
          console.log(
            JSON.stringify({
              model,
              caseId: fixture.id,
              requests: attempts.length,
              status: next.at(-1).status,
            }),
          );
        writeFileSync(
          reportPath,
          JSON.stringify(
            { fingerprint, ...summarize(attempts, models) },
            null,
            2,
          ),
        );
        if (
          attempts.length >= 320 ||
          next.some(
            (r) => [0, 401, 403, 429].includes(r.status) || r.status >= 500,
          )
        ) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }
    console.log(
      JSON.stringify({
        reportPath,
        journal,
        stopped,
        ...summarize(attempts, models),
      }),
    );
    if (stopped) process.exitCode = 1;
  } catch {
    console.error(
      JSON.stringify({
        error: 'EVAL_STOPPED',
        note: 'Check local configuration, quota, journal or existing evaluation lock; no automatic fallback.',
      }),
    );
    process.exitCode = 1;
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }
}
