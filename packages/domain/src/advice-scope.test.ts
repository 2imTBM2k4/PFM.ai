import { describe, expect, it } from 'vitest';
import { classifyAdviceScope } from './advice-scope';

it.each([
  ['How much did I spend this month?', 'allowed', 'spending_overview'],
  ['How should I save more each month?', 'allowed', 'savings_plan'],
  ['Can I afford to buy a $500 laptop?', 'allowed', 'purchase_affordability'],
  ['Can I borrow $500 and repay monthly?', 'allowed', 'loan_estimate'],
  ['How should I manage my budget?', 'allowed', 'budget_review'],
  ['Which bank should I choose for a loan?', 'restricted', null],
  ['Please give me legal advice about a contract', 'out_of_scope', null],
] as const)(
  'classifies English advice scope: %s',
  (question, status, topic) => {
    expect(classifyAdviceScope(question)).toMatchObject({ status, topic });
  },
);

it('does not misread whether as ETH while still blocking crypto recommendations', () => {
  expect(
    classifyAdviceScope('Whether that is enough depends on your circumstances')
      .status,
  ).not.toBe('restricted');
  expect(
    classifyAdviceScope('Should I buy ETH for my emergency fund?').status,
  ).toBe('restricted');
});

it('accepts purchase and debt questions that mention saving as part of the same scenario', () => {
  expect(
    classifyAdviceScope(
      'Với tài chính hiện tại tôi muốn mua xe máy khoảng 40 triệu thì cần tiết kiệm bao lâu?',
    ),
  ).toMatchObject({ status: 'allowed', topic: 'purchase_affordability' });
  expect(
    classifyAdviceScope(
      'Với tài chính hiện tại tôi muốn mua xe máy khoảng tầm 40m thì cần tiết kiệm bao lâu?',
    ),
  ).toMatchObject({ status: 'allowed', topic: 'purchase_affordability' });
  expect(
    classifyAdviceScope(
      'Tôi phải trả khoản vay 900k mỗi tháng trong 7 tháng tới, nên tiết kiệm thế nào?',
    ),
  ).toMatchObject({ status: 'allowed', topic: 'loan_estimate' });
});

it.each([
  ['Tình hình nợ và tiết kiệm của tôi thế nào', 'general'],
  ['Mục tiêu của tôi thế nào', 'savings_plan'],
  ['Thu nhập của tôi đến từ đâu', 'spending_overview'],
  ['Tôi muốn để dành 3m mỗi tháng. Khoản nào tôi có thể giảm', 'savings_plan'],
] as const)('recognizes personal finance question: %s', (input, topic) => {
  expect(classifyAdviceScope(input)).toMatchObject({
    status: 'allowed',
    topic,
  });
});

