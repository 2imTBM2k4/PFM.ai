import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '@pfm/contracts';
import {
  loadToolCallingCases,
  runToolCallingCase,
  runToolCallingSuite,
  summarizeToolCalling,
  gradeFinalBusiness,
  type CaseReport,
} from './tool-calling-runner';

const markdown = readFileSync(
  new URL('../../../../docs/tool-calling-test-cases.md', import.meta.url),
  'utf8',
);
const cases = loadToolCallingCases(markdown);
const result: ToolResult = {
  status: 'ok',
  stateRevision: 1,
  calculationVersion: 1,
  data: {
    monthlyAvailable: 5_000_000,
    requiredMonthlySaving: 4_000_000,
    remainingAfterSaving: 1_000_000,
    months: 6,
    goalAmount: 24_000_000,
    savingsForGoal: 0,
  },
};
function sse(text: string, done = true) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n${done ? 'data: [DONE]\n\n' : ''}`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function toolResponse(name = 'plan_savings_goal', args = '{}') {
  return Response.json({
    model: 'mock/provider',
    usage: { prompt_tokens: 100, completion_tokens: 10 },
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name, arguments: args },
            },
          ],
        },
      },
    ],
  });
}
const options = () => ({
  model: 'mock/provider',
  step: vi
    .fn()
    .mockResolvedValueOnce(toolResponse())
    .mockResolvedValueOnce(
      sse(
        'Dư trước mục tiêu 5 triệu/tháng. Cần dành 4 triệu/tháng. Còn lại sau phân bổ 1 triệu/tháng.',
      ),
    ),
  executeTool: vi.fn().mockResolvedValue(result),
});

describe('transport evidence without changing grading', () => {
  it('allows a measurement to finish after 30 seconds with explicit 60/120 second limits', async () => {
    const opts = options();
    let time = 0;
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    opts.step
      .mockReset()
      .mockResolvedValueOnce(toolResponse())
      .mockImplementationOnce(async () => {
        time = 45_000;
        return sse(
          'Dư trước mục tiêu 5 triệu/tháng. Cần dành 4 triệu/tháng. Còn lại sau phân bổ 1 triệu/tháng.',
        );
      });
    try {
      const report = await runToolCallingCase(cases[2], {
        ...opts,
        now: () => time,
        timeouts: { modelCallMs: 60_000, turnMs: 120_000 },
      });
      expect(report.passed).toBe(true);
      expect(report.latencyMs).toBe(45_000);
      expect(timeout.mock.calls.every(([ms]) => ms === 60_000)).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });
  it('keeps partial bytes and a connection error without accepting an incomplete final answer', async () => {
    const opts = options();
    const failure = Object.assign(
      new TypeError('must not record this message'),
      {
        cause: { code: 'ECONNRESET' },
      },
    );
    const prefix = 'data: {"choices":[{"delta":{"content":"Synthetic"}}]}\n\n';
    opts.step
      .mockReset()
      .mockResolvedValueOnce(toolResponse())
      .mockImplementationOnce(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(prefix));
                setTimeout(() => controller.error(failure), 10);
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      );
    const report = await runToolCallingCase(cases[2], opts);
    expect(report).toMatchObject({
      error: 'TRANSPORT_ERROR',
      passed: false,
      text: '',
      sseValid: null,
    });
    expect(report).toHaveProperty('transport');
    const evidence = report.transport[1];
    expect(evidence).toMatchObject({
      allowTools: false,
      status: 200,
      complete: false,
      body: prefix,
      bytesReceived: new TextEncoder().encode(prefix).length,
      error: { name: 'TypeError', code: 'ECONNRESET', phase: 'body' },
    });
    expect(evidence.headersMs).toEqual(expect.any(Number));
    expect(evidence.firstChunkMs).toEqual(expect.any(Number));
    expect(evidence.endedMs).toEqual(expect.any(Number));
    expect(JSON.stringify(evidence)).not.toContain('must not record');
    expect(report.rawResponses).toHaveLength(1);
  });

  it('records header-stage failure separately and preserves the old error classification', async () => {
    const opts = options();
    opts.step
      .mockReset()
      .mockRejectedValue(new DOMException('secret', 'TimeoutError'));
    const report = await runToolCallingCase(cases[2], opts);
    expect(report).toMatchObject({
      error: 'TRANSPORT_ERROR',
      transport: [
        {
          allowTools: true,
          status: null,
          complete: false,
          body: '',
          firstChunkMs: null,
          headersMs: null,
          error: { name: 'TimeoutError', phase: 'headers' },
        },
      ],
    });
  });
});

describe('compatibility runner', () => {
  it('regrades all ten recorded cases offline without rewriting the original measurement', () => {
    const sourceName =
      'tool-calling-smoke-ag-gemini-3.8-flash-high-2026-11-18T07-40-30-647Z.json';
    const sourceUrl = new URL(
      `../../../../docs/${sourceName}`,
      import.meta.url,
    );
    const original = readFileSync(sourceUrl, 'utf8');
    const recorded = JSON.parse(original);
    const reports = (recorded.reports as CaseReport[]).map((report) => {
      const testCase = cases.find((item) => item.id === report.id)!;
      expect(report.correctTools).toBe(true);
      expect(report.protocolError).toBe(false);
      expect(report.fallback).toBe(false);
      if (testCase.missing) {
        expect(report.clarificationFields).toEqual([testCase.missing]);
        expect(report.passed).toBe(true);
        return report;
      }
      expect(report.sseValid).toBe(true);
      const businessCorrect = gradeFinalBusiness(testCase, report.text);
      return {
        ...report,
        businessCorrect,
        passed: businessCorrect,
        needsReview: !businessCorrect,
      };
    });
    expect(reports.map((report) => [report.id, report.passed])).toEqual([
      ['S1', true],
      ['S2', true],
      ['S3', true],
      ['S4', true],
      ['S5', true],
      ['D1', true],
      ['D2', true],
      ['D3', true],
      ['C1', true],
      ['C2', true],
    ]);
    expect(
      recorded.reports.find((item: CaseReport) => item.id === 'S5').passed,
    ).toBe(false);
    expect(readFileSync(sourceUrl, 'utf8')).toBe(original);
    const summary = summarizeToolCalling(reports);
    expect(summary).toMatchObject({
      turns: 10,
      schemaPercent: 100,
      correctToolPercent: 100,
      businessPercent: 100,
      fallbackPercent: 0,
    });
    if (process.env.TOOL_CALLING_REGRADE === '1') {
      writeFileSync(
        new URL(
          `../../../../docs/${sourceName.replace('.json', '-regraded-s5-v2.json')}`,
          import.meta.url,
        ),
        JSON.stringify(
          {
            rubricVersion: 's5-wording-v2',
            regradedAt: new Date().toISOString(),
            source: sourceName,
            sourceSha256: createHash('sha256').update(original).digest('hex'),
            method:
              'Offline regrade only; no new model calls, no new latency measurement',
            originalSummary: recorded.summary,
            summary,
            results: reports.map((report, index) => ({
              id: report.id,
              originalPassed: recorded.reports[index].passed,
              passed: report.passed,
              businessCorrect: report.businessCorrect,
              needsReview: report.needsReview,
            })),
          },
          null,
          2,
        ) + '\n',
      );
    }
  });
  it.each([
    'Dư trước mục tiêu 2 triệu/tháng. Cần dành 4 triệu/tháng. Còn lại sau tiết kiệm âm 2 triệu/tháng.',
    'Khả dụng hàng tháng 2 triệu. Cần dành 4 triệu/tháng. Còn lại sau tiết kiệm thiếu hụt 2 triệu/tháng.',
    'Số tiền khả dụng mỗi tháng: 2.000.000 VND/tháng. Cần tiết kiệm 4.000.000 VND/tháng. Còn lại sau tiết kiệm: -2.000.000 VND/tháng.',
    'Dư trước tiết kiệm 2 triệu/tháng. Cần dành 4 triệu/tháng. Còn lại sau tiết kiệm thiếu 2 triệu/tháng.',
  ])('accepts equivalent S5 availability and shortfall wording: %s', (text) => {
    expect(gradeFinalBusiness(cases[4], text)).toBe(true);
  });
  it.each([
    'Số tiền khả dụng mỗi tháng: thiếu hụt 2 triệu. Cần dành 4 triệu/tháng. Còn lại sau tiết kiệm thiếu hụt 2 triệu/tháng.',
    'Dư trước mục tiêu âm 2 triệu/tháng. Cần dành 4 triệu/tháng. Còn lại sau tiết kiệm âm 2 triệu/tháng.',
    'Khả dụng hàng tháng -2 triệu. Cần dành 4 triệu/tháng. Còn lại sau tiết kiệm thiếu hụt 2 triệu/tháng.',
    'Khả dụng hàng tháng 2 triệu. Cần dành 4 triệu/tháng. Còn lại sau tiết kiệm 2 triệu/tháng.',
    'Khả dụng hàng tháng 2 triệu. Cần dành 4 triệu/tháng. Còn lại sau tiết kiệm dư 2 triệu/tháng.',
    'Khả dụng hàng tháng 2 triệu. Cần dành 4 triệu/tháng. Còn lại sau tiết kiệm thiếu hụt 1 triệu/tháng.',
    'Khả dụng hàng tháng 4 triệu. Cần dành 2 triệu/tháng. Còn lại sau tiết kiệm thiếu hụt 2 triệu/tháng.',
    'Số dư khả dụng hiện tại 2 triệu. Cần dành 4 triệu/tháng. Còn lại sau tiết kiệm thiếu hụt 2 triệu/tháng.',
  ])(
    'rejects an incorrect S5 direction, amount, or balance label: %s',
    (text) => {
      expect(gradeFinalBusiness(cases[4], text)).toBe(false);
    },
  );
  it('accepts the recorded S5 answer with monthly availability and a shortfall', () => {
    const recorded = JSON.parse(
      readFileSync(
        new URL(
          '../../../../docs/tool-calling-smoke-ag-gemini-3.8-flash-high-2026-11-18T07-40-30-647Z.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const report = recorded.reports.find(
      (item: { id: string }) => item.id === 'S5',
    );
    expect(gradeFinalBusiness(cases[4], report.text)).toBe(true);
  });
  it('grades labelled budget amounts with Vietnamese uppercase Đ correctly', () => {
    expect(
      gradeFinalBusiness(
        cases[1],
        'Hạn mức 3 triệu đồng. Đã chi 3,5 triệu đồng. Còn lại 0 đồng. Vượt 500 nghìn đồng.',
      ),
    ).toBe(true);
  });
  it('rejects swapped labels and an unlabelled bag of correct numbers', () => {
    expect(
      gradeFinalBusiness(
        cases[0],
        'Trung bình 6 tháng: thu nhập 10 triệu, chi tiêu 15 triệu.',
      ),
    ).toBe(false);
    expect(
      gradeFinalBusiness(cases[2], '5 triệu, 4 triệu, 1 triệu/tháng.'),
    ).toBe(false);
  });
  it('loads exactly the ten original questions without rewriting S5', () => {
    expect(cases.map((item) => item.id)).toEqual([
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
    expect(cases[4].question).toBe(
      'Thực ra thu nhập của tôi là 12 triệu/tháng, các khoản khác và mục tiêu giữ nguyên. Tính lại giúp tôi.',
    );
  });
  it('passes standard tool calls, real observations and correct final numbers', async () => {
    const deps = options();
    const report = await runToolCallingCase(cases[2], deps);
    expect(report).toMatchObject({
      passed: true,
      correctTools: true,
      businessCorrect: true,
      validCalls: 1,
      totalCalls: 1,
      fallback: false,
      sseValid: true,
    });
    expect(deps.executeTool).toHaveBeenCalledOnce();
    expect(report.usage).toMatchObject({
      input: null,
      output: null,
      missingCalls: 1,
    });
    expect(deps.step).toHaveBeenCalledTimes(2);
    expect(deps.step.mock.calls[1][0]).toMatchObject({
      allowTools: false,
      stream: true,
    });
    expect(deps.step.mock.calls[1][0].messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
      content: JSON.stringify(result),
    });
  });
  it.each(['C1', 'C2'])(
    'fails direct answers and embedded JSON for %s',
    async (id) => {
      const deps = options();
      deps.step.mockReset().mockResolvedValue(
        Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content:
                  '{"tool_calls":[{"name":"plan_savings_goal"}]} Mỗi tháng 4 triệu.',
              },
            },
          ],
        }),
      );
      const report = await runToolCallingCase(
        cases.find((item) => item.id === id)!,
        deps,
      );
      expect(report).toMatchObject({
        passed: false,
        correctTools: false,
        businessCorrect: false,
        protocolError: true,
        fallback: true,
      });
      expect(deps.executeTool).not.toHaveBeenCalled();
    },
  );
  it('denies the whole mixed batch before any tool executes', async () => {
    const deps = options();
    const data = await toolResponse().json();
    data.choices[0].message.tool_calls.push({
      id: 'call-2',
      type: 'function',
      function: { name: 'get_transactions', arguments: '{}' },
    });
    deps.step.mockReset().mockResolvedValue(Response.json(data));
    expect(await runToolCallingCase(cases[2], deps)).toMatchObject({
      passed: false,
      correctTools: false,
      fallback: true,
      error: 'TOOL_NOT_ALLOWED',
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it('fails an invented argument instead of stripping it', async () => {
    const deps = options();
    deps.step
      .mockReset()
      .mockResolvedValue(
        toolResponse('plan_savings_goal', '{"savingsForGoal":0}'),
      );
    expect(await runToolCallingCase(cases[2], deps)).toMatchObject({
      passed: false,
      validCalls: 0,
      totalCalls: 1,
      businessCorrect: false,
    });
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it.each([0, 1])(
    'rejects the entire batch when call %i requests an extra indicator',
    async (invalidIndex) => {
      const testCase = cases.find((item) => item.id === 'D1')!;
      const calls = testCase.requiredTools.map((tool, index) => ({
        id: `call-${index}`,
        type: 'function',
        function: {
          name: tool.name,
          arguments: JSON.stringify(
            tool.name === 'get_financial_snapshot'
              ? {
                  ...tool.params,
                  fields: [
                    'monthly_income_avg',
                    'monthly_expense_avg',
                    'liquid_balance',
                  ],
                }
              : tool.params,
          ),
        },
      }));
      if (invalidIndex === 1) calls.reverse();
      const data = await toolResponse().json();
      data.choices[0].message.tool_calls = calls;
      const deps = options();
      deps.step.mockReset().mockResolvedValue(Response.json(data));

      const report = await runToolCallingCase(testCase, deps);

      expect(report).toMatchObject({
        passed: false,
        error: 'WRONG_PARAMS',
        observations: [],
        validCalls: 2,
      });
      expect(deps.executeTool).not.toHaveBeenCalled();
      expect(deps.step).toHaveBeenCalledOnce();
    },
  );
  it.each([false, true])(
    'executes a valid batch sequentially, reversed=%s',
    async (reversed) => {
      const testCase = cases.find((item) => item.id === 'D1')!;
      const tools = [...testCase.requiredTools];
      if (reversed) tools.reverse();
      const data = await toolResponse().json();
      data.choices[0].message.tool_calls = tools.map((tool, index) => ({
        id: `call-${index}`,
        type: 'function',
        function: { name: tool.name, arguments: JSON.stringify(tool.params) },
      }));
      const deps = options();
      deps.step
        .mockReset()
        .mockResolvedValueOnce(Response.json(data))
        .mockResolvedValueOnce(
          sse(
            'Trung bình 6 tháng: thu nhập 15 triệu, chi tiêu 10 triệu/tháng. Hạn mức 3 triệu. Đã chi 3,5 triệu. Vượt 500 nghìn.',
          ),
        );
      const events: string[] = [];
      deps.executeTool.mockImplementation(async (name: string) => {
        events.push(`start:${name}`);
        await Promise.resolve();
        events.push(`end:${name}`);
        return result;
      });

      const report = await runToolCallingCase(testCase, deps);

      expect(report).toMatchObject({ correctTools: true, sseValid: true });
      expect(events).toEqual(
        tools.flatMap((tool) => [`start:${tool.name}`, `end:${tool.name}`]),
      );
      expect(deps.executeTool).toHaveBeenCalledTimes(2);
    },
  );
  it('preserves the accepted D3 liquid-balance window difference', async () => {
    const testCase = cases.find((item) => item.id === 'D3')!;
    const data = await toolResponse().json();
    data.choices[0].message.tool_calls = testCase.requiredTools.map(
      (tool, index) => ({
        id: `call-${index}`,
        type: 'function',
        function: {
          name: tool.name,
          arguments: JSON.stringify(
            tool.name === 'get_financial_snapshot'
              ? { ...tool.params, months: 1 }
              : tool.params,
          ),
        },
      }),
    );
    const deps = options();
    deps.step
      .mockReset()
      .mockResolvedValueOnce(Response.json(data))
      .mockResolvedValueOnce(
        sse(
          'Cần dành 4 triệu/tháng. Còn lại sau phân bổ 1 triệu/tháng. Số dư khả dụng 12 triệu.',
        ),
      );

    const report = await runToolCallingCase(testCase, deps);

    expect(report).toMatchObject({
      correctTools: true,
      sseValid: true,
      parameterDifferences: ['get_financial_snapshot'],
    });
    expect(deps.executeTool).toHaveBeenCalledWith(
      'get_financial_snapshot',
      { months: 1, fields: ['liquid_balance'] },
      expect.any(Array),
      expect.any(Object),
    );
  });
  it('does not pass incorrect numbers just because tool selection was correct', async () => {
    const deps = options();
    deps.step
      .mockReset()
      .mockResolvedValueOnce(toolResponse())
      .mockResolvedValueOnce(
        sse(
          'Dư trước mục tiêu 5 triệu/tháng. Cần dành 2 triệu/tháng. Còn lại sau phân bổ 3 triệu/tháng.',
        ),
      );
    expect(await runToolCallingCase(cases[2], deps)).toMatchObject({
      passed: false,
      correctTools: true,
      businessCorrect: false,
      needsReview: true,
    });
  });
  it.each([
    ['C1', 'savingsForGoal'],
    ['C2', 'savingsMonths'],
  ])('ends %s locally with the expected missing field', async (id, field) => {
    const deps = options();
    deps.executeTool.mockResolvedValue({
      status: 'needs_clarification',
      fields: [field],
    });
    expect(
      await runToolCallingCase(
        cases.find((item) => item.id === id)!,
        deps,
      ),
    ).toMatchObject({
      passed: true,
      correctTools: true,
      businessCorrect: true,
      fallback: false,
      clarificationFields: [field],
    });
    expect(deps.step).toHaveBeenCalledOnce();
  });
  it('fails incomplete SSE even if the received numbers are correct', async () => {
    const deps = options();
    deps.step
      .mockReset()
      .mockResolvedValueOnce(toolResponse())
      .mockResolvedValueOnce(
        sse(
          'Dư trước mục tiêu 5 triệu/tháng. Cần dành 4 triệu/tháng. Còn lại sau phân bổ 1 triệu/tháng.',
          false,
        ),
      );
    expect(await runToolCallingCase(cases[2], deps)).toMatchObject({
      passed: false,
      sseValid: false,
      protocolError: true,
    });
  });
  it('stops a smoke suite immediately on the first protocol failure and preserves raw data', async () => {
    const deps = options();
    deps.step
      .mockReset()
      .mockResolvedValue(new Response('raw-provider-error', { status: 500 }));
    const reports = await runToolCallingSuite(cases, deps);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      protocolError: true,
      rawResponses: [{ status: 500, body: 'raw-provider-error' }],
    });
    expect(deps.step).toHaveBeenCalledOnce();
    expect(reports[0].usage.missingCalls).toBe(1);
    expect(summarizeToolCalling(reports)).toMatchObject({
      turns: 1,
      schemaPercent: 0,
      correctToolPercent: 0,
      businessPercent: 0,
      fallbackPercent: 100,
    });
  });
  it('does not accept a final answer that arrives after the whole-turn deadline', async () => {
    const deps = options();
    let time = 0;
    deps.step
      .mockReset()
      .mockResolvedValueOnce(toolResponse())
      .mockImplementationOnce(async () => {
        time = 30_001;
        return sse(
          'Dư trước mục tiêu 5 triệu/tháng. Cần dành 4 triệu/tháng. Còn lại sau phân bổ 1 triệu/tháng.',
        );
      });
    expect(
      await runToolCallingCase(cases[2], { ...deps, now: () => time }),
    ).toMatchObject({ passed: false, error: 'TURN_TIMEOUT', fallback: true });
  });
});
