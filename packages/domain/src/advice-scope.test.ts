import { describe, expect, it } from 'vitest';
import { classifyAdviceScope, classifyFinancialIntent } from './advice-scope';

describe('classifier hardening 2', () => {
  it.each([
    'Cho tôi xem thu nhập, chi tiêu trung bình trong 6 tháng hoàn chỉnh gần nhất, đồng thời kiểm tra ngân sách Ăn uống tháng 11/2026. Trình bày riêng hai phần.',
    'Kiểm tra ngân sách Ăn uống tháng 11/2026 và cho tôi xem 3 khoản chi ăn uống gần nhất từ 01/11/2026 đến 16/11/2026 để biết các khoản nào liên quan.',
  ])(
    'keeps budget checks with read-only supporting data together: %s',
    (input) => {
      expect(classifyAdviceScope(input)).toMatchObject({
        status: 'allowed',
        topic: 'budget_review',
      });
    },
  );
  it('does not merge a budget setup request with an independent spending request', () => {
    expect(
      classifyAdviceScope(
        'Thiết lập ngân sách mới; cho tôi xem chi tiêu trung bình mỗi tháng.',
      ),
    ).toMatchObject({ status: 'ambiguous', reason: 'MULTIPLE_TOPICS' });
  });
  it.each([
    'Cho tôi xem thu nhập và chi tiêu trung bình mỗi tháng trong 6 tháng hoàn chỉnh gần nhất.',
    'Chi tiêu trung bình hàng tháng của tôi là bao nhiêu?',
    'Cho xem thu nhập qua các tháng trong 6 tháng gần đây.',
  ])('allows historical financial snapshots: %s', (input) => {
    expect(classifyAdviceScope(input)).toMatchObject({
      status: 'allowed',
      topic: 'spending_overview',
    });
  });
  it.each([
    'Nhiệt độ trung bình mỗi tháng là bao nhiêu?',
    'Trung bình mỗi tháng có bao nhiêu ngày?',
    'Liệt kê thu nhập qua các tháng rồi viết code python.',
  ])(
    'does not infer a financial snapshot from unrelated averages: %s',
    (input) => {
      expect(classifyAdviceScope(input).status).not.toBe('allowed');
    },
  );
  it.each([
    'Liệt kê 3 giao dịch chi Ăn uống gần nhất từ ngày 01/11/2026 đến hết ngày 16/11/2026.',
    'Cho tôi danh sách giao dịch tháng trước.',
    'Cho tôi xem 3 khoản chi ăn uống gần nhất từ 01/11/2026 đến 16/11/2026.',
  ])('allows transaction lists: %s', (input) => {
    expect(classifyAdviceScope(input)).toMatchObject({
      status: 'allowed',
      topic: 'spending_overview',
    });
  });
  it.each([
    'Liệt kê 3 món ăn gần nhất.',
    'Danh sách ngày nghỉ tháng này.',
    'Gần nhất là khi nào?',
  ])('does not infer transactions from list wording alone: %s', (input) => {
    expect(classifyAdviceScope(input).status).not.toBe('allowed');
  });
  it.each([
    'Thu nhập 15tr, chi 10tr, mục tiêu 24tr trong 6 tháng',
    'Mục tiêu 30 triệu trong 12 tháng, thu nhập 20 triệu, chi phí 8 triệu',
    'Thu nhap 18.000.000 dong, tong chi 9.000.000 dong, muc tieu 36.000.000 dong trong 8 thang',
  ])('allows complete four-part savings declarations: %s', (input) => {
    expect(classifyAdviceScope(input)).toMatchObject({
      status: 'allowed',
      topic: 'savings_plan',
    });
  });
  it.each([
    'Thu nhập 15tr, chi 10tr',
    'Thu nhập 15tr, mục tiêu 24tr',
    'Chi 10tr, trong 6 tháng',
  ])('keeps incomplete two-part declarations ambiguous: %s', (input) => {
    expect(classifyAdviceScope(input)).toMatchObject({ status: 'ambiguous' });
  });
  it('does not hide an independent spending question behind a complete declaration', () => {
    expect(
      classifyAdviceScope(
        'Thu nhập 15tr, chi 10tr, mục tiêu 24tr trong 6 tháng; tổng chi tháng này bao nhiêu?',
      ).topic,
    ).not.toBe('savings_plan');
  });
  it.each([
    'Cho tôi vay tiền mặt nhanh.',
    'Tôi muốn vay nhanh.',
    'Tôi muốn vay online.',
    'Tôi muốn vay app.',
    'Vay không thế chấp.',
    'Vay tín chấp nhanh.',
    'Rút tiền mặt thẻ tín dụng.',
  ])('restricts cash and instant loan requests: %s', (input) => {
    expect(classifyAdviceScope(input)).toEqual({
      status: 'restricted',
      topic: null,
      reason: 'SPECIFIC_PRODUCT_RECOMMENDATION',
    });
  });
  it.each([
    'Vay mua nhà 500 triệu trong 120 tháng thì mỗi tháng trả bao nhiêu?',
    'Vay mua xe 100 triệu lãi suất 10% mỗi năm thì mỗi tháng trả bao nhiêu?',
    'Tính khoản vay mua nhà trả góp 20 năm.',
  ])('keeps ordinary loan calculations allowed: %s', (input) => {
    expect(classifyAdviceScope(input)).toMatchObject({
      status: 'allowed',
      topic: 'loan_estimate',
    });
  });
});