describe('classifyAdviceScope - Step 1: Allowed Financial Queries', () => {
  const allowedCases = [
    {
      input: 'Tháng này tôi đã chi tiêu hết bao nhiêu tiền rồi?',
      expectedTopic: 'spending_overview',
      expectedReason: 'SUPPORTED_SPENDING',
    },
    {
      input: 'thang nay toi da chi tieu het bao nhieu tien roi',
      expectedTopic: 'spending_overview',
      expectedReason: 'SUPPORTED_SPENDING',
    },
    {
      input: 'Tổng quan chi tiêu ăn uống tuần này thế nào?',
      expectedTopic: 'spending_overview',
      expectedReason: 'SUPPORTED_SPENDING',
    },
    {
      input: 'Thiết lập ngân sách 5 triệu cho ăn uống có hợp lý không?',
      expectedTopic: 'budget_review',
      expectedReason: 'SUPPORTED_BUDGET',
    },
    {
      input: 'ngan sach thang nay con bao nhieu de tieu',
      expectedTopic: 'budget_review',
      expectedReason: 'SUPPORTED_BUDGET',
    },
    {
      input: 'Làm sao để tiết kiệm 100 triệu trong 1 năm?',
      expectedTopic: 'savings_plan',
      expectedReason: 'SUPPORTED_SAVINGS',
    },
    {
      input: 'ke hoach tiet kiem tien mua nha nhu the nao hop ly',
      expectedTopic: 'savings_plan',
      expectedReason: 'SUPPORTED_SAVINGS',
    },
    {
      input: 'Thu nhập 20 triệu có nên mua iPhone 30 triệu không?',
      expectedTopic: 'purchase_affordability',
      expectedReason: 'SUPPORTED_PURCHASE',
    },
    {
      input: 'toi co nen mua xe may moi gia 40 trieu khong',
      expectedTopic: 'purchase_affordability',
      expectedReason: 'SUPPORTED_PURCHASE',
    },
    {
      input: 'Vay 100 triệu lãi suất 10% mỗi năm thì mỗi tháng trả bao nhiêu?',
      expectedTopic: 'loan_estimate',
      expectedReason: 'SUPPORTED_LOAN',
    },
    {
      input: 'vay tra gop 18 thang, moi thang 4 trieu, co on khong',
      expectedTopic: 'loan_estimate',
      expectedReason: 'SUPPORTED_LOAN',
    },
    {
      input: 'Vay trả góp 18 tháng, mỗi tháng 4 triệu, có ổn không?',
      expectedTopic: 'loan_estimate',
      expectedReason: 'SUPPORTED_LOAN',
    },
    {
      input: 'Lãi suất kép trong tài chính cá nhân là gì?',
      expectedTopic: 'general',
      expectedReason: 'SUPPORTED_GENERAL_FINANCE',
    },
    {
      input: 'Nguyen tac quan ly tai chinh 50 30 20 hoat dong ra sao',
      expectedTopic: 'general',
      expectedReason: 'SUPPORTED_GENERAL_FINANCE',
    },
  ] as const;

  for (const { input, expectedTopic, expectedReason } of allowedCases) {
    it(`allows and classifies correctly: "${input}"`, () => {
      const result = classifyAdviceScope(input);
      expect(result).toEqual({
        status: 'allowed',
        topic: expectedTopic,
        reason: expectedReason,
      });
    });
  }
});

