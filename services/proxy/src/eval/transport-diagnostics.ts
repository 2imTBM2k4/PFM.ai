export interface TransportCapture {
  startedAtMs: number;
  headersMs: number | null;
  firstChunkMs: number | null;
  endedMs: number | null;
  status: number | null;
  bytesReceived: number;
  body: string;
  complete: boolean;
  firstAbort?: { source: 'runner' | 'upstream'; name: string; atMs: number };
  error?: { name: string; code?: string; phase: 'headers' | 'body' };
}

export function createTransportCapture(
  now = () => performance.now(),
): TransportCapture {
  return {
    startedAtMs: now(),
    headersMs: null,
    firstChunkMs: null,
    endedMs: null,
    status: null,
    bytesReceived: 0,
    body: '',
    complete: false,
  };
}

function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(name)
    ? name
    : 'UnknownError';
}

/** Keep diagnostic codes, never arbitrary messages, stacks, URLs or credentials. */
export function recordTransportError(
  capture: TransportCapture,
  error: unknown,
  now = () => performance.now(),
) {
  const cause = error instanceof Error ? error.cause : undefined;
  const rawCode =
    (cause && typeof cause === 'object' && 'code' in cause
      ? cause.code
      : undefined) ??
    (error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined);
  const code =
    typeof rawCode === 'string' &&
    /^(UND_ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)$/.test(
      rawCode,
    )
      ? rawCode
      : undefined;
  capture.error = {
    name: errorName(error),
    ...(code ? { code } : {}),
    phase: capture.status === null ? 'headers' : 'body',
  };
  capture.endedMs = now() - capture.startedAtMs;
}

export function watchTransportAborts(
  capture: TransportCapture,
  signals: { source: 'runner' | 'upstream'; signal?: AbortSignal | null }[],
  now = () => performance.now(),
): () => void {
  const listeners = signals.flatMap(({ source, signal }) => {
    if (!signal) return [];
    const listener = () => {
      capture.firstAbort ??= {
        source,
        name: errorName(signal.reason),
        atMs: now() - capture.startedAtMs,
      };
    };
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
    return [() => signal.removeEventListener('abort', listener)];
  });
  return () => listeners.forEach((remove) => remove());
}

/** Retain synthetic response prefixes even when a later read rejects; never mark them complete. */
export async function readTransportBody(
  response: Response,
  capture: TransportCapture,
  now = () => performance.now(),
): Promise<string> {
  capture.status = response.status;
  capture.headersMs = now() - capture.startedAtMs;
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  try {
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value.length) capture.firstChunkMs ??= now() - capture.startedAtMs;
        capture.bytesReceived += value.length;
        capture.body += decoder.decode(value, { stream: true });
      }
    }
    capture.body += decoder.decode();
    capture.complete = true;
    return capture.body;
  } catch (error) {
    recordTransportError(capture, error, now);
    throw error;
  } finally {
    capture.endedMs = now() - capture.startedAtMs;
    reader?.releaseLock();
  }
}

/** Observe the synthetic upstream fetch without delaying or rewriting the original response. */
export async function diagnoseFetch(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  runnerSignal: AbortSignal | undefined,
  onCapture: (capture: Promise<TransportCapture>) => void,
  now = () => performance.now(),
): Promise<Response> {
  const capture = createTransportCapture(now);
  const cleanup = watchTransportAborts(
    capture,
    [
      { source: 'upstream', signal: init.signal },
      { source: 'runner', signal: runnerSignal },
    ],
    now,
  );
  const signals = [init.signal, runnerSignal].filter(
    (signal): signal is AbortSignal => !!signal,
  );
  try {
    const response = await fetchImpl(input, {
      ...init,
      signal: AbortSignal.any(signals),
    });
    onCapture(
      readTransportBody(response.clone(), capture, now)
        .then(
          () => capture,
          () => capture,
        )
        .finally(cleanup),
    );
    return response;
  } catch (error) {
    recordTransportError(capture, error, now);
    cleanup();
    onCapture(Promise.resolve(capture));
    throw error;
  }
}
