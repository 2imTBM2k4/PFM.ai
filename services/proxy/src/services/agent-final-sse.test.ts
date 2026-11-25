import { expect, it, vi } from 'vitest';
import { verifyAgentFinalSse } from './agent-final-sse';
const encoder = new TextEncoder();
const event = (delta: object, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const source = (value: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
it('emits verified sentences and completes once', async () => {
  const finish = vi.fn();
  const body =
    event({ content: 'Tôi có thể giúp. Bạn hãy cân nhắc.' }) +
    event({}, 'stop') +
    'data: [DONE]\n\n';
  const result = await new Response(
    verifyAgentFinalSse(
      source(body),
      new AbortController().signal,
      { tools: [] },
      finish,
    ),
  ).text();
  expect(result).toContain('event: delta');
  expect(result).toContain('"verification":"passed"');
  expect(finish).toHaveBeenCalledExactlyOnceWith(true);
});
it('fails an ungrounded number without emitting it', async () => {
  const finish = vi.fn();
  const body =
    event({ content: 'Số tiền là 5 triệu.' }) +
    event({}, 'stop') +
    'data: [DONE]\n\n';
  const result = await new Response(
    verifyAgentFinalSse(
      source(body),
      new AbortController().signal,
      { tools: [] },
      finish,
    ),
  ).text();
  expect(result).not.toContain('5 triệu');
  expect(result).toContain('VERIFICATION_FAILED');
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
});
it('rejects a direct stream missing DONE', async () => {
  const finish = vi.fn();
  const result = await new Response(
    verifyAgentFinalSse(
      source(event({ content: 'Hãy cân nhắc.' }) + event({}, 'stop')),
      new AbortController().signal,
      { tools: [] },
      finish,
    ),
  ).text();
  expect(result).toContain('STREAM_INTERRUPTED');
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
});
it('handles UTF-8 split across bytes and never emits a partial monetary amount', async () => {
  const evidence = {
    tools: [
      {
        name: 'plan_savings_goal' as const,
        params: {},
        data: {
          monthlyAvailable: 5000000,
          requiredMonthlySaving: 4000000,
          remainingAfterSaving: 1000000,
          months: 6,
          goalAmount: 24000000,
          savingsForGoal: 0,
        },
      },
    ],
  };
  const text =
    event({ content: 'Số tiền là 5.000' }) +
    event({ content: '.000 đ.\n\n' }) +
    event({}, 'stop') +
    'data: [DONE]\n\n';
  const bytes = encoder.encode(text);
  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const finish = vi.fn();
  const output = await new Response(
    verifyAgentFinalSse(chunks, new AbortController().signal, evidence, finish),
  ).text();
  expect(output).toContain('5.000.000 đ');
  expect(output).toContain('event: done');
  expect(finish).toHaveBeenCalledExactlyOnceWith(true);
});
it('keeps a verified first sentence and withholds a fabricated second one', async () => {
  const finish = vi.fn();
  const body =
    event({ content: 'Hãy cân nhắc. Số tiền là 5 triệu.' }) +
    event({}, 'stop') +
    'data: [DONE]\n\n';
  const output = await new Response(
    verifyAgentFinalSse(
      source(body),
      new AbortController().signal,
      { tools: [] },
      finish,
    ),
  ).text();
  expect(output).toContain('Hãy cân nhắc.');
  expect(output).not.toContain('5 triệu');
  expect(output).toContain('VERIFICATION_FAILED');
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
});
it('retains complete segments but withholds an interrupted tail', async () => {
  const finish = vi.fn();
  const output = await new Response(
    verifyAgentFinalSse(
      source(event({ content: 'Hãy cân nhắc. Đang phân tích' })),
      new AbortController().signal,
      { tools: [] },
      finish,
    ),
  ).text();
  expect(output).toContain('Hãy cân nhắc.');
  expect(output).not.toContain('Đang phân tích');
  expect(output).toContain('STREAM_INTERRUPTED');
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
});
it.each([
  [event({}, 'length'), 'STREAM_TRUNCATED'],
  [event({ tool_calls: [] }), 'STREAM_INTERRUPTED'],
  ['data: {broken}\n\n', 'STREAM_INTERRUPTED'],
  [
    event({ content: ' ' }) + event({}, 'stop') + 'data: [DONE]\n\n',
    'STREAM_INTERRUPTED',
  ],
])('rejects invalid upstream data %#', async (body, code) => {
  const finish = vi.fn();
  const output = await new Response(
    verifyAgentFinalSse(
      source(body),
      new AbortController().signal,
      { tools: [] },
      finish,
    ),
  ).text();
  expect(output).toContain(code);
  expect(output).not.toContain('event: done');
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
});
it('aborts a stalled upstream without waiting for it', async () => {
  const abort = new AbortController();
  const finish = vi.fn();
  const cancel = vi.fn();
  const upstream = new ReadableStream<Uint8Array>({ cancel });
  const pending = new Response(
    verifyAgentFinalSse(upstream, abort.signal, { tools: [] }, finish),
  ).text();
  abort.abort();
  expect(await pending).toContain('STREAM_TIMEOUT');
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
  expect(cancel).toHaveBeenCalledOnce();
});
it('cancels the upstream exactly once when the consumer cancels', async () => {
  const finish = vi.fn();
  const cancel = vi.fn();
  const output = verifyAgentFinalSse(
    new ReadableStream<Uint8Array>({ cancel }),
    new AbortController().signal,
    { tools: [] },
    finish,
  );
  await output.cancel();
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
  expect(cancel).toHaveBeenCalledOnce();
});
it('rejects data after DONE', async () => {
  const finish = vi.fn();
  const body =
    event({ content: 'Hãy cân nhắc.' }) +
    event({}, 'stop') +
    'data: [DONE]\n\n' +
    event({ content: 'Thêm.' });
  const output = await new Response(
    verifyAgentFinalSse(
      source(body),
      new AbortController().signal,
      { tools: [] },
      finish,
    ),
  ).text();
  expect(output).toContain('STREAM_INTERRUPTED');
  expect(output).not.toContain('event: done');
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
});
it('accepts null content before text and on the stop chunk', async () => {
  const finish = vi.fn();
  const body =
    event({ role: 'assistant', content: null }) +
    event({ content: 'Cân nhắc.' }) +
    event({ content: null }, 'stop') +
    'data: [DONE]\n\n';
  const output = await new Response(
    verifyAgentFinalSse(
      source(body),
      new AbortController().signal,
      { tools: [] },
      finish,
    ),
  ).text();
  expect(output).toContain('event: done');
  expect(finish).toHaveBeenCalledExactlyOnceWith(true);
});
it.each([
  event({ content: 123 }),
  event({ content: 'Cân nhắc.' }) +
    event({}, 'stop') +
    event({ content: 'không hợp lệ' }) +
    'data: [DONE]\n\n',
  event({ content: 'Cân nhắc.' }) +
    event({}, 'stop') +
    'data: [DONE]\n\nevent: other\n\n',
])('rejects invalid content and events after DONE %#', async (body) => {
  const finish = vi.fn();
  const output = await new Response(
    verifyAgentFinalSse(
      source(body),
      new AbortController().signal,
      { tools: [] },
      finish,
    ),
  ).text();
  expect(output).toContain('STREAM_INTERRUPTED');
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
});
it('reports text length overflow without emitting an unchecked tail', async () => {
  const finish = vi.fn();
  const output = await new Response(
    verifyAgentFinalSse(
      source(event({ content: 'Một đoạn dài' })),
      new AbortController().signal,
      { tools: [] },
      finish,
      { maxTotalChars: 4 },
    ),
  ).text();
  expect(output).toContain('STREAM_TRUNCATED');
  expect(output).not.toContain('Một đoạn dài');
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
});
