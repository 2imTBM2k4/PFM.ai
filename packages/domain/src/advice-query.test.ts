import { describe, expect, it } from 'vitest';

import {
  extractMentionedCategory,
  findPreviousFactQuery,
  parseAdviceQuery,
  resolveAdviceRange,
  type AdviceHistoryTurn,
} from './advice-query';

// 2026-11-04 is a Wednesday; the week starts on Monday 2026-11-02.
const TODAY = '2026-11-04';

const vi = (text: string): AdviceHistoryTurn => ({ role: 'user', text });
const ai = (text: string): AdviceHistoryTurn => ({ role: 'assistant', text });

describe('parseAdviceQuery - reported question and supported periods', () => {
  it('treats "những ngày qua" as the last 7 days including today', () => {
    expect(
      parseAdviceQuery(
        'Cho tôi biết những ngày qua tôi tiêu gì nhiều',
        [],
        TODAY,
      ),
    ).toEqual({
      kind: 'expense_by_category',
      range: { kind: 'last_7_days', from: '2026-10-29', to: '2026-11-04' },
      category: null,
      needsClarification: false,
    });
  });

  it.each([
    [
      'Tôi tiêu gì nhiều trong 7 ngày gần đây',
      'last_7_days',
      '2026-10-29',
      '2026-11-04',
    ],
    ['Hôm nay tôi chi gì nhiều', 'today', '2026-11-04', '2026-11-04'],
    ['Hôm qua tôi chi gì nhiều', 'yesterday', '2026-11-03', '2026-11-03'],
    ['Tuần này tôi tiêu gì nhiều', 'this_week', '2026-11-02', '2026-11-04'],
    ['Tuần trước tôi tiêu gì nhiều', 'last_week', '2026-10-26', '2026-11-01'],
    ['Tháng này tôi tiêu gì nhiều', 'this_month', '2026-11-01', '2026-11-04'],
    ['Tháng trước tôi tiêu gì nhiều', 'last_month', '2026-10-01', '2026-10-31'],
    [
      '30 ngày gần đây tôi tiêu gì nhiều',
      'last_30_days',
      '2026-10-06',
      '2026-11-04',
    ],
  ] as const)('%s → %s', (question, kind, from, to) => {
    expect(parseAdviceQuery(question, [], TODAY).range).toEqual({
      kind,
      from,
      to,
    });
  });

  it('uses the equivalent English periods', () => {
    expect(
      parseAdviceQuery(
        'What did I spend the most on in the last 7 days?',
        [],
        TODAY,
      ),
    ).toMatchObject({
      kind: 'expense_by_category',
      range: { from: '2026-10-29', to: '2026-11-04' },
    });
    expect(
      parseAdviceQuery('How much did I spend this month?', [], TODAY),
    ).toMatchObject({
      kind: 'cash_flow',
      range: { from: '2026-11-01', to: '2026-11-04' },
    });
    expect(
      parseAdviceQuery('What did I spend the most on last month?', [], TODAY),
    ).toMatchObject({ range: { from: '2026-10-01', to: '2026-10-31' } });
    expect(
      parseAdviceQuery('How much income did I receive this week?', [], TODAY),
    ).toMatchObject({ kind: 'cash_flow', range: { from: '2026-11-02' } });
  });
});

