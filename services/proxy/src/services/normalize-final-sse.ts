import { z } from 'zod';

const ChunkSchema = z
  .object({
    error: z.unknown().optional(),
    choices: z
      .array(
        z
          .object({
            index: z.literal(0).optional(),
            delta: z
              .object({
                content: z.string().nullable().optional(),
                tool_calls: z.unknown().optional(),
                function_call: z.unknown().optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .max(1),
  })
  .passthrough();
const MAX_EVENT_CHARS = 65_536;

/** Preserve final SSE bytes and append DONE only after a verified stop and clean EOF. */
export function normalizeFinalSse(
  source: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let eligible = true;
  let stopped = false;
  let hasText = false;
  let hasDone = false;
  let pending = '';
  let data: string[] = [];
  let eventChars = 0;

  function inspectEvent() {
    if (!data.length) return;
    const payload = data.join('\n').trim();
    data = [];
    if (hasDone) {
      eligible = false;
      return;
    }
    if (payload === '[DONE]') {
      hasDone = true;
      return;
    }
    try {
      const parsed = ChunkSchema.safeParse(JSON.parse(payload));
      if (!parsed.success || parsed.data.error != null) {
        eligible = false;
        return;
      }
      const choice = parsed.data.choices[0];
      if (!choice) return;
      if (
        stopped ||
        choice.delta.tool_calls !== undefined ||
        choice.delta.function_call !== undefined
      ) {
        eligible = false;
        return;
      }
      hasText ||= !!choice.delta.content?.trim();
      if (choice.finish_reason != null) {
        stopped = choice.finish_reason === 'stop';
        if (!stopped) eligible = false;
      }
    } catch {
      eligible = false;
    }
  }
  function line(value: string) {
    if (!value) {
      inspectEvent();
      eventChars = 0;
      return;
    }
    eventChars += value.length + 1;
    if (eventChars > MAX_EVENT_CHARS) {
      eligible = false;
      return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let fieldValue = colon < 0 ? '' : value.slice(colon + 1);
    if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
    if (field === 'data') data.push(fieldValue);
    else if (field === 'event' && /error|failed|incomplete/i.test(fieldValue))
      eligible = false;
  }
  function inspect(value: string, eof = false) {
    if (!eligible) return;
    pending += value;
    let index: number;
    while ((index = pending.search(/[\r\n]/)) >= 0) {
      if (!eof && pending[index] === '\r' && index === pending.length - 1)
        break;
      const width =
        pending[index] === '\r' && pending[index + 1] === '\n' ? 2 : 1;
      line(pending.slice(0, index));
      pending = pending.slice(index + width);
      if (!eligible) {
        pending = '';
        data = [];
        return;
      }
    }
    // An oversized or unfinished event must never cause unbounded buffering or manufactured success.
    if (pending.length + eventChars > MAX_EVENT_CHARS) {
      eligible = false;
      pending = '';
      data = [];
    }
  }

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (!eligible) return;
        try {
          inspect(decoder.decode(chunk, { stream: true }));
        } catch {
          eligible = false;
          pending = '';
          data = [];
        }
      },
      flush(controller) {
        // Stream errors/cancellation never call flush; a supplied abort also forbids synthesis.
        if (!eligible || signal?.aborted) return;
        try {
          inspect(decoder.decode(), true);
        } catch {
          return;
        }
        if (
          eligible &&
          stopped &&
          hasText &&
          !hasDone &&
          !pending &&
          !data.length &&
          eventChars === 0
        )
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      },
    }),
  );
}
