import { describe, expect, it, vi } from 'vitest';
import { readAgentFinalSse } from './agent-sse-reader';
const event = (name: string, data: unknown) =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const delta = (seq: number, text: string) =>
  event('delta', { seq, text, verification: 'segment_passed' });
const done = event('done', { incomplete: false, verification: 'passed' });
const response = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });
describe('readAgentFinalSse', () => {
  it('stops processing remaining events in the same chunk when a callback aborts', async () => {
    const controller = new AbortController();
    const onDelta = vi.fn(() => controller.abort());
    expect(
      await readAgentFinalSse(
        response(delta(1, 'safe') + delta(2, 'later') + done),
        { signal: controller.signal, onDelta },
      ),
    ).toMatchObject({
      status: 'incomplete',
      text: 'safe',
      errorCode: 'STREAM_TIMEOUT',
    });
    expect(onDelta).toHaveBeenCalledOnce();
  });
  it('parses multi-line data and CR-only frames through response.text fallback', async () => {
    const text =
      ': note\revent: delta\rdata: {"seq":1,\rdata: "text":"ok","verification":"segment_passed"}\r\revent: done\rdata: {"incomplete":false,"verification":"passed"}\r\r';
    const fallback = {
      body: null,
      headers: new Headers({
        'content-type': 'TEXT/EVENT-STREAM; charset=utf-8',
      }),
      text: async () => text,
    } as Response;
    expect(await readAgentFinalSse(fallback)).toMatchObject({
      status: 'completed',
      text: 'ok',
    });
  });
  it.each([
    delta(1, 'ok') + delta(1, 'duplicate'),
    delta(1, 'ok') + delta(3, 'skipped'),
    event('delta', { seq: 1, text: '', verification: 'segment_passed' }),
    'data: {"seq":1}\n\n',
    'event: delta\ndata: {bad}\n\n',
    event('unknown', {}),
    event('done', { incomplete: false, verification: 'passed' }),
  ])('rejects malformed protocol case %#', async (body) => {
    expect(await readAgentFinalSse(response(body))).toMatchObject({
      status: 'incomplete',
      errorCode: 'STREAM_INTERRUPTED',
    });
  });
  it('rejects non-SSE content and cancels the body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    expect(
      await readAgentFinalSse(
        new Response(body, { headers: { 'content-type': 'application/json' } }),
      ),
    ).toMatchObject({ errorCode: 'INVALID_CONTENT_TYPE', text: '' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects invalid UTF-8 and retains earlier verified text', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(delta(1, 'safe')));
        controller.enqueue(new Uint8Array([0xff]));
        controller.close();
      },
    });
    expect(
      await readAgentFinalSse(
        new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    ).toMatchObject({ text: 'safe', errorCode: 'STREAM_INTERRUPTED' });
  });
  it('retains earlier text on transport errors and both length limits', async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(delta(1, 'safe')));
      },
      pull(controller) {
        controller.error(new Error('network'));
      },
    });
    expect(
      await readAgentFinalSse(
        new Response(failing, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    ).toMatchObject({ text: 'safe', errorCode: 'STREAM_INTERRUPTED' });
    expect(
      await readAgentFinalSse(response(delta(1, 'safe') + delta(2, 'large')), {
        maxTotalChars: 5,
      }),
    ).toMatchObject({ text: 'safe', errorCode: 'STREAM_TRUNCATED' });
    expect(
      await readAgentFinalSse(
        response(delta(1, 'safe') + 'event: delta\ndata: ' + 'x'.repeat(100)),
        { maxEventChars: 80 },
      ),
    ).toMatchObject({ text: 'safe', errorCode: 'STREAM_INTERRUPTED' });
  });
  it('returns a verification failure before any text without leaking it', async () => {
    expect(
      await readAgentFinalSse(
        response(
          event('error', {
            code: 'VERIFICATION_FAILED',
            incomplete: true,
            verification: 'failed',
          }),
        ),
      ),
    ).toEqual({
      status: 'incomplete',
      text: '',
      incomplete: true,
      verification: 'failed',
      errorCode: 'VERIFICATION_FAILED',
    });
  });
  it('emits sequential verified deltas and completes', async () => {
    const onDelta = vi.fn();
    expect(
      await readAgentFinalSse(
        response(delta(1, 'Chào ') + delta(2, 'bạn') + done),
        { onDelta },
      ),
    ).toEqual({
      status: 'completed',
      text: 'Chào bạn',
      incomplete: false,
      verification: 'passed',
    });
    expect(onDelta.mock.calls.map(([item]) => item.verifiedText)).toEqual([
      'Chào ',
      'Chào bạn',
    ]);
  });
  it('handles UTF-8 split into bytes and CRLF boundaries', async () => {
    const bytes = new TextEncoder().encode(
      ': comment\r\n' +
        delta(1, 'Tiết kiệm').replace(/\n/g, '\r\n') +
        done.replace(/\n/g, '\r\n'),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    expect(
      await readAgentFinalSse(
        new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    ).toMatchObject({ status: 'completed', text: 'Tiết kiệm' });
  });
  it('keeps verified text on an error event', async () => {
    expect(
      await readAgentFinalSse(
        response(
          delta(1, 'An toàn.') +
            event('error', {
              code: 'VERIFICATION_FAILED',
              incomplete: true,
              verification: 'failed',
            }),
        ),
      ),
    ).toMatchObject({
      status: 'incomplete',
      text: 'An toàn.',
      verification: 'failed',
      errorCode: 'VERIFICATION_FAILED',
    });
  });
  it.each([
    delta(2, 'wrong'),
    event('delta', { seq: 1, text: 'x', verification: 'wrong' }),
    done,
    delta(1, 'x') + done + delta(2, 'bad'),
    'unverified text',
    delta(1, 'x'),
  ])('rejects invalid stream %#', async (body) => {
    expect(await readAgentFinalSse(response(body))).toMatchObject({
      status: 'incomplete',
      errorCode: 'STREAM_INTERRUPTED',
    });
  });
  it('never treats fallback response.text as verified text', async () => {
    const fallback = {
      body: null,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () => 'raw unverified text',
    } as Response;
    expect(await readAgentFinalSse(fallback)).toMatchObject({
      status: 'incomplete',
      text: '',
      errorCode: 'STREAM_INTERRUPTED',
    });
  });
  it('aborts even when reading ignores the signal', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const pending = readAgentFinalSse(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      { signal: controller.signal },
    );
    controller.abort();
    expect(await pending).toMatchObject({
      status: 'incomplete',
      errorCode: 'STREAM_TIMEOUT',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
