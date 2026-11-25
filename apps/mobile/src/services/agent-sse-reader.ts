export interface AgentVerifiedDelta {
  seq: number;
  text: string;
  verifiedText: string;
  verification: 'segment_passed';
}
export type AgentFinalSseResult =
  | {
      status: 'completed';
      text: string;
      incomplete: false;
      verification: 'passed';
    }
  | {
      status: 'incomplete';
      text: string;
      incomplete: true;
      verification: 'failed' | 'incomplete';
      errorCode: string;
    };

/** Read only strictly framed and verified application SSE events. */
export async function readAgentFinalSse(
  response: Response,
  options: {
    signal?: AbortSignal;
    onDelta?: (delta: AgentVerifiedDelta) => void;
    maxEventChars?: number;
    maxTotalChars?: number;
  } = {},
): Promise<AgentFinalSseResult> {
  const { signal } = options;
  let verifiedText = '';
  let expectedSeq = 1;
  let done = false;
  let pending = '';
  let frameChars = 0;
  let eventName = '';
  let data: string[] = [];
  let hasFields = false;
  let terminal: AgentFinalSseResult | undefined;
  let completed = false;
  const incomplete = (
    errorCode: string,
    verification: 'failed' | 'incomplete' = 'incomplete',
  ): AgentFinalSseResult => ({
    status: 'incomplete',
    text: verifiedText,
    incomplete: true,
    verification,
    errorCode,
  });
  const wait = <T>(operation: Promise<T>): Promise<T> => {
    if (!signal) return operation;
    if (signal.aborted) {
      void operation.catch(() => {});
      return Promise.reject(new Error('ABORT'));
    }
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('ABORT'));
      signal.addEventListener('abort', abort, { once: true });
      operation
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
  };
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('text/event-stream')
  ) {
    try {
      void response.body?.cancel().catch(() => {});
    } catch {
      /* Cancellation is best-effort. */
    }
    return incomplete('INVALID_CONTENT_TYPE');
  }
  const dispatch = () => {
    if (!hasFields) return;
    if (done || !eventName || data.length === 0) throw new Error('FRAME');
    const payload: unknown = JSON.parse(data.join('\n'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('PAYLOAD');
    const value = payload as Record<string, unknown>;
    if (eventName === 'delta') {
      if (
        !Number.isSafeInteger(value.seq) ||
        value.seq !== expectedSeq ||
        typeof value.text !== 'string' ||
        !value.text.length ||
        value.verification !== 'segment_passed'
      )
        throw new Error('DELTA');
      if (
        verifiedText.length + value.text.length >
        (options.maxTotalChars ?? 16384)
      ) {
        terminal = incomplete('STREAM_TRUNCATED');
        return;
      }
      verifiedText += value.text;
      expectedSeq++;
      options.onDelta?.({
        seq: value.seq as number,
        text: value.text,
        verifiedText,
        verification: 'segment_passed',
      });
    } else if (eventName === 'done') {
      if (
        value.incomplete !== false ||
        value.verification !== 'passed' ||
        !verifiedText.trim()
      )
        throw new Error('DONE');
      done = true;
    } else if (eventName === 'error') {
      if (
        typeof value.code !== 'string' ||
        !value.code.trim() ||
        value.incomplete !== true ||
        (value.verification !== undefined && value.verification !== 'failed')
      )
        throw new Error('ERROR');
      terminal = incomplete(
        value.code,
        value.verification === 'failed' ? 'failed' : 'incomplete',
      );
    } else throw new Error('EVENT');
  };
  const line = (value: string) => {
    if (!value) {
      dispatch();
      eventName = '';
      data = [];
      hasFields = false;
      frameChars = 0;
      return;
    }
    frameChars += value.length + 1;
    if (frameChars > (options.maxEventChars ?? 65536)) throw new Error('FRAME');
    if (value.startsWith(':')) return;
    if (done) throw new Error('AFTER_DONE');
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    hasFields = true;
    if (field === 'event') eventName = content;
    else if (field === 'data') data.push(content);
    else throw new Error('FIELD');
  };
  const feed = (value: string, eof = false) => {
    pending += value;
    while (!terminal) {
      if (signal?.aborted) throw new Error('ABORT');
      const index = pending.search(/[\r\n]/);
      if (index < 0) break;
      if (!eof && pending[index] === '\r' && index === pending.length - 1)
        break;
      const width =
        pending[index] === '\r' && pending[index + 1] === '\n' ? 2 : 1;
      line(pending.slice(0, index));
      pending = pending.slice(index + width);
    }
    if (
      !terminal &&
      frameChars + pending.length > (options.maxEventChars ?? 65536)
    )
      throw new Error('FRAME');
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (response.body && typeof response.body.getReader === 'function') {
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      while (!terminal) {
        const chunk = await wait(reader.read());
        if (chunk.done) {
          feed(decoder.decode(), true);
          break;
        }
        feed(decoder.decode(chunk.value, { stream: true }));
      }
    } else feed(await wait(response.text()), true);
    if (terminal) return terminal;
    if (signal?.aborted) return incomplete('STREAM_TIMEOUT');
    if (!done || pending.length || hasFields)
      return incomplete('STREAM_INTERRUPTED');
    completed = true;
    return {
      status: 'completed',
      text: verifiedText,
      incomplete: false,
      verification: 'passed',
    };
  } catch {
    return incomplete(
      signal?.aborted ? 'STREAM_TIMEOUT' : 'STREAM_INTERRUPTED',
    );
  } finally {
    if (reader && !completed) {
      try {
        void reader.cancel().catch(() => {});
      } catch {
        /* Cancellation is best-effort. */
      }
    }
  }
}
