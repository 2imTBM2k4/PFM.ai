import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { upstreamAiService } from '../services/upstream-ai';

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function openAiChunk(content: string | null, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  })}\n\n`;
}

describe('POST /v1/advice/coach', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('streams safety-verified coaching advice for a daily earning schedule question', async () => {
    const spy = vi.spyOn(upstreamAiService, 'callToolStep').mockResolvedValue(
      new Response(
        sseStream([
          openAiChunk(null),
          openAiChunk('Với số dư 2.624.000 ₫ và 2.000.000 ₫ định kỳ ngày 15, '),
          openAiChunk('bạn có 3 ngày lên công ty và 4 ngày nghỉ. '),
          openAiChunk('Ước tính tham khảo: nếu chi 4.000.000 ₫/tháng, bạn cần thêm 2.000.000 ₫/tháng. '),
          openAiChunk('Mỗi tháng bạn chi tiêu khoảng bao nhiêu?', null),
          openAiChunk(null, 'stop'),
          'data: [DONE]\n\n',
        ]),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const app = buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/advice/coach',
        headers: { 'x-device-id': 'coach-test-1' },
        payload: {
          question:
            'Hôm nay 16/11 tôi có số dư là 2m624 với 2m là tiền hàng tháng nhận vào ngày 15. Trong tuần có 2-4-6 tôi sẽ lên công ty từ 8h sáng tới 6h tối, còn các ngày khác trong tuần tôi không lên cty. Giờ tôi muốn những ngày lên cty thì tôi sẽ chạy shopeefood ít lại còn những ngày nghĩ thì chạy nhiều hơn chút để bù thì tôi nên kiếm bao nhiêu 1 ngày là vừa.',
          language: 'vi',
          currency: 'VND',
          snapshot: {
            monthlyIncomeAvg: 2_000_000,
            monthlyExpenseAvg: 4_000_000,
            liquidBalance: 2_624_000,
            monthsWithData: 2,
            currency: 'VND',
          },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.body).toContain('event: delta');
      expect(res.body).toContain('2.624.000 ₫');
      expect(res.body).toContain('event: done');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('accepts a multi-turn follow-up when prior user message is an allowed coaching topic', async () => {
    vi.spyOn(upstreamAiService, 'callToolStep').mockResolvedValue(
      new Response(
        sseStream([
          openAiChunk('Ước tính tham khảo: ngày lên công ty 50.000 ₫, ngày nghỉ 120.000 ₫.'),
          openAiChunk(null, 'stop'),
          'data: [DONE]\n\n',
        ]),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const app = buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/advice/coach',
        headers: { 'x-device-id': 'coach-test-2' },
        payload: {
          question: 'Mỗi tháng tôi chi khoảng 4 triệu, ngày lên công ty chạy 50k thôi.',
          language: 'vi',
          currency: 'VND',
          history: [
            {
              role: 'user',
              content: 'Tôi nên kiếm bao nhiêu 1 ngày là vừa?',
            },
            {
              role: 'assistant',
              content: 'Mỗi tháng bạn chi tiêu khoảng bao nhiêu?',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('50.000 ₫');
      expect(res.body).toContain('event: done');
    } finally {
      await app.close();
    }
  });

  it('blocks PII, restricted, out_of_scope, and standalone ambiguous inputs before calling upstream', async () => {
    const spy = vi.spyOn(upstreamAiService, 'callToolStep');
    const app = buildApp();
    try {
      const cases = [
        ['Số điện thoại tôi là 0912345678, nên kiếm bao nhiêu 1 ngày?', 400, 'PII_DETECTED'],
        ['Nên mua cổ phiếu FPT hay gửi ngân hàng nào tốt?', 422, 'ADVICE_RESTRICTED'],
        ['Viết code python giúp tôi.', 422, 'ADVICE_OUT_OF_SCOPE'],
        ['Có', 422, 'ADVICE_AMBIGUOUS'],
      ] as const;
      for (const [question, status, code] of cases) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/advice/coach',
          headers: { 'x-device-id': 'coach-test-3' },
          payload: { question, language: 'vi', currency: 'VND' },
        });
        expect(res.statusCode).toBe(status);
        expect(res.json()).toMatchObject({ code });
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('halts the stream with VERIFICATION_FAILED if upstream emits restricted or unsafe claims', async () => {
    vi.spyOn(upstreamAiService, 'callToolStep').mockResolvedValue(
      new Response(
        sseStream([
          openAiChunk('Bạn có thể chia mục tiêu theo ngày. '),
          openAiChunk('Tôi đã lưu giao dịch và khuyên bạn nên mua cổ phiếu FPT.'),
          openAiChunk(null, 'stop'),
          'data: [DONE]\n\n',
        ]),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const app = buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/advice/coach',
        headers: { 'x-device-id': 'coach-test-4' },
        payload: {
          question: 'Tôi nên kiếm bao nhiêu 1 ngày là vừa?',
          language: 'vi',
          currency: 'VND',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Bạn có thể chia mục tiêu theo ngày.');
      expect(res.body).toContain('event: error');
      expect(res.body).toContain('VERIFICATION_FAILED');
      expect(res.body).not.toContain('cổ phiếu FPT');
    } finally {
      await app.close();
    }
  });
});