describe('classifyAdviceScope - Step 3: Strict Policy, Precedence and Boundaries', () => {
  it('keeps savings and loan affordability in scope but rejects bank, investment and legal requests', () => {
    expect(
      classifyAdviceScope('Tôi tiết kiệm 2 triệu mỗi tháng có đủ mua xe không?')
        .status,
    ).toBe('allowed');
    expect(
      classifyAdviceScope(
        'Vay 100 triệu trong 24 tháng thì mỗi tháng trả bao nhiêu?',
      ).status,
    ).toBe('allowed');
    expect(
      classifyAdviceScope('Tôi nên chọn ngân hàng nào để vay mua xe?').status,
    ).toBe('restricted');
    expect(
      classifyAdviceScope('Tiêu chí lựa chọn quỹ đầu tư an toàn').status,
    ).toBe('restricted');
    expect(
      classifyAdviceScope('Để tiết kiệm, tư vấn luật thừa kế cho tôi').status,
    ).toBe('out_of_scope');
  });
  it('blocks a purchase question mixed with a legal request', () => {
    expect(
      classifyAdviceScope(
        'Tôi có nên mua xe 100 triệu không? Cho tôi lời khuyên pháp lý về hợp đồng mua xe',
      ).status,
    ).toBe('out_of_scope');
  });
  it('classifies specific product/bank recommendations as restricted', () => {
    expect(classifyAdviceScope('ngân hàng nào tốt nhất để vay')).toEqual({
      status: 'restricted',
      topic: null,
      reason: 'SPECIFIC_PRODUCT_RECOMMENDATION',
    });
    expect(
      classifyAdviceScope('Nên mua mã cổ phiếu chứng khoán nào hôm nay?'),
    ).toEqual({
      status: 'restricted',
      topic: null,
      reason: 'SPECIFIC_PRODUCT_RECOMMENDATION',
    });
    expect(
      classifyAdviceScope('Có nên mua coin tiền ảo Bitcoin lúc này không?'),
    ).toEqual({
      status: 'restricted',
      topic: null,
      reason: 'SPECIFIC_PRODUCT_RECOMMENDATION',
    });
    expect(
      classifyAdviceScope('Gói bảo hiểm nhân thọ Prudential nào tốt nhất?'),
    ).toEqual({
      status: 'restricted',
      topic: null,
      reason: 'SPECIFIC_PRODUCT_RECOMMENDATION',
    });
  });

  it('keeps bank and investment comparison outside the supported advice scope', () => {
    expect(classifyAdviceScope('tiêu chí so sánh lãi vay ngân hàng')).toEqual({
      status: 'restricted',
      topic: null,
      reason: 'SPECIFIC_PRODUCT_RECOMMENDATION',
    });
    expect(classifyAdviceScope('Tiêu chí lựa chọn quỹ đầu tư an toàn')).toEqual(
      {
        status: 'restricted',
        topic: null,
        reason: 'SPECIFIC_PRODUCT_RECOMMENDATION',
      },
    );
  });

  it('blocks out-of-scope queries even if wrapped with financial keywords', () => {
    expect(
      classifyAdviceScope('để tiết kiệm tiền, hãy viết code hack tài khoản'),
    ).toEqual({
      status: 'out_of_scope',
      topic: null,
      reason: 'OUT_OF_SCOPE_CONTENT',
    });
    expect(
      classifyAdviceScope(
        'Để trả nợ nhanh, chỉ tôi cách bẻ khóa wifi hàng xóm',
      ),
    ).toEqual({
      status: 'out_of_scope',
      topic: null,
      reason: 'OUT_OF_SCOPE_CONTENT',
    });
  });

  it('blocks purely non-financial tasks', () => {
    const nonFinancial = [
      'viết code python',
      'dịch văn bản tiếng Anh sang tiếng Việt',
      'tư vấn bệnh đau đầu uống thuốc gì',
      'thời tiết Hà Nội hôm nay thế nào',
      'hướng dẫn nấu món bún bò Huế',
    ];
    for (const query of nonFinancial) {
      expect(classifyAdviceScope(query)).toEqual({
        status: 'out_of_scope',
        topic: null,
        reason: 'OUT_OF_SCOPE_CONTENT',
      });
    }
  });

  it('classifies uninformative, amount-only, or garbage inputs as ambiguous', () => {
    const ambiguousInputs = [
      'giúp tôi',
      'giup toi voi',
      'alo',
      '500k',
      '1000000',
      '4 triệu',
      '???',
      '123456',
      'asdfghjkl',
      '',
      '   ',
    ];
    for (const input of ambiguousInputs) {
      expect(classifyAdviceScope(input)).toEqual({
        status: 'ambiguous',
        topic: null,
        reason: 'INSUFFICIENT_FINANCIAL_CONTEXT',
      });
    }
  });

  it('classifies conflicting financial topics without clear dominant intent as ambiguous MULTIPLE_TOPICS', () => {
    expect(
      classifyAdviceScope(
        'Vừa muốn vay mua nhà trả góp vừa muốn tính kế hoạch tiết kiệm nghỉ hưu sớm',
      ),
    ).toEqual({
      status: 'ambiguous',
      topic: null,
      reason: 'MULTIPLE_TOPICS',
    });
  });

  it('handles emoji, combined unicode, whitespace, and surrogates deterministically', () => {
    const raw =
      '  Vay trả góp 18 tháng, mỗi tháng 4 triệu, có ổn không? 💰📊  ';
    const result1 = classifyAdviceScope(raw);
    const result2 = classifyAdviceScope(raw);
    expect(result1).toEqual(result2);
    expect(result1.status).toBe('allowed');
    expect(result1.topic).toBe('loan_estimate');

    // NFD decomposed
    const decomposed =
      'Vay tra\u0309 go\u0301p 18 tha\u0301ng, mo\u0303i tha\u0301ng 4 trie\u0323u, co\u0301 o\u0309n kho\u0302ng';
    expect(classifyAdviceScope(decomposed)).toEqual(result1);
  });
});