describe('parseAdviceQuery - numeric vs advice vs transaction precedence', () => {
  it('answers cash-flow totals without a category question', () => {
    expect(
      parseAdviceQuery('Tháng này tôi chi bao nhiêu?', [], TODAY).kind,
    ).toBe('cash_flow');
    expect(
      parseAdviceQuery('Tổng thu và tổng chi tháng này thế nào?', [], TODAY)
        .kind,
    ).toBe('cash_flow');
  });

  it('keeps income-source and personal-status questions out of local totals', () => {
    for (const question of [
      'Thu nhập của tôi đến từ đâu',
      'Tình hình nợ và tiết kiệm của tôi thế nào',
      'Mục tiêu của tôi thế nào',
    ]) {
      expect(parseAdviceQuery(question, [], TODAY).kind).toBe('advice');
    }
  });

  it('keeps the monthly savings goal as advice, not a spending total', () => {
    expect(
      parseAdviceQuery(
        'Tôi muốn để dành 3 triệu mỗi tháng, khoản nào có thể giảm?',
        [],
        TODAY,
      ).kind,
    ).toBe('advice');
    expect(
      parseAdviceQuery('Mua xe 40 triệu thì bao lâu đủ?', [], TODAY).kind,
    ).toBe('advice');
    expect(
      parseAdviceQuery(
        'Trả góp 4 triệu trong 18 tháng có phù hợp không?',
        [],
        TODAY,
      ).kind,
    ).toBe('advice');
    expect(
      parseAdviceQuery('Tôi tiết kiệm 3 triệu mỗi tháng', [], TODAY).kind,
    ).toBe('advice');
    expect(
      parseAdviceQuery('Tháng này tôi tiết kiệm được bao nhiêu?', [], TODAY)
        .kind,
    ).toBe('cash_flow');
  });

  it('keeps a scenario follow-up on the advice path even with a period', () => {
    expect(
      parseAdviceQuery(
        'Tôi muốn mua xe 40 triệu, tháng này thì sao?',
        [],
        TODAY,
      ).kind,
    ).toBe('advice');
  });

  it('never routes an explicit record command to a factual answer', () => {
    for (const command of [
      'ghi chi ăn sáng 30k tháng này',
      'ghi thu 12 triệu tháng này',
      'lưu giao dịch tiền nhà 3 triệu 7 ngày qua',
      'thêm giao dịch chi bao nhiêu cũng được',
    ]) {
      expect(parseAdviceQuery(command, [], TODAY).kind).toBe('advice');
    }
  });

  it('carries an explicit category only when the user names one', () => {
    expect(
      parseAdviceQuery(
        'Tôi tiêu gì nhiều cho danh mục Ăn uống tuần này?',
        [],
        TODAY,
      ).category,
    ).toBe('Ăn uống');
    expect(
      parseAdviceQuery('Tháng này tôi chi gì nhiều?', [], TODAY).category,
    ).toBeNull();
    expect(extractMentionedCategory('chi tiêu ăn uống tháng này')).toBeNull();
  });

  it('asks for a period when the user gives none', () => {
    const query = parseAdviceQuery('Tôi tiêu gì nhiều?', [], TODAY);
    expect(query.kind).toBe('expense_by_category');
    expect(query.needsClarification).toBe(true);
  });

  it('keeps an advice question with a period on the advice path', () => {
    expect(
      parseAdviceQuery('Tôi muốn lập ngân sách tháng này', [], TODAY),
    ).toEqual({
      kind: 'advice',
      range: { kind: 'this_month', from: '2026-11-01', to: '2026-11-04' },
      category: null,
      needsClarification: false,
    });
  });

  it('treats an empty question as advice needing context', () => {
    expect(parseAdviceQuery('   ', [], TODAY)).toEqual({
      kind: 'advice',
      range: null,
      category: null,
      needsClarification: true,
    });
  });
});

