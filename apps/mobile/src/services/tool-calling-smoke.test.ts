import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { migrate, type Database, type Queries } from '@/data/migrate';
import type { ToolResult } from '@pfm/contracts';
import { seed, DEFAULT_WALLET_ID } from '@/data/seed';
import { createCategory } from '@/data/categories';
import { createBudget } from '@/data/budgets';
import { createTransaction } from '@/data/transactions';
import { executeTool } from './advice-tools';
import { buildApp } from '../../../../services/proxy/src/app';
import { config } from '../../../../services/proxy/src/config';
import { upstreamAiService } from '../../../../services/proxy/src/services/upstream-ai';
import { rateLimitService } from '../../../../services/proxy/src/services/rate-limit-service';
import {
  diagnoseFetch,
  type TransportCapture,
} from '../../../../services/proxy/src/eval/transport-diagnostics';
import {
  loadToolCallingCases,
  runToolCallingCase,
  summarizeToolCalling,
  type CaseReport,
  type EvalCase,
  type StepRequest,
} from '../../../../services/proxy/src/eval/tool-calling-runner';

const model = config.agentModelAllowlist[0];
const documentUrl = new URL(
  '../../../../docs/tool-calling-test-cases.md',
  import.meta.url,
);
const compatUrl = new URL(
  '../../../../docs/tool-calling-compat.md',
  import.meta.url,
);
const cases = loadToolCallingCases(readFileSync(documentUrl, 'utf8'));
function smokeProfile(diagnosticS1: boolean, diagnosticFull = false) {
  const extended = diagnosticS1 || diagnosticFull;
  return {
    name: diagnosticS1
      ? 'diagnostic-s1-60-120'
      : diagnosticFull
        ? 'diagnostic-full-60-120'
        : 'smoke-level-1',
    cases: diagnosticS1
      ? cases.filter((testCase) => testCase.id === 'S1')
      : cases,
    timeouts: extended
      ? { modelCallMs: 60_000, turnMs: 120_000 }
      : { modelCallMs: 15_000, turnMs: 30_000 },
    testTimeoutMs: Math.max(
      360_000,
      (diagnosticS1 ? 1 : 10) * (extended ? 120_000 : 30_000) + 30_000,
    ),
  };
}
it('limits the extended diagnostic profile to S1 and preserves the standard smoke profile', () => {
  const extended = smokeProfile(true);
  expect(extended.cases.map((testCase) => testCase.id)).toEqual(['S1']);
  expect(extended.timeouts).toEqual({ modelCallMs: 60_000, turnMs: 120_000 });
  const standard = smokeProfile(false);
  expect(standard.cases).toHaveLength(10);
  expect(standard.timeouts).toEqual({ modelCallMs: 15_000, turnMs: 30_000 });
});
it('supports the approved ten-case extended measurement while keeping S1-only selection safer when both switches are set', () => {
  const full = smokeProfile(false, true);
  expect(full.name).toBe('diagnostic-full-60-120');
  expect(full.cases.map((testCase) => testCase.id)).toEqual([
    'S1',
    'S2',
    'S3',
    'S4',
    'S5',
    'D1',
    'D2',
    'D3',
    'C1',
    'C2',
  ]);
  expect(full.timeouts).toEqual({ modelCallMs: 60_000, turnMs: 120_000 });
  expect(full.testTimeoutMs).toBe(1_230_000);
  expect(smokeProfile(true, true).cases.map((testCase) => testCase.id)).toEqual(
    ['S1'],
  );
});
const liveProfile = smokeProfile(
  process.env.TOOL_CALLING_DIAGNOSTIC_S1 === '1',
  process.env.TOOL_CALLING_DIAGNOSTIC_FULL === '1',
);
const timestamp = '2026-11-16T12:00:00.000Z';
const realFetch = fetch;
const categoryId = '11111111-1111-4111-8111-111111111111';
const budgetId = '22222222-2222-4222-8222-222222222222';
const physicalIds: Record<string, string> = {
  'cat-food': categoryId,
  'budget-food': budgetId,
};
const logicalIds = Object.fromEntries(
  Object.entries(physicalIds).map(([logical, physical]) => [physical, logical]),
);
const translateIds = (value: unknown, ids: Record<string, string>): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === 'string' ? (ids[item] ?? item) : item,
    ),
  );