describe('savings scope hardening', () => {
  it.each([
    'dành riêng 1.000.000 đồng mỗi tháng',
    'tiết kiệm 24.000.000 trong 6 tháng',
    'tổng chi 10.000.000, mục tiêu 24.000.000 trong 6 tháng, dành riêng 0',
  ])('supports thousands separators in savings amounts: %s', (input) => {
    expect(classifyAdviceScope(input)).toMatchObject({
      status: 'allowed',
      topic: 'savings_plan',
    });
  });

  it('recognizes the same bounded savings summary with different amounts', () => {
    expect(
      classifyAdviceScope(
        'tổng chi 8.000.000 đồng, mục tiêu 30.000.000 đồng trong 12 tháng, dành riêng 2.000.000 đồng',
      ),
    ).toMatchObject({ status: 'allowed', topic: 'savings_plan' });
  });

  it('does not let a bounded savings summary hide an independent spending request', () => {
    expect(
      classifyAdviceScope(
        'tổng chi 10.000.000, mục tiêu 24.000.000 trong 6 tháng, dành riêng 0; phân tích chi tiêu',
      ),
    ).not.toMatchObject({ topic: 'savings_plan' });
  });

  it.each([
    [
      'A: S3',
      'Thu nhập của tôi 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn đủ 24 triệu trong 6 tháng, tiền dành riêng hiện là 0 đồng. Mỗi tháng cần để dành bao nhiêu và còn bao nhiêu sau đó?',
    ],
    [
      'B: D3',
      'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ, mục tiêu 24 triệu trong 6 tháng và tôi chưa dành riêng đồng nào. Tính mức tiết kiệm cần thiết; đồng thời cho biết riêng số dư khả dụng hiện có trong ứng dụng.',
    ],
    [
      'C: C2',
      'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn tiết kiệm đủ 24 triệu, hiện tiền dành riêng là 0 đồng. Mỗi tháng cần dành bao nhiêu?',
    ],
  ])('%s treats declared expenses as savings inputs', (_, input) => {
    expect(classifyAdviceScope(input)).toEqual({
      status: 'allowed',
      topic: 'savings_plan',
      reason: 'SUPPORTED_SAVINGS',
    });
  });

  it('D: retains ambiguity for independent loan and retirement goals', () => {
    expect(
      classifyAdviceScope(
        'Vừa muốn vay mua nhà trả góp vừa muốn tính kế hoạch tiết kiệm nghỉ hưu sớm',
      ),
    ).toMatchObject({ status: 'ambiguous', reason: 'MULTIPLE_TOPICS' });
  });

  it.each([
    ['E', 'Tổng chi tháng này bao nhiêu?', 'spending_overview'],
    [
      'F',
      'Với tài chính hiện tại tôi muốn mua xe máy khoảng 40 triệu thì cần tiết kiệm bao lâu?',
      'purchase_affordability',
    ],
    ['G', 'Trả khoản vay rồi hỏi nên tiết kiệm thế nào', 'loan_estimate'],
  ])('%s preserves the primary non-savings topic', (_, input, topic) => {
    expect(classifyAdviceScope(input)).toMatchObject({
      status: 'allowed',
      topic,
    });
  });

  it.each([
    'Thu nhập 20tr/tháng, tổng chi 8tr/tháng đã gồm trả nợ. Tôi muốn đủ 30tr trong 6 tháng, tiền dành riêng hiện là 0 đồng. Mỗi tháng cần để dành bao nhiêu?',
    'Mỗi tháng cần để dành bao nhiêu? Tiền dành riêng hiện là 0 đồng. Tôi muốn đủ 24 triệu trong 6 tháng. Tổng chi 10 triệu/tháng đã gồm trả nợ, thu nhập 15 triệu/tháng.',
    'Thu nhập 15 triệu/tháng,\ntổng chi 10 triệu/tháng đã gồm trả nợ.\nTôi muốn đủ 24 triệu trong 6 tháng.\nMỗi tháng cần để dành bao nhiêu?',
    'Thu nhap 15 trieu/thang, tong chi 10 trieu/thang da gom tra no. Toi muon du 24 trieu trong 6 thang, tien danh rieng hien la 0 dong. Moi thang can de danh bao nhieu?',
    'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn tiết kiệm đủ 24 triệu trong 3 tháng, hiện tiền dành riêng là 0 đồng. Mỗi tháng cần dành bao nhiêu?',
    'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn tiết kiệm đủ 24 triệu trong 12 tháng, hiện tiền dành riêng là 0 đồng. Mỗi tháng cần dành bao nhiêu?',
    'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ, mục tiêu 24 triệu trong 6 tháng và tôi chưa dành riêng đồng nào. Tính mức tiết kiệm cần thiết; đồng thời cho biết riêng số dư khả dụng hiện có.',
  ])('recognizes savings requests across wording variants: %s', (input) => {
    expect(classifyAdviceScope(input)).toMatchObject({
      status: 'allowed',
      topic: 'savings_plan',
    });
  });

  it.each([
    'Tổng chi tháng này bao nhiêu? Tính mức tiết kiệm cần thiết.',
    'Tổng chi 10 triệu/tháng có hợp lý không? Mỗi tháng cần để dành bao nhiêu?',
    'Tổng chi 10 triệu/tháng, phân tích chi tiêu giúp tôi. Tính mức tiết kiệm cần thiết.',
    'Tổng chi 10 triệu/tháng, kiểm tra ngân sách. Tính mức tiết kiệm cần thiết.',
  ])('does not hide independent requests behind savings: %s', (input) => {
    expect(classifyAdviceScope(input)).toMatchObject({
      status: 'ambiguous',
      reason: 'MULTIPLE_TOPICS',
    });
  });

  it.each([
    'Cho biết tiền tiết kiệm hiện có trong ứng dụng.',
    'Cho biết tiền tiết kiệm hiện có; giao dịch trong 6 tháng.',
    'Chi tháng này 10 triệu, tiết kiệm được không?',
    // Backlog: recognizing terse fact lists without an explicit request.
    'Thu nhập 15tr, chi 10tr, mục tiêu 24tr',
  ])(
    'does not infer a savings goal from unrelated or incomplete wording: %s',
    (input) => {
      expect(classifyAdviceScope(input)).toMatchObject({
        status: 'ambiguous',
        reason: 'INSUFFICIENT_FINANCIAL_CONTEXT',
      });
    },
  );

  it.each([
    [
      'Tổng chi 10 triệu/tháng. Tính mức tiết kiệm cần thiết; ngân hàng nào tốt?',
      'restricted',
    ],
    [
      'Tổng chi 10 triệu/tháng. Tính mức tiết kiệm cần thiết; viết code python.',
      'out_of_scope',
    ],
    [
      'Tổng chi 10 triệu/tháng. Tính mức tiết kiệm cần thiết; cam kết lợi nhuận.',
      'restricted',
    ],
  ])('keeps higher priority policy checks: %s', (input, status) => {
    expect(classifyAdviceScope(input).status).toBe(status);
  });
});

