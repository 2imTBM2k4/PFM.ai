import { describe, expect, it } from 'vitest';
import { settleTurnStream } from './agent-turn-stream';

const text =
  'data: {"choices":[{"index":0,"delta":{"content":"Nội dung"}}]}\n\n';
const stop =
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
const done = 'data: [DONE]\n\n';
async function collect(parts: string[], abort = false) {
  const controller = new AbortController();
  const outcomes: boolean[] = [];
  const source = new ReadableStream<Uint8Array>({
    start(stream) {
      for (const part of parts) stream.enqueue(new TextEncoder().encode(part));
      stream.close();
    },
  });
  if (abort) controller.abort();
  const body = await new Response(
    settleTurnStream(source, controller.signal, (complete) =>
      outcomes.push(complete),
    ),
  ).text();
  return { body, outcomes };
}
describe('turn SSE transport settlement', () => {
  it.each(['error', 'failed', 'incomplete'])(
    'refunds a stream carrying event:%s even if it later sends stop and DONE',
    async (event) => {
      const result = await collect([
        text,
        `event: ${event}\ndata: {"choices":[]}\n\n`,
        stop,
        done,
      ]);
      expect(result.outcomes).toEqual([false]);
      expect(result.body).toContain('event: incomplete');
    },
  );
  it.each([
    [text, stop, done],
    [...(text + stop + done)].map((character) => character),
    [(text + stop + done).replaceAll('\n', '\r\n')],
    [
      text,
      stop,
      'data: {"choices":[],"usage":{"completion_tokens":12}}\n\n',
      done,
    ],
  ])('settles complete framed transport once: %j', async (...parts) => {
    const result = await collect(parts);
    expect(result.outcomes).toEqual([true]);
    expect(result.body).not.toContain('incomplete');
  });
  it.each([
    [text],
    [text, stop],
    [text, done],
    [stop, done],
    [text, stop.replace('stop', 'length'), done],
    [text, 'data: {broken}\n\n'],
    [text, 'data: {"error":{"message":"provider failure"}}\n\n'],
    [text, stop, done, text],
    [text, stop, done, 'data: incomplete'],
    [
      text,
      'data: {"choices":[{"delta":{"tool_calls":[{}]},"finish_reason":"tool_calls"}]}\n\n',
      done,
    ],
  ])(
    'refunds an incomplete or invalid transport once: %j',
    async (...parts) => {
      const result = await collect(parts);
      expect(result.outcomes).toEqual([false]);
      expect(result.body).toContain('event: incomplete');
      if (parts.includes(text)) expect(result.body).toContain('Nội dung');
    },
  );
  it('refunds on abort without trusting a buffered complete response', async () => {
    expect((await collect([text, stop, done], true)).outcomes).toEqual([false]);
  });
  it('refunds client cancellation once', async () => {
    const outcomes: boolean[] = [];
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const stream = settleTurnStream(
      source,
      new AbortController().signal,
      (complete) => outcomes.push(complete),
    );
    await stream.cancel();
    expect(outcomes).toEqual([false]);
    expect(cancelled).toBe(true);
  });
});
