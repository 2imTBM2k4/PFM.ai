import { expect, it, vi } from 'vitest';
import { normalizeFinalSse } from './normalize-final-sse';

const encoder = new TextEncoder();
const event = (
  delta: Record<string, unknown>,
  finish_reason: string | null = null,
) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const text = event({ role: 'assistant', content: 'Còn 1 triệu đồng.' });
const stop = event({}, 'stop');
const done = 'data: [DONE]\n\n';
function stream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
const normalize = (body: string) =>
  new Response(normalizeFinalSse(stream([encoder.encode(body)]))).text();

it('appends exactly one DONE after a complete text response and normal EOF', async () => {
  expect(await normalize(text + stop)).toBe(text + stop + done);
});
it('preserves an existing DONE byte for byte', async () => {
  expect(await normalize(text + stop + done)).toBe(text + stop + done);
});
it('passes text through before upstream EOF instead of buffering the response', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
  });
  const reader = normalizeFinalSse(input).getReader();
  source.enqueue(encoder.encode(text));
  expect((await reader.read()).value).toEqual(encoder.encode(text));
  source.enqueue(encoder.encode(stop));
  source.close();
  expect((await reader.read()).value).toEqual(encoder.encode(stop));
  expect((await reader.read()).value).toEqual(encoder.encode(done));
  expect((await reader.read()).done).toBe(true);
});
it.each(['\n', '\r\n', '\r'])(
  'handles every-byte UTF-8 and event-boundary splits with %j line endings',
  async (lineEnding) => {
    const body = (text + stop).replaceAll('\n', lineEnding);
    const bytes = encoder.encode(body);
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    expect(await new Response(normalizeFinalSse(stream(chunks))).text()).toBe(
      body + done,
    );
  },
);
it('allows comments, multiline data and a trailing usage-only event', async () => {
  const multiline =
    'data: {"choices":\n' +
    'data: [{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
  const body =
    ': keepalive\n\n' +
    text +
    multiline +
    'data: {"choices":[],"usage":{"completion_tokens":10}}\n\n';
  expect(await normalize(body)).toBe(body + done);
});
it.each([
  ['missing stop', text],
  ['length', text + event({}, 'length')],
  ['content filter', text + event({}, 'content_filter')],
  ['tool finish', text + event({}, 'tool_calls')],
  ['tool delta', text + event({ tool_calls: [{ id: 'call-1' }] }) + stop],
  [
    'legacy function delta',
    text + event({ function_call: { name: 'get_transactions' } }) + stop,
  ],
  ['error event', text + 'event: error\ndata: {"error":"failed"}\n\n' + stop],
  ['malformed JSON', text + 'data: {broken}\n\n' + stop],
  ['unfinished event', text + stop.trimEnd()],
  ['data after stop', text + stop + event({ content: 'more' })],
  [
    'multiple choices',
    text +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"},{"index":1,"delta":{},"finish_reason":"stop"}]}\n\n',
  ],
  ['no text', event({ reasoning_content: 'private' }) + stop],
  ['oversized event', event({ content: 'a'.repeat(65_537) }) + stop],
])('does not manufacture success for %s', async (_label, body) => {
  expect(await normalize(body)).toBe(body);
});
it('preserves bytes but does not append DONE after invalid UTF-8', async () => {
  const prefix = encoder.encode(text + stop);
  const bytes = new Uint8Array([...prefix, 255]);
  const output = new Uint8Array(
    await new Response(normalizeFinalSse(stream([bytes]))).arrayBuffer(),
  );
  expect(output).toEqual(bytes);
});
it('does not append DONE after an upstream error, retaining the received prefix', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
  });
  const reader = normalizeFinalSse(input).getReader();
  source.enqueue(encoder.encode(text + stop));
  expect((await reader.read()).value).toEqual(encoder.encode(text + stop));
  source.error(new Error('upstream disconnected'));
  await expect(reader.read()).rejects.toThrow('upstream disconnected');
});
it('does not append DONE after cancellation or timeout signalled at EOF', async () => {
  const abort = new AbortController();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
  });
  const reader = normalizeFinalSse(input, abort.signal).getReader();
  source.enqueue(encoder.encode(text + stop));
  expect((await reader.read()).value).toEqual(encoder.encode(text + stop));
  abort.abort(new DOMException('timeout', 'TimeoutError'));
  source.close();
  expect((await reader.read()).done).toBe(true);
});
it('propagates downstream cancellation to upstream', async () => {
  const cancel = vi.fn();
  const input = new ReadableStream<Uint8Array>({ cancel });
  const reader = normalizeFinalSse(input).getReader();
  await reader.cancel('client disconnected');
  await vi.waitFor(() =>
    expect(cancel).toHaveBeenCalledWith('client disconnected'),
  );
});