async function executeFixtureTool(
  ...args: Parameters<typeof executeTool>
): Promise<ToolResult> {
  const [name, params, allowed, context] = args;
  const result = await executeTool(
    name,
    translateIds(params, physicalIds),
    allowed,
    context,
  );
  return result.status === 'ok'
    ? { ...result, data: translateIds(result.data, logicalIds) }
    : result;
}
let sqlite: DatabaseSync;
let db: Database;
let app: ReturnType<typeof buildApp>;
let currentSignal: AbortSignal | undefined;
let previousBypass: string | undefined;
vi.mock('@/data/connection', () => ({
  withDatabase: (task: (db: Database) => Promise<unknown>) => task(db),
}));

beforeEach(async () => {
  previousBypass = process.env.RATE_LIMIT_BYPASS_SUBS;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(timestamp);
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const queries: Queries = {
    execAsync: async (sql) => {
      sqlite.exec(sql);
    },
    runAsync: async (sql, ...params) => sqlite.prepare(sql).run(...params),
    getFirstAsync: async <T,>(
      sql: string,
      ...params: (string | number | null)[]
    ) => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T,>(
      sql: string,
      ...params: (string | number | null)[]
    ) => sqlite.prepare(sql).all(...params) as T[],
  };
  db = {
    ...queries,
    transaction: async (task) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        await task(queries);
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  await migrate(db);
  await seed(db, timestamp);
  await createCategory(
    db,
    categoryId,
    {
      name: 'Ăn uống',
      kind: 'expense',
      parentId: null,
      icon: null,
      color: null,
    },
    timestamp,
  );
  const add = (
    id: string,
    amount: number,
    date: string,
    kind: 'income' | 'expense',
    categoryId: string | null = null,
  ) =>
    createTransaction(
      db,
      id,
      {
        amount,
        kind,
        walletId: DEFAULT_WALLET_ID,
        categoryId,
        occurredOn: date,
        occurredAt: `${date}T10:00:00+07:00`,
      },
      timestamp,
    );
  for (let month = 5; month <= 10; month++) {
    const date = `2026-${String(month).padStart(2, '0')}-02`;
    await add(`income-${month}`, 15_000_000, date, 'income');
    await add(`expense-${month}`, 10_000_000, date, 'expense');
  }
  await add('t-food-1', 1_000_000, '2026-11-02', 'expense', categoryId);
  await add('t-food-2', 2_000_000, '2026-11-08', 'expense', categoryId);
  await add('t-food-3', 500_000, '2026-11-15', 'expense', categoryId);
  // Current-month spending outside food reconciles liquidity to 12m without changing historical averages.
  await add('current-other-expense', 14_500_000, '2026-11-16', 'expense');
  await createBudget(
    db,
    budgetId,
    { categoryId, amount: 3_000_000, startMonth: '2026-11' },
    timestamp,
  );
  rateLimitService.resetForTesting();
  process.env.RATE_LIMIT_BYPASS_SUBS = [previousBypass, 'synthetic-tool-eval']
    .filter(Boolean)
    .join(',');
  app = buildApp({ logger: false });
  // Isolate provider compatibility from guest per-request limits using the existing development-only bypass.
  app.addHook('preValidation', async (request) => {
    request.auth = { mode: 'authenticated', sub: 'synthetic-tool-eval' };
  });
  await app.ready();
});
afterEach(async () => {
  await app?.close();
  sqlite?.close();
  upstreamAiService.setFetchForTesting(realFetch);
  currentSignal = undefined;
  if (previousBypass === undefined) delete process.env.RATE_LIMIT_BYPASS_SUBS;
  else process.env.RATE_LIMIT_BYPASS_SUBS = previousBypass;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function step(body: StepRequest, signal: AbortSignal): Promise<Response> {
  currentSignal = signal;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/advice/step',
    headers: { 'x-device-id': 'synthetic-tool-eval' },
    payload: body,
  });
  return new Response(response.body, {
    status: response.statusCode,
    headers: { 'content-type': String(response.headers['content-type'] ?? '') },
  });
}
const answers: Record<string, string> = {
  S1: 'Trung bình 6 tháng hoàn chỉnh: thu nhập 15 triệu/tháng, chi tiêu 10 triệu/tháng.',
  S2: 'Hạn mức 3 triệu đồng. Đã chi 3,5 triệu đồng. Còn lại 0 đồng. Vượt 500 nghìn đồng.',
  S3: 'Dư trước mục tiêu 5 triệu/tháng. Cần dành 4 triệu/tháng. Còn lại sau phân bổ 1 triệu/tháng.',
  S4: '15/11/2026: 500 nghìn đồng. 08/11/2026: 2 triệu đồng. 02/11/2026: 1 triệu đồng.',
  S5: 'Dư trước mục tiêu 2 triệu/tháng. Cần dành 4 triệu/tháng. Còn lại sau phân bổ âm 2 triệu/tháng.',
  D1: 'Trung bình 6 tháng hoàn chỉnh: thu nhập 15 triệu/tháng, chi tiêu 10 triệu/tháng. Hạn mức 3 triệu đồng. Đã chi 3,5 triệu đồng. Vượt 500 nghìn đồng.',
  D2: 'Ngân sách vượt 500 nghìn đồng. Giao dịch: 15/11/2026: 500 nghìn đồng; 08/11/2026: 2 triệu đồng; 02/11/2026: 1 triệu đồng.',
  D3: 'Cần dành 4 triệu/tháng. Còn lại sau phân bổ 1 triệu/tháng. Số dư khả dụng hiện tại 12 triệu đồng.',
};
it.each([false, true])(
  'runs all ten documented cases through /step and real SQLite with AI explanation=%s',
  async (withExplanation) => {
    let current: EvalCase;
    let callIndex = 0;
    const mock = vi.fn<typeof fetch>(async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      if (!payload.stream) {
        const tool = current.requiredTools[callIndex++];
        return Response.json({
          model,
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `call-${callIndex}`,
                    type: 'function',
                    function: {
                      name: tool.name,
                      arguments: JSON.stringify(
                        withExplanation && tool.name === 'plan_savings_goal'
                          ? { reason: 'Recalculate using verified local facts' }
                          : tool.params,
                      ),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: answers[current.id] }, finish_reason: null }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const captured: TransportCapture[] = [];
    const pendingCaptures: Promise<void>[] = [];
    upstreamAiService.setFetchForTesting((url, init) =>
      diagnoseFetch(mock, url, init ?? {}, currentSignal, (capture) => {
        pendingCaptures.push(
          capture.then((entry) => {
            captured.push(entry);
          }),
        );
      }),
    );
    const reports: CaseReport[] = [];
    for (const testCase of cases) {
      current = testCase;
      callIndex = 0;
      const report = await runToolCallingCase(testCase, {
        model,
        step,
        executeTool: executeFixtureTool,
      });
      reports.push(report);
      expect(
        report,
        `${testCase.id}: ${report.error ?? report.text}`,
      ).toMatchObject({
        passed: true,
        correctTools: true,
        businessCorrect: true,
        fallback: false,
      });
    }
    expect(mock).toHaveBeenCalledTimes(21);
    await Promise.all(pendingCaptures);
    expect(captured).toHaveLength(21);
    const rawSavingsCalls = captured
      .filter((entry) => !entry.body.startsWith('data:'))
      .flatMap((entry) => JSON.parse(entry.body).choices[0].message.tool_calls)
      .filter(
        (call: { function: { name: string } }) =>
          call.function.name === 'plan_savings_goal',
      );
    expect(rawSavingsCalls).toHaveLength(5);
    for (const call of rawSavingsCalls)
      expect(JSON.parse(call.function.arguments)).toEqual(
        withExplanation
          ? { reason: 'Recalculate using verified local facts' }
          : {},
      );
    expect(
      captured.every((entry) => entry.complete && entry.status === 200),
    ).toBe(true);
    for (const [, init] of mock.mock.calls)
      expect(JSON.parse(String(init?.body)).model).toBe(
        config.agentModelAllowlist[0],
      );
    expect(summarizeToolCalling(reports)).toMatchObject({
      turns: 10,
      schemaPercent: 100,
      correctToolPercent: 100,
      businessPercent: 100,
      fallbackPercent: 0,
    });
    const snapshot = reports[0].observations[0].result;
    expect(snapshot).toMatchObject({
      status: 'ok',
      data: {
        indicators: {
          monthly_income_avg: 15_000_000,
          monthly_expense_avg: 10_000_000,
        },
        period: { from: '2026-05-01', to: '2026-10-31' },
      },
    });
    expect(reports[1].observations[0].result).toMatchObject({
      status: 'ok',
      data: {
        budgets: [
          {
            limit_amount: 3_000_000,
            spent_amount: 3_500_000,
            remaining_amount: 0,
            overspent_amount: 500_000,
          },
        ],
      },
    });
    expect(reports[3].observations[0].result).toMatchObject({
      status: 'ok',
      data: {
        transactions: [
          { id: 't-food-3', amount: 500_000 },
          { id: 't-food-2', amount: 2_000_000 },
          { id: 't-food-1', amount: 1_000_000 },
        ],
        truncated: false,
      },
    });
    expect(reports[4].observations[0].result).toMatchObject({
      status: 'ok',
      data: {
        monthlyAvailable: 2_000_000,
        requiredMonthlySaving: 4_000_000,
        remainingAfterSaving: -2_000_000,
      },
    });
    expect(reports[7].observations[1].result).toMatchObject({
      status: 'ok',
      data: { indicators: { liquid_balance: 12_000_000 } },
    });
  },
);

it.skipIf(process.env.TOOL_CALLING_SMOKE !== '1')(
  'live smoke level 1: configured model, at most ten turns, stop at the first protocol failure',
  async () => {
    const measuredAt = new Date(vi.getRealSystemTime()).toISOString();
    const profile = liveProfile;
    const configSummary = {
      model,
      routerBaseUrl: config.routerBaseUrl,
      allowedModels: config.agentModelAllowlist,
      measurementProfile: profile.name,
      caseIds: profile.cases.map((testCase) => testCase.id),
      timeouts: profile.timeouts,
      testTimeoutMs: profile.testTimeoutMs,
    };
    const recordUnmeasured = (reason: string) => {
      appendFileSync(
        compatUrl,
        `\n\n## 4b — ${measuredAt}\n\n**CHƯA ĐO** — ${reason}. Không thử lại. Lượt/lời gọi mô hình: 0/0. Mức 2/3 không chạy.\n`,
      );
      console.log(
        JSON.stringify({ status: 'CHUA_DO', reason, ...configSummary }),
      );
    };
    if (
      !config.agentModelAllowlist.includes(model) ||
      !['development', 'test'].includes(config.nodeEnv)
    ) {
      recordUnmeasured('Cấu hình chưa cho phép bộ đo chọn mô hình');
      return;
    }
    try {
      const readiness = await realFetch(
        `${config.routerBaseUrl.replace(/\/$/, '')}/models`,
        {
          headers: config.routerApiKey
            ? { Authorization: `Bearer ${config.routerApiKey}` }
            : {},
          signal: AbortSignal.timeout(3000),
        },
      );
      await readiness.body?.cancel();
      if (!readiness.ok) {
        recordUnmeasured(`Kiểm tra kết nối trả HTTP ${readiness.status}`);
        return;
      }
    } catch {
      recordUnmeasured(
        'Không kết nối được 9router trong lần kiểm tra duy nhất',
      );
      return;
    }
    const captured: (TransportCapture & { id: string; allowTools: boolean })[] =
      [];
    const pendingCaptures: Promise<void>[] = [];
    let currentId = '';
    upstreamAiService.setFetchForTesting(async (url, init) => {
      const id = currentId;
      const allowTools = !JSON.parse(String(init?.body)).stream;
      return diagnoseFetch(
        realFetch,
        url,
        init ?? {},
        currentSignal,
        (capture) => {
          pendingCaptures.push(
            capture.then((entry) => {
              captured.push({ id, allowTools, ...entry });
            }),
          );
        },
      );
    }, profile.timeouts.modelCallMs);
    const reports: CaseReport[] = [];
    for (const testCase of profile.cases) {
      currentId = testCase.id;
      const report = await runToolCallingCase(testCase, {
        model,
        step,
        executeTool: executeFixtureTool,
        timeouts: profile.timeouts,
      });
      reports.push(report);
      console.log(
        JSON.stringify({
          id: report.id,
          passed: report.passed,
          error: report.error,
          modelCalls: report.modelCalls,
          latencyMs: report.latencyMs,
        }),
      );
      if (report.protocolError) break;
    }
    await Promise.all(pendingCaptures);
    const summary = summarizeToolCalling(reports);
    const artifact = {
      measuredAt,
      ...configSummary,
      summary,
      reports,
      upstreamRaw: captured,
    };
    const artifactName = `tool-calling-smoke-${model.replace(/[^a-zA-Z0-9.-]/g, '-')}-${measuredAt.replace(/[:.]/g, '-')}.json`;
    writeFileSync(
      new URL(`../../../../docs/${artifactName}`, import.meta.url),
      JSON.stringify(artifact, null, 2),
      { flag: 'wx' },
    );
    const failed = reports.find((report) => report.protocolError);
    const rows = reports
      .map(
        (report) =>
          `| ${report.id} | ${report.passed ? 'Đạt' : report.needsReview ? 'Cần rà soát' : 'Trượt'} | ${report.validCalls}/${report.totalCalls} | ${report.correctTools} | ${report.businessCorrect} | ${report.modelCalls} | ${report.error ?? ''} |`,
      )
      .join('\n');
    let section = `\n\n## 4b — ${profile.name}, ${measuredAt}\n\nThời hạn đo: ${profile.timeouts.modelCallMs / 1000} giây/lời gọi, ${profile.timeouts.turnMs / 1000} giây/lượt. Mặc định ứng dụng giữ 15/30 giây. Mô hình yêu cầu: \`${model}\`. Nhà cung cấp thực thi: chưa xác minh độc lập (tuyến cấu hình ${model.split('/')[0]}). Đã chạy ${reports.length}/${profile.cases.length} lượt, ${reports.reduce((sum, report) => sum + report.modelCalls, 0)} lời gọi mô hình. ${failed ? `Dừng ngay tại ${failed.id}: ${failed.error}. Không chạy các câu sau.` : `Đã chạy đủ ${profile.cases.length} câu trong phạm vi duyệt, mỗi câu đúng một lần.`} Không thử lại, không chạy mức 2/3.\n\n| Câu | Kết quả | Lời gọi hợp lệ | Đúng công cụ | Đúng nghiệp vụ | Số gọi mô hình | Lỗi |\n|---|---|---|---|---|---|---|\n${rows}\n\nChỉ số trên các lượt thực chạy (không suy ra cả bộ 10 câu): ${JSON.stringify(summary)}.\n\nChi tiết và số token có/thiếu trong [${artifactName}](${artifactName}). Chưa có đơn giá để quy ra tiền.\n`;
    if (failed) {
      const raw = captured.filter((item) => item.id === failed.id);
      if (raw.length)
        for (const entry of raw) {
          const fence = '~'.repeat(
            Math.max(
              3,
              ...[...entry.body.matchAll(/~+/g)].map(
                (match) => match[0].length + 1,
              ),
            ),
          );
          section += `\n${entry.complete ? 'Phản hồi 9router nguyên văn' : 'Phần phản hồi 9router nhận được trước lỗi (không hoàn chỉnh)'} cho ${entry.id}, HTTP ${entry.status ?? 'chưa nhận'}; chẩn đoán: ${JSON.stringify({ headersMs: entry.headersMs, firstChunkMs: entry.firstChunkMs, endedMs: entry.endedMs, bytesReceived: entry.bytesReceived, firstAbort: entry.firstAbort, error: entry.error })}:\n\n${fence}text\n${entry.body}\n${fence}\n`;
        }
      else
        section +=
          '\nKhông có HTTP response từ 9router để lưu nguyên văn (lỗi kết nối/hủy); phản hồi proxy được giữ trong tệp JSON.\n';
    }
    appendFileSync(compatUrl, section);
    console.log(
      JSON.stringify({
        status: failed ? 'STOPPED_ON_PROTOCOL_ERROR' : 'COMPLETED',
        summary,
      }),
    );
    expect(
      reports.every((report) => report.passed),
      'Compatibility failed or requires review; see docs/tool-calling-compat.md',
    ).toBe(true);
  },
  liveProfile.testTimeoutMs,
);
