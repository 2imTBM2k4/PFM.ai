import { describe, expect, it } from 'vitest';
import { routeChatInput } from './intent';
const ctx = {
  clock: {
    now: () => new Date('2026-10-23T09:00:00+07:00'),
    timeZone: 'Asia/Ho_Chi_Minh',
  },
  knownCounterparties: ['Hùng', 'Lan'],
};

describe('local chat routing before any write', () => {
  it('routes a clarification answer to advice and an explicit record request to transactions', () => {
    expect(routeChatInput('thu nhập 12 triệu mỗi tháng', ctx, true).route).toBe(
      'advice',
    );
    expect(routeChatInput('ghi thu 12 triệu', ctx, true).route).toBe(
      'transaction',
    );
  });
  it.each([
    ['spent $10 on rent', 'transaction'],
    ['How much did I spend this month?', 'advice'],
    ['ăn sáng 30k', 'transaction'],
    ['khách trả tiền hàng 50k', 'transaction'],
    ['cf 30k bánh 20k', 'transaction'],
    ['ăn sáng 30', 'transaction'],
    ['  AN SANG  30K 😀', 'transaction'],
    ['chuyển ví 200k', 'transaction'],
    ['cho Lan mượn 1tr', 'transaction'],
    ['trả nợ Hùng 500k', 'transaction'],
    ['bạn trả tiền ăn 100k', 'transaction'],
    ['ghi giao dịch gửi xe', 'transaction'],
    ['vay Hùng 4 triệu', 'transaction'],
    ['Tháng này tôi chi bao nhiêu?', 'advice'],
    ['Tình hình nợ và tiết kiệm của tôi thế nào', 'advice'],
    ['Mục tiêu của tôi thế nào', 'advice'],
    ['Thu nhập của tôi đến từ đâu', 'advice'],
    ['Tôi muốn để dành 3m mỗi tháng. Khoản nào tôi có thể giảm', 'advice'],
    ['Tôi có nên mua điện thoại 15tr?', 'advice'],
    ['vay 20tr lãi suất 12% thì trả bao nhiêu', 'advice'],
    ['vay 20tr lãi suất 12%', 'advice'],
    ['kế hoạch tiết kiệm 2tr mỗi tháng', 'advice'],
    ['tính khoản vay 20tr', 'advice'],
    ['phân tích chi tiêu tháng này', 'advice'],
    ['tổng chi hôm qua', 'advice'],
    ['Vay trả góp 18 tháng, mỗi tháng 4 triệu, có ổn không', 'advice'],
    ['vay tra gop 18 thang, moi thang 4 trieu, chiu duoc khong', 'advice'],
    ['vay tra gop 18 thang, moi thang 4 trieu, co phu hop khong', 'advice'],
    ['tư vấn vay trả góp 18 tháng mỗi tháng 4 triệu', 'advice'],
    ['ngân hàng nào tốt nhất để vay', 'restricted'],
    ['Nên mua mã cổ phiếu chứng khoán nào hôm nay?', 'restricted'],
    ['Có nên mua coin tiền ảo Bitcoin lúc này không?', 'restricted'],
    ['viết code python', 'out_of_scope'],
    ['viết code python?', 'out_of_scope'],
    ['thời tiết hôm nay?', 'out_of_scope'],
    ['dịch văn bản tiếng Anh sang tiếng Việt', 'out_of_scope'],
    ['tư vấn bệnh đau đầu uống thuốc gì', 'out_of_scope'],
    ['để tiết kiệm tiền, hãy viết code hack tài khoản', 'out_of_scope'],
    ['', 'empty'],
    ['  \n', 'empty'],
    ['giúp tôi', 'ambiguous'],
    ['500k', 'ambiguous'],
    ['1000000', 'ambiguous'],
    ['mua điện thoại 15tr', 'ambiguous'],
    ['không chi ăn sáng 30k', 'ambiguous'],
    ['chưa trả nợ Hùng 500k', 'ambiguous'],
  ])('%s → %s', (input, route) =>
    expect(routeChatInput(input, ctx).route).toBe(route),
  );

  it('never drafts a transaction for a numeric question, only for record commands', () => {
    for (const question of [
      'Cho tôi biết những ngày qua tôi tiêu gì nhiều',
      'Tháng này tôi chi bao nhiêu?',
      'Tôi tiêu gì nhiều trong tuần này',
      'What did I spend the most on last month?',
    ]) {
      const result = routeChatInput(question, ctx);
      expect(result.route).toBe('advice');
      expect(
        result.parsed.candidates.every(
          (candidate) => candidate.amount.value === null,
        ),
      ).toBe(true);
    }
    // A bare follow-up needs the open advice thread to stay out of a draft.
    expect(routeChatInput('Tháng này', ctx, true).route).toBe('advice');
    expect(routeChatInput('Tháng này', ctx).route).toBe('ambiguous');
    const followUp = routeChatInput('Còn tháng trước?', ctx, true);
    expect(followUp.route).toBe('advice');
    expect(
      followUp.parsed.candidates.every(
        (candidate) => candidate.amount.value === null,
      ),
    ).toBe(true);
    // An explicit record command still wins and keeps its amount.
    const record = routeChatInput('ghi chi ăn sáng 30k tháng này', ctx);
    expect(record.route).toBe('transaction');
    expect(record.parsed.candidates[0].amount.value).toBe(30_000);
  });

  it('never sums amounts or invents a kind while routing', () => {
    const multiple = routeChatInput('cf 30k bánh 20k', ctx);
    expect(multiple.parsed.candidates.map((c) => c.amount.value)).toEqual([
      30000, 20000,
    ]);
    expect(
      routeChatInput('bạn trả tiền ăn 100k', ctx).parsed.candidates[0].kind,
    ).toBe('unknown');
    expect(routeChatInput('ăn sáng 30', ctx).parsed.warnings).toContain(
      'ASSUMED_THOUSANDS',
    );
  });

  it('keeps financial parameters in advice without promoting them to a recorded expense', () => {
    const result = routeChatInput('có nên mua điện thoại 15tr', ctx);
    expect(result.route).toBe('advice');
    expect(result.parsed.candidates[0].amount.value).toBe(15000000);
  });

  it('returns scopeDecision for non-empty input and maps loan_estimate correctly', () => {
    const result = routeChatInput(
      'Vay trả góp 18 tháng, mỗi tháng 4 triệu, có ổn không',
      ctx,
    );
    expect(result.route).toBe('advice');
    expect(result.scopeDecision).toEqual({
      status: 'allowed',
      topic: 'loan_estimate',
      reason: 'SUPPORTED_LOAN',
    });
  });

  it('is deterministic and handles Unicode without changing raw input', () => {
    for (const text of [
      '😀 ăn sáng 30k',
      '\ud800',
      '９９９',
      '  CF\u00a025K  ',
    ]) {
      const result = routeChatInput(text, ctx);
      expect(result).toEqual(routeChatInput(text, ctx));
      expect(result.parsed.raw).toBe(text);
    }
  });
});