it.each(['2 xị', '2xyz', '2 l', '2 lít'])(
  'does not infer a transaction from an amount alone: %s',
  (input) => {
    expect(classifyFinancialIntent(input).intent).toBe('unknown');
  },
);

it.each(['ghi chi 2 xị', 'ghi chi 2xyz', 'ghi chi 2 l'])(
  'does not infer a valid amount from a record command with a blocked suffix: %s',
  (input) => {
    expect(classifyFinancialIntent(input).intent).toBe('unknown');
  },
);

it('recognizes explicit recording with the supported monetary slang lít', () => {
  expect(classifyFinancialIntent('ghi chi 2 lít').intent).toBe('entry');
});

it('allows basic investment risk education while keeping insurance and specific products restricted', () => {
  expect(classifyAdviceScope('Đầu tư cơ bản có những rủi ro gì?').status).toBe(
    'allowed',
  );
  expect(
    classifyAdviceScope('Giải thích đầu tư cơ bản và bảo hiểm').status,
  ).toBe('restricted');
  expect(
    classifyAdviceScope('Đầu tư cơ bản nên mua cổ phiếu FPT không?').status,
  ).toBe('restricted');
});

it('keeps commands, narrated amounts and open-draft actions separate', () => {
  expect(classifyFinancialIntent('đừng lưu 30k').intent).toBe('unknown');
  expect(classifyFinancialIntent('làm sao thêm khoản 30k?').intent).not.toBe(
    'entry',
  );
  expect(classifyFinancialIntent('ghi chi ăn sáng 30k').intent).toBe('entry');
  expect(
    classifyFinancialIntent(
      'lương tôi 15 triệu, tiền nhà 3 triệu, nên tiết kiệm bao nhiêu?',
    ).intent,
  ).toBe('advice');
  expect(classifyFinancialIntent('Tạo ngân sách ăn uống 2 triệu').intent).toBe(
    'advice',
  );
  expect(classifyFinancialIntent('à nhầm 35k', { draftOpen: true })).toEqual({
    intent: 'unknown',
    draftAction: 'correct',
  });
  expect(classifyFinancialIntent('thôi để sau', { draftOpen: true })).toEqual({
    intent: 'unknown',
    draftAction: 'cancel',
  });
});

