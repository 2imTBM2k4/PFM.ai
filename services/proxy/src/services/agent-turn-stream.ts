/** Stop waiting even when a transport implementation ignores AbortSignal. */
export function awaitTurnSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Turn transport aborted.'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Observe complete SSE transport only; financial sentence verification belongs to phase 5.3. */
export function settleTurnStream(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  finish: (complete: boolean) => void,
) {
  const reader = source.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let hasText = false;
  let stopped = false;
  let done = false;
  let valid = true;
  let closed = false;
  const inspect = (text: string) => {
    pending += text;
    if (pending.length > 65_536) throw new Error('SSE frame exceeded limit.');
    let split: RegExpExecArray | null;
    while ((split = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, split.index);
      pending = pending.slice(split.index + split[0].length);
      if (
        frame
          .split(/\r?\n/)
          .some(
            (line) =>
              line.startsWith('event:') &&
              /^(?:error|failed|incomplete)$/.test(line.slice(6).trim()),
          )
      )
        valid = false;
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      if (done) {
        valid = false;
        continue;
      }
      if (data === '[DONE]') {
        done = true;
        valid &&= stopped;
        continue;
      }
      const value = JSON.parse(data);
      if (
        value.error ||
        !Array.isArray(value.choices) ||
        value.choices.length > 1
      ) {
        valid = false;
        continue;
      }
      for (const choice of value.choices) {
        if (choice.index != null && choice.index !== 0) valid = false;
        if (
          !choice.delta ||
          typeof choice.delta !== 'object' ||
          choice.delta.tool_calls ||
          choice.delta.function_call
        )
          valid = false;
        if (choice.delta?.content != null) {
          if (typeof choice.delta.content !== 'string' || stopped)
            valid = false;
          else hasText ||= choice.delta.content.trim().length > 0;
        }
        if (choice.finish_reason != null) {
          valid &&= choice.finish_reason === 'stop' && !stopped;
          stopped = true;
        }
      }
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        const result = await awaitTurnSignal(reader.read(), signal);
        if (!result.done) {
          inspect(decoder.decode(result.value, { stream: true }));
          controller.enqueue(result.value);
          return;
        }
        inspect(decoder.decode());
        const complete =
          valid &&
          hasText &&
          stopped &&
          done &&
          !pending.trim() &&
          !signal.aborted;
        closed = true;
        finish(complete);
        if (!complete)
          controller.enqueue(
            new TextEncoder().encode(
              'event: incomplete\ndata: {"incomplete":true}\n\n',
            ),
          );
        controller.close();
      } catch {
        closed = true;
        finish(false);
        void reader.cancel().catch(() => {});
        controller.enqueue(
          new TextEncoder().encode(
            'event: incomplete\ndata: {"incomplete":true}\n\n',
          ),
        );
        controller.close();
      }
    },
    cancel() {
      if (closed) return;
      closed = true;
      finish(false);
      void reader.cancel().catch(() => {});
    },
  });
}