describe('parseAdviceQuery - follow-up turns', () => {
  const previous: AdviceHistoryTurn[] = [
    vi('Cho tôi biết những ngày qua tôi tiêu gì nhiều'),
    ai('Trong 7 ngày qua, Ăn uống chiếm nhiều nhất.'),
  ];

  it('inherits the previous subject and swaps only the period', () => {
    expect(
      parseAdviceQuery('Còn tháng trước tôi tiêu gì nhiều?', previous, TODAY),
    ).toEqual({
      kind: 'expense_by_category',
      range: { kind: 'last_month', from: '2026-10-01', to: '2026-10-31' },
      category: null,
      needsClarification: false,
    });
  });

  it('inherits the subject from a bare period follow-up', () => {
    expect(
      parseAdviceQuery('Còn tháng trước thì sao?', previous, TODAY),
    ).toEqual({
      kind: 'expense_by_category',
      range: { kind: 'last_month', from: '2026-10-01', to: '2026-10-31' },
      category: null,
      needsClarification: false,
    });
  });

  it('keeps the reported "Thế tháng trước?" follow-up on the numeric path', () => {
    expect(parseAdviceQuery('Thế tháng trước?', previous, TODAY)).toEqual({
      kind: 'expense_by_category',
      range: { kind: 'last_month', from: '2026-10-01', to: '2026-10-31' },
      category: null,
      needsClarification: false,
    });
  });

  it('inherits a cash-flow subject as well', () => {
    const cashFlowHistory: AdviceHistoryTurn[] = [
      vi('Tháng này tôi chi bao nhiêu?'),
      ai('Bạn đã chi 5.000.000 ₫ trong tháng này.'),
    ];
    expect(
      parseAdviceQuery('Thế tuần này?', cashFlowHistory, TODAY),
    ).toMatchObject({
      kind: 'cash_flow',
      range: { kind: 'this_week', from: '2026-11-02', to: '2026-11-04' },
    });
  });

  it('does not inherit from an advice-only history', () => {
    const adviceHistory: AdviceHistoryTurn[] = [
      vi('Mua xe 40 triệu thì bao lâu đủ?'),
      ai('Bạn cần khoảng 7 tháng.'),
    ];
    expect(parseAdviceQuery('Thế tháng trước?', adviceHistory, TODAY)).toEqual({
      kind: 'advice',
      range: {
        kind: 'last_month',
        from: '2026-10-01',
        to: '2026-10-31',
      },
      category: null,
      needsClarification: false,
    });
  });

  it('never reuses the previous numbers, only the subject and period', () => {
    const query = parseAdviceQuery('Thế tháng trước?', previous, TODAY);
    expect(JSON.stringify(query)).not.toContain('7 ngày');
    expect(query.range?.kind).toBe('last_month');
  });

  it('finds the last factual user turn for history building', () => {
    expect(
      findPreviousFactQuery('Thế tháng trước?', previous, TODAY),
    ).toMatchObject({ kind: 'expense_by_category' });
  });

  it('ignores assistant turns and record commands when looking back', () => {
    const mixed: AdviceHistoryTurn[] = [
      vi('Tháng này tôi chi gì nhiều?'),
      ai('Ăn uống nhiều nhất.'),
      vi('ghi chi ăn sáng 30k'),
    ];
    expect(
      findPreviousFactQuery('Thế tháng trước?', mixed, TODAY),
    ).toMatchObject({
      kind: 'expense_by_category',
    });
  });
});

describe('resolveAdviceRange - boundaries', () => {
  it('crosses month and year boundaries without future dates', () => {
    expect(resolveAdviceRange('last_7_days', '2026-01-03')).toEqual({
      kind: 'last_7_days',
      from: '2025-12-28',
      to: '2026-01-03',
    });
    expect(resolveAdviceRange('this_month', '2026-01-01')).toEqual({
      kind: 'this_month',
      from: '2026-01-01',
      to: '2026-01-01',
    });
    expect(resolveAdviceRange('last_month', '2026-03-31')).toEqual({
      kind: 'last_month',
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(resolveAdviceRange('last_month', '2024-03-15')).toEqual({
      kind: 'last_month',
      from: '2024-02-01',
      to: '2024-02-29',
    });
  });

  it('ends every supported period at or before today', () => {
    for (const kind of [
      'last_7_days',
      'today',
      'yesterday',
      'this_week',
      'last_week',
      'this_month',
      'last_month',
      'last_30_days',
    ] as const) {
      const range = resolveAdviceRange(kind, TODAY);
      expect(range.to <= TODAY).toBe(true);
      expect(range.from <= range.to).toBe(true);
    }
  });

  it('accepts an injected clock in Asia/Ho_Chi_Minh', () => {
    expect(
      parseAdviceQuery('Hôm nay tôi chi gì nhiều', [], {
        now: () => new Date('2026-11-04T16:30:00Z'),
        timeZone: 'Asia/Ho_Chi_Minh',
      }).range,
    ).toEqual({ kind: 'today', from: '2026-11-04', to: '2026-11-04' });
  });
});