it.each([
  'Quỹ dự phòng là gì?',
  'tiết kiệm và đầu tư khác gì nhau',
  'Đa dạng hóa đầu tư là gì?',
  'Có khoản nào sắp đến hạn không?',
  'Giao dịch nào chưa phân loại?',
])('permits general education and read-only queries: %s', (question) => {
  expect(classifyAdviceScope(question).status).toBe('allowed');
});
it('rejects guarantees without rejecting basic investment education', () => {
  expect(classifyAdviceScope('Cam kết đầu tư này lãi chắc chắn').status).toBe(
    'restricted',
  );
});

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

  it.each([
    'Hôm nay 16/11 tôi có số dư là 2m624 với 2m là tiền hàng tháng nhận vào ngày 15. Trong tuần có 2-4-6 tôi sẽ lên công ty từ 8h sáng tới 6h tối, còn các ngày khác trong tuần tôi không lên cty. Giờ tôi muốn những ngày lên cty thì tôi sẽ chạy shopeefood ít lại còn những ngày nghĩ thì chạy nhiều hơn chút để bù thì tôi nên kiếm bao nhiêu 1 ngày là vừa.',
    'Với số dư hiện tại và trung bình thu nhập thì tới tết âm lịch tôi có thể dư 10m không',
    'Với thu nhập và chi tiêu hiện tại thì tới cuối năm tôi có để dành được 20 triệu không?',
    'Mỗi ngày tôi nên chi tiêu bao nhiêu là hợp lý?',
    'Cách phân bổ thu nhập 12 triệu mỗi tháng sao cho ổn?',
    'Help me set a daily earning target for my work schedule.',
  ])('allows open-ended personal income and cash-flow planning: %s', (input) => {
    expect(classifyAdviceScope(input).status).toBe('allowed');
  });
});
