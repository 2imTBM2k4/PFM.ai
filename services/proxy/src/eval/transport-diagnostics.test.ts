import { expect, it, vi } from 'vitest';
import { diagnoseFetch, type TransportCapture } from './transport-diagnostics';

it('keeps an upstream timeout as the first abort when the runner aborts afterwards', async () => {
  const upstream = new AbortController();
  const runner = new AbortController();
  let completed!: Promise<TransportCapture>;
  const mock = vi.fn<typeof fetch>(async (_url, init) => {
    upstream.abort(new DOMException('synthetic timeout', 'TimeoutError'));
    runner.abort();
    throw init?.signal?.reason;
  });
  await expect(
    diagnoseFetch(
      mock,
      'http://synthetic.invalid',
      { signal: upstream.signal },
      runner.signal,
      (capture) => {
        completed = capture;
      },
    ),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(await completed).toMatchObject({
    firstAbort: { source: 'upstream', name: 'TimeoutError' },
    error: { phase: 'headers', name: 'TimeoutError' },
  });
});

it('keeps upstream partial UTF-8 bytes, timing and the first abort source', async () => {
  let time = 100;
  const runner = new AbortController();
  const upstream = new AbortController();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let completed!: Promise<TransportCapture>;
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    time = 110;
    return new Response(
      new ReadableStream({
        start(controller) {
          source = controller;
          init?.signal?.addEventListener('abort', () =>
            controller.error(init.signal?.reason),
          );
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const response = await diagnoseFetch(
    fetchMock,
    'http://synthetic.invalid',
    { signal: upstream.signal },
    runner.signal,
    (capture) => {
      completed = capture;
    },
    () => time,
  );
  const reader = response.body!.getReader();
  time = 120;
  const bytes = new TextEncoder().encode('dữ liệu giả');
  source.enqueue(bytes.slice(0, 2));
  expect((await reader.read()).value).toEqual(bytes.slice(0, 2));
  source.enqueue(bytes.slice(2));
  await reader.read();
  // Allow the clone reader to consume the queued prefix before simulating interruption.
  await new Promise((resolve) => setTimeout(resolve, 10));
  time = 150;
  runner.abort(new DOMException('do not persist message', 'TimeoutError'));
  await expect(reader.read()).rejects.toMatchObject({ name: 'TimeoutError' });
  const capture = await completed;
  expect(capture).toMatchObject({
    status: 200,
    headersMs: 10,
    firstChunkMs: 20,
    endedMs: 50,
    bytesReceived: bytes.length,
    body: 'dữ liệu giả',
    complete: false,
    firstAbort: { source: 'runner', name: 'TimeoutError', atMs: 50 },
    error: { phase: 'body', name: 'TimeoutError' },
  });
  upstream.abort();
  expect(capture.firstAbort?.source).toBe('runner');
  expect(JSON.stringify(capture)).not.toContain('do not persist');
});

it('records a fetch failure before headers without logging its URL or error message', async () => {
  let completed!: Promise<TransportCapture>;
  const fail = Object.assign(new TypeError('secret URL and token'), {
    cause: { code: 'ECONNREFUSED' },
  });
  const mock = vi.fn<typeof fetch>().mockRejectedValue(fail);
  await expect(
    diagnoseFetch(mock, 'http://secret.invalid', {}, undefined, (capture) => {
      completed = capture;
    }),
  ).rejects.toBe(fail);
  expect(await completed).toMatchObject({
    status: null,
    body: '',
    complete: false,
    headersMs: null,
    firstChunkMs: null,
    error: { name: 'TypeError', code: 'ECONNREFUSED', phase: 'headers' },
  });
  expect(JSON.stringify(await completed)).not.toContain('secret');
});

it('records a clean EOF and removes abort listeners before a later response-close abort', async () => {
  let completed!: Promise<TransportCapture>;
  const controller = new AbortController();
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('data: [DONE]\n\n'));
  const response = await diagnoseFetch(
    mock,
    'http://synthetic.invalid',
    { signal: controller.signal },
    undefined,
    (capture) => {
      completed = capture;
    },
  );
  expect(await response.text()).toBe('data: [DONE]\n\n');
  const capture = await completed;
  expect(capture).toMatchObject({ complete: true, body: 'data: [DONE]\n\n' });
  controller.abort();
  expect(capture.firstAbort).toBeUndefined();
  expect(capture.error).toBeUndefined();
});
