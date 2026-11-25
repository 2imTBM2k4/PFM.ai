import { classifyAdviceScope, isUnsafeAdviceAnswer } from '@pfm/domain';
import { awaitTurnSignal } from './agent-turn-stream';
import { scanPii } from './pii-scanner';

const INTERNAL_FIELD_PATTERN =
  /\b(?:monthlyAvailable|requiredMonthlySaving|remainingAfterSaving|goalAmount|savingsForGoal|limit_amount|spent_amount|remaining_amount|overspent_amount|monthly_income_avg|monthly_expense_avg|liquid_balance|months_with_data|monthlyIncomeAvg|monthlyExpenseAvg|liquidBalance|monthsWithData|stateRevision|calculationVersion|dataQuality)\b/i;

function isSafeCoachSegment(text: string): boolean {
  if (isUnsafeAdviceAnswer(text)) return false;
  const scope = classifyAdviceScope(text);
  if (scope.status === 'restricted' || scope.status === 'out_of_scope')
    return false;
  if (scanPii(text).hasPii) return false;
  if (INTERNAL_FIELD_PATTERN.test(text)) return false;
  return true;
}

/** Stream safety-checked coaching segments using the same delta/done/error SSE wire contract. */
export function verifyCoachSse(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  finish: (complete: boolean) => void,
  options: { maxTotalChars?: number } = {},
) {
  const reader = source.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let frameBuffer = '';
  let pending = '';
  let emitted = '';
  let stopped = false;
  let done = false;
  let closed = false;
  let seq = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const emit = (event: string, payload: unknown) =>
        controller.enqueue(
          encoder.encode(
            `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
          ),
        );
      const finishError = (code: string) => {
        if (closed) return;
        closed = true;
        finish(false);
        void reader.cancel().catch(() => {});
        emit('error', {
          code,
          incomplete: true,
          ...(code === 'VERIFICATION_FAILED' ? { verification: 'failed' } : {}),
        });
        controller.close();
      };
      const emitSegment = (value: string) => {
        if (!isSafeCoachSegment(value) || !isSafeCoachSegment(emitted + value)) {
          finishError('VERIFICATION_FAILED');
          return false;
        }
        emitted += value;
        emit('delta', {
          seq: ++seq,
          text: value,
          verification: 'segment_passed',
        });
        return true;
      };
      const drain = () => {
        while (!closed) {
          const match = /\n\n|[.!?](?=\s)/g;
          let found: RegExpExecArray | null;
          let end = -1;
          while ((found = match.exec(pending))) {
            const i = found.index;
            if (
              found[0] === '.' &&
              /\d/.test(pending[i - 1] ?? '') &&
              /^\s*\d{1,2}$/.test(
                pending.slice(pending.lastIndexOf('\n', i - 1) + 1, i),
              )
            )
              continue;
            end = i + found[0].length;
            break;
          }
          if (end < 0) return;
          const part = pending.slice(0, end);
          pending = pending.slice(end);
          if (!emitSegment(part)) return;
        }
      };
      const inspect = (chunk: string) => {
        frameBuffer += chunk;
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(frameBuffer))) {
          if (boundary.index > 65536) throw new Error('FRAME');
          const frame = frameBuffer.slice(0, boundary.index);
          frameBuffer = frameBuffer.slice(boundary.index + boundary[0].length);
          const lines = frame.split(/\r?\n/);
          if (
            lines.some((line) =>
              /^event:\s*(?:error|failed|incomplete)\s*$/i.test(line),
            )
          )
            throw new Error('UPSTREAM');
          const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (done && frame.trim()) throw new Error('AFTER_DONE');
          if (!data) continue;
          if (data === '[DONE]') {
            if (!stopped) throw new Error('DONE');
            done = true;
            continue;
          }
          const payload = JSON.parse(data);
          if (
            payload.error != null ||
            !Array.isArray(payload.choices) ||
            payload.choices.length > 1
          )
            throw new Error('PAYLOAD');
          for (const choice of payload.choices) {
            if (
              !choice ||
              (choice.index != null && choice.index !== 0) ||
              !choice.delta ||
              typeof choice.delta !== 'object' ||
              choice.delta.tool_calls !== undefined ||
              choice.delta.function_call !== undefined
            )
              throw new Error('CHOICE');
            if (choice.delta.content != null) {
              if (typeof choice.delta.content !== 'string' || stopped)
                throw new Error('CONTENT');
              pending += choice.delta.content;
              if (
                emitted.length + pending.length >
                (options.maxTotalChars ?? 16384)
              )
                throw new Error('TRUNCATED');
              drain();
              if (closed) return;
            }
            if (choice.finish_reason != null) {
              if (choice.finish_reason === 'length')
                throw new Error('TRUNCATED');
              if (choice.finish_reason !== 'stop' || stopped)
                throw new Error('STOP');
              stopped = true;
            }
          }
        }
        if (frameBuffer.length > 65536) throw new Error('FRAME');
      };
      try {
        while (!closed) {
          const result = await awaitTurnSignal(reader.read(), signal);
          if (!result.done) {
            inspect(decoder.decode(result.value, { stream: true }));
            continue;
          }
          inspect(decoder.decode());
          if (
            !stopped ||
            !done ||
            frameBuffer.trim() ||
            signal.aborted ||
            !(emitted + pending).trim()
          ) {
            finishError(
              signal.aborted ? 'STREAM_TIMEOUT' : 'STREAM_INTERRUPTED',
            );
            return;
          }
          if (pending && !emitSegment(pending)) return;
          if (!isSafeCoachSegment(emitted)) {
            finishError('VERIFICATION_FAILED');
            return;
          }
          closed = true;
          finish(true);
          emit('done', { incomplete: false, verification: 'passed' });
          controller.close();
          return;
        }
      } catch (error) {
        finishError(
          signal.aborted
            ? 'STREAM_TIMEOUT'
            : error instanceof Error && error.message === 'TRUNCATED'
              ? 'STREAM_TRUNCATED'
              : 'STREAM_INTERRUPTED',
        );
      }
    },
    cancel() {
      if (!closed) {
        closed = true;
        finish(false);
        void reader.cancel().catch(() => {});
      }
    },
  });
}
