import { describe, expect, it } from 'vitest';
import {
  checkAdviceToolBatch,
  resolveAdviceToolPolicy,
  type AdviceToolPolicy,
} from './advice-tool-policy';

const base = {
  today: '2026-11-16',
  sessionId: 'session',
  scenarioId: 'scenario-save',
  stateRevision: 2,
  categories: [{ id: 'cat-food', name: 'Ăn uống' }],
  budgets: [{ id: 'budget-food', name: 'Ăn uống' }],
};
const resolve = (question: string) =>
  resolveAdviceToolPolicy({ ...base, question });
const snapshotPolicy: AdviceToolPolicy = {
  sessionId: 'session',
  scenarioId: 'scenario-save',
  stateRevision: 2,
  grants: [
    {
      name: 'get_financial_snapshot',
      params: {
        months: 6,
        fields: ['monthly_income_avg', 'monthly_expense_avg'],
      },
    },
  ],
};

describe('advice tool policy', () => {
  it('grants only the requested six-month income and expense averages', () => {
    expect(
      resolveAdviceToolPolicy({
        question:
          'Cho tôi xem thu nhập và chi tiêu trung bình mỗi tháng trong 6 tháng hoàn chỉnh gần nhất.',
        today: '2026-11-16',
        sessionId: 'session',
        scenarioId: null,
        stateRevision: 0,
      }),
    ).toEqual({
      status: 'allowed',
      policy: {
        sessionId: 'session',
        scenarioId: null,
        stateRevision: 0,
        grants: [
          {
            name: 'get_financial_snapshot',
            params: {
              months: 6,
              fields: ['monthly_income_avg', 'monthly_expense_avg'],
            },
          },
        ],
      },
    });
  });

  it.each([
    'Thu nhập của tôi 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn đủ 24 triệu trong 6 tháng, tiền dành riêng hiện là 0 đồng. Mỗi tháng cần để dành bao nhiêu và còn bao nhiêu sau đó?',
    'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn đủ 24 triệu trong 6 tháng; mỗi tháng phải dành bao nhiêu?',
    'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn tiết kiệm đủ 24 triệu, hiện tiền dành riêng là 0 đồng. Mỗi tháng cần dành bao nhiêu?',
  ])(
    'S3/C1/C2 grant savings without inventing missing facts: %s',
    (question) => {
      expect(resolve(question)).toEqual({
        status: 'allowed',
        policy: {
          sessionId: 'session',
          scenarioId: 'scenario-save',
          stateRevision: 2,
          grants: [{ name: 'plan_savings_goal', params: {} }],
        },
      });
    },
  );

  it('S2 resolves only the explicitly named budget and month', () => {
    expect(
      resolve(
        'Ngân sách Ăn uống tháng 11/2026 đã dùng bao nhiêu, còn bao nhiêu và có vượt không?',
      ),
    ).toMatchObject({
      status: 'allowed',
      policy: {
        grants: [
          {
            name: 'calculate_budget_status',
            params: { month: '2026-11', budget_id: 'budget-food' },
          },
        ],
      },
    });
  });

  it('S4 restricts the transaction range, category, kind and count', () => {
    expect(
      resolve(
        'Liệt kê 3 giao dịch chi Ăn uống gần nhất từ ngày 01/11/2026 đến hết ngày 16/11/2026.',
      ),
    ).toMatchObject({
      status: 'allowed',
      policy: {
        grants: [
          {
            name: 'get_transactions',
            params: {
              from: '2026-11-01',
              to: '2026-11-16',
              kind: 'expense',
              category_id: 'cat-food',
              limit: 3,
            },
          },
        ],
      },
    });
  });

  it('D1 grants snapshot and budget as separate permissions', () => {
    expect(
      resolve(
        'Cho tôi xem thu nhập, chi tiêu trung bình trong 6 tháng hoàn chỉnh gần nhất, đồng thời kiểm tra ngân sách Ăn uống tháng 11/2026. Trình bày riêng hai phần.',
      ),
    ).toMatchObject({
      status: 'allowed',
      policy: {
        grants: [
          {
            name: 'get_financial_snapshot',
            params: {
              months: 6,
              fields: ['monthly_income_avg', 'monthly_expense_avg'],
            },
          },
          {
            name: 'calculate_budget_status',
            params: { month: '2026-11', budget_id: 'budget-food' },
          },
        ],
      },
    });
  });

  it('D2 grants budget and matching transactions without broadening either', () => {
    expect(
      resolve(
        'Kiểm tra ngân sách Ăn uống tháng 11/2026 và cho tôi xem 3 khoản chi ăn uống gần nhất từ 01/11/2026 đến 16/11/2026 để biết các khoản nào liên quan.',
      ),
    ).toMatchObject({
      status: 'allowed',
      policy: {
        grants: [
          {
            name: 'calculate_budget_status',
            params: { month: '2026-11', budget_id: 'budget-food' },
          },
          {
            name: 'get_transactions',
            params: {
              from: '2026-11-01',
              to: '2026-11-16',
              kind: 'expense',
              category_id: 'cat-food',
              limit: 3,
            },
          },
        ],
      },
    });
  });

  it('D3 grants savings and only current balance, not historical income or transactions', () => {
    expect(
      resolve(
        'Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ, mục tiêu 24 triệu trong 6 tháng và tôi chưa dành riêng đồng nào. Tính mức tiết kiệm cần thiết; đồng thời cho biết riêng số dư khả dụng hiện có trong ứng dụng.',
      ),
    ).toMatchObject({
      status: 'allowed',
      policy: {
        grants: [
          { name: 'plan_savings_goal', params: {} },
          {
            name: 'get_financial_snapshot',
            params: { months: 1, fields: ['liquid_balance'] },
          },
        ],
      },
    });
  });

  it('S5 inherits savings only for an explicit recalculation in a bound scenario', () => {
    expect(
      resolveAdviceToolPolicy({
        ...base,
        scenarioTopic: 'savings_plan',
        question:
          'Thực ra thu nhập của tôi là 12 triệu/tháng, các khoản khác và mục tiêu giữ nguyên. Tính lại giúp tôi.',
      }),
    ).toMatchObject({
      status: 'allowed',
      policy: { grants: [{ name: 'plan_savings_goal', params: {} }] },
    });
  });

  it.each([
    [
      'snapshotMonths',
      'Cho tôi xem thu nhập và chi tiêu trung bình mỗi tháng.',
    ],
    ['budgetMonth', 'Kiểm tra ngân sách Ăn uống.'],
    ['budget_id', 'Kiểm tra ngân sách Du lịch tháng 11/2026.'],
    [
      'category_id',
      'Liệt kê 3 giao dịch chi Du lịch gần nhất từ ngày 01/11/2026 đến ngày 16/11/2026.',
    ],
    ['observationRange', 'Liệt kê 3 giao dịch chi Ăn uống gần nhất.'],
    [
      'observationRange',
      'Liệt kê 3 giao dịch chi Ăn uống từ ngày 31/11/2026 đến ngày 16/11/2026.',
    ],
    [
      'transactionLimit',
      'Liệt kê 21 giao dịch chi Ăn uống từ ngày 01/11/2026 đến ngày 16/11/2026.',
    ],
  ])('asks for %s instead of granting broad reads: %s', (field, question) => {
    expect(resolve(question)).toEqual({
      status: 'needs_clarification',
      fields: [field],
    });
  });

  it.each([
    ['RESTRICTED', 'Tính kế hoạch tiết kiệm và nên mua cổ phiếu nào?'],
    ['OUT_OF_SCOPE', 'Tính kế hoạch tiết kiệm và hướng dẫn nấu phở.'],
  ])('keeps safety precedence for %s', (reason, question) => {
    expect(resolve(question)).toEqual({ status: 'rejected', reason });
  });

  it.each([
    { today: '2026-02-30' },
    { stateRevision: -1 },
    { sessionId: '' },
    { question: '' },
    { question: 'a'.repeat(501) },
  ])('rejects malformed input %j', (override) => {
    expect(
      resolveAdviceToolPolicy({
        ...base,
        question: 'Tính kế hoạch tiết kiệm giúp tôi.',
        ...override,
      }),
    ).toEqual({ status: 'rejected', reason: 'INVALID_INPUT' });
  });

  it('does not broaden a batch containing an unrequested tool', () => {
    expect(
      checkAdviceToolBatch(snapshotPolicy, base, [
        {
          id: 'ok',
          name: 'get_financial_snapshot',
          params: { months: 6, fields: ['monthly_income_avg'] },
        },
        { id: 'bad', name: 'get_transactions', params: {} },
      ]),
    ).toEqual({
      allowed: false,
      code: 'TOOL_NOT_ALLOWED',
      deniedToolCallIds: ['ok', 'bad'],
    });
  });

  it('permits requested snapshot fields in either order or a smaller subset', () => {
    for (const fields of [
      ['monthly_expense_avg', 'monthly_income_avg'],
      ['monthly_income_avg'],
    ]) {
      expect(
        checkAdviceToolBatch(snapshotPolicy, base, [
          {
            id: 'call',
            name: 'get_financial_snapshot',
            params: { months: 6, fields },
          },
        ]),
      ).toEqual({ allowed: true });
    }
  });

  it.each([
    { months: 12, fields: ['monthly_income_avg'] },
    { months: 6, fields: ['liquid_balance'] },
    { months: 6, fields: [] },
    { months: 6, fields: ['monthly_income_avg', 'monthly_income_avg'] },
    { months: 6, fields: ['monthly_income_avg'], extra: 1 },
    { months: '6', fields: ['monthly_income_avg'] },
    null,
  ])(
    'rejects snapshot parameter expansion or malformed params %j',
    (params) => {
      expect(
        checkAdviceToolBatch(snapshotPolicy, base, [
          { id: 'call', name: 'get_financial_snapshot', params },
        ]),
      ).toMatchObject({ allowed: false, deniedToolCallIds: ['call'] });
    },
  );

  it.each([
    { sessionId: 'other' },
    { scenarioId: 'other' },
    { stateRevision: 3 },
  ])('rejects a different binding %j', (override) => {
    expect(
      checkAdviceToolBatch(snapshotPolicy, { ...base, ...override }, [
        {
          id: 'call',
          name: 'get_financial_snapshot',
          params: { months: 6, fields: ['monthly_income_avg'] },
        },
      ]),
    ).toEqual({
      allowed: false,
      code: 'STATE_ERROR',
      deniedToolCallIds: ['call'],
    });
  });

  it('never drops an unresolved category when punctuation separates it from the range', () => {
    expect(
      resolve(
        'Liệt kê 3 giao dịch chi Du lịch. Từ ngày 01/11/2026 đến ngày 16/11/2026.',
      ),
    ).toEqual({ status: 'needs_clarification', fields: ['category_id'] });
  });

  it('keeps historical income outside a requested expense-average clause', () => {
    const result = resolve(
      'Cho tôi xem chi tiêu trung bình trong 3 tháng. Thu nhập của tôi là 15 triệu.',
    );
    expect(result).toMatchObject({
      status: 'allowed',
      policy: {
        grants: [
          {
            name: 'get_financial_snapshot',
            params: { months: 3, fields: ['monthly_expense_avg'] },
          },
        ],
      },
    });
  });

  it('does not reinterpret a goal horizon as a snapshot observation period', () => {
    expect(
      resolve(
        'Cho tôi xem chi tiêu trung bình. Tôi muốn tiết kiệm đủ 24 triệu trong 6 tháng.',
      ),
    ).not.toMatchObject({ status: 'allowed' });
  });

  it.each([
    { scenarioId: '' },
    { scenarioId: undefined },
    { scenarioId: 'a'.repeat(65) },
  ])('rejects an invalid scenario binding %j', (override) => {
    expect(
      // @ts-expect-error Intentionally exercise an omitted runtime binding.
      resolveAdviceToolPolicy({
        ...base,
        question: 'Tính kế hoạch tiết kiệm giúp tôi.',
        ...override,
      }),
    ).toEqual({ status: 'rejected', reason: 'INVALID_INPUT' });
  });

  it('fails closed on two independently requested transaction kinds', () => {
    expect(
      resolve(
        'Liệt kê 3 giao dịch chi và thu từ ngày 01/11/2026 đến ngày 16/11/2026.',
      ),
    ).not.toMatchObject({ status: 'allowed' });
  });

  it('accepts another horizon without depending on the sample amount', () => {
    expect(
      resolve(
        'Cho tôi xem thu nhập và chi tiêu trung bình trong 3 tháng hoàn chỉnh gần nhất.',
      ),
    ).toMatchObject({
      status: 'allowed',
      policy: {
        grants: [
          {
            name: 'get_financial_snapshot',
            params: {
              months: 3,
              fields: ['monthly_income_avg', 'monthly_expense_avg'],
            },
          },
        ],
      },
    });
  });

  it('rejects duplicate catalog names rather than selecting an arbitrary ID', () => {
    expect(
      resolveAdviceToolPolicy({
        ...base,
        budgets: [
          { id: 'one', name: 'Ăn uống' },
          { id: 'two', name: 'Ăn uống' },
        ],
        question: 'Kiểm tra ngân sách Ăn uống tháng 11/2026.',
      }),
    ).toEqual({ status: 'needs_clarification', fields: ['budget_id'] });
  });

  it('allows only a smaller list within the authorized date/category/kind bounds', () => {
    const result = resolve(
      'Liệt kê 3 giao dịch chi Ăn uống từ ngày 01/11/2026 đến ngày 16/11/2026.',
    );
    expect(result.status).toBe('allowed');
    if (result.status !== 'allowed') return;
    const params = {
      from: '2026-11-01',
      to: '2026-11-16',
      kind: 'expense',
      category_id: 'cat-food',
      limit: 2,
    };
    expect(
      checkAdviceToolBatch(result.policy, base, [
        { id: 'one', name: 'get_transactions', params },
      ]),
    ).toEqual({ allowed: true });
    for (const change of [
      { from: '2026-10-01' },
      { kind: null },
      { category_id: null },
      { limit: 4 },
    ]) {
      expect(
        checkAdviceToolBatch(result.policy, base, [
          {
            id: 'one',
            name: 'get_transactions',
            params: { ...params, ...change },
          },
        ]),
      ).toMatchObject({ allowed: false });
    }
  });

  it('does not broaden a selected budget to all budgets', () => {
    const policy: AdviceToolPolicy = {
      ...snapshotPolicy,
      grants: [
        {
          name: 'calculate_budget_status',
          params: { month: '2026-11', budget_id: 'budget-food' },
        },
      ],
    };
    expect(
      checkAdviceToolBatch(policy, base, [
        {
          id: 'one',
          name: 'calculate_budget_status',
          params: { month: '2026-11' },
        },
      ]),
    ).toMatchObject({ allowed: false });
  });

  it('allows strict empty savings parameters, rejecting model-supplied money', () => {
    const policy: AdviceToolPolicy = {
      ...snapshotPolicy,
      grants: [{ name: 'plan_savings_goal', params: {} }],
    };
    expect(
      checkAdviceToolBatch(policy, base, [
        { id: 'one', name: 'plan_savings_goal', params: {} },
      ]),
    ).toEqual({ allowed: true });
    expect(
      checkAdviceToolBatch(policy, base, [
        { id: 'one', name: 'plan_savings_goal', params: { savingsForGoal: 0 } },
      ]),
    ).toMatchObject({ allowed: false });
  });

  it('retains independent grants for two calls to the same tool', () => {
    const policy: AdviceToolPolicy = {
      ...snapshotPolicy,
      grants: [
        ...snapshotPolicy.grants,
        {
          name: 'get_financial_snapshot',
          params: { months: 1, fields: ['liquid_balance'] },
        },
      ],
    };
    expect(
      checkAdviceToolBatch(policy, base, [
        {
          id: 'one',
          name: 'get_financial_snapshot',
          params: { months: 6, fields: ['monthly_income_avg'] },
        },
        {
          id: 'two',
          name: 'get_financial_snapshot',
          params: { months: 1, fields: ['liquid_balance'] },
        },
      ]),
    ).toEqual({ allowed: true });
  });

  it('does not mutate the question, catalog or binding', () => {
    const input = {
      ...base,
      question: 'Ngân sách Ăn uống tháng 11/2026 đã dùng bao nhiêu?',
    };
    const before = structuredClone(input);
    resolveAdviceToolPolicy(input);
    expect(input).toEqual(before);
  });

  it('lets the caller narrow tool permissions without granting new ones', () => {
    const question =
      'Cho tôi xem thu nhập, chi tiêu trung bình trong 6 tháng hoàn chỉnh gần nhất, đồng thời kiểm tra ngân sách Ăn uống tháng 11/2026.';
    expect(
      resolveAdviceToolPolicy({
        ...base,
        question,
        requestedTools: ['get_financial_snapshot', 'get_transactions'],
      }),
    ).toMatchObject({
      status: 'allowed',
      policy: {
        grants: [
          {
            name: 'get_financial_snapshot',
            params: {
              months: 6,
              fields: ['monthly_income_avg', 'monthly_expense_avg'],
            },
          },
        ],
      },
    });
    expect(
      resolveAdviceToolPolicy({
        ...base,
        question,
        requestedTools: ['get_transactions'],
      }),
    ).toEqual({ status: 'rejected', reason: 'UNSUPPORTED_REQUEST' });
  });

  it('does not use a goal horizon for averages in the same sentence', () => {
    expect(
      resolve(
        'Cho tôi xem chi tiêu trung bình, mục tiêu tiết kiệm 24 triệu trong 6 tháng.',
      ),
    ).not.toMatchObject({ status: 'allowed' });
  });

  it('does not read transactions explicitly negated by the user', () => {
    expect(
      resolve(
        'Đừng liệt kê 3 giao dịch chi Ăn uống từ ngày 01/11/2026 đến ngày 16/11/2026.',
      ),
    ).not.toMatchObject({ status: 'allowed' });
  });

  it('requires a catalog ID rather than granting an empty budget ID', () => {
    expect(
      resolveAdviceToolPolicy({
        ...base,
        budgets: [{ id: '', name: 'Ăn uống' }],
        question: 'Kiểm tra ngân sách Ăn uống tháng 11/2026.',
      }),
    ).not.toMatchObject({ status: 'allowed' });
  });

  it('denies the whole batch when one call changes the authorized month', () => {
    const policy: AdviceToolPolicy = {
      ...snapshotPolicy,
      grants: [
        ...snapshotPolicy.grants,
        {
          name: 'calculate_budget_status',
          params: { month: '2026-11', budget_id: 'budget-food' },
        },
      ],
    };
    expect(
      checkAdviceToolBatch(policy, base, [
        {
          id: 'good',
          name: 'get_financial_snapshot',
          params: { months: 6, fields: ['monthly_income_avg'] },
        },
        {
          id: 'bad',
          name: 'calculate_budget_status',
          params: { month: '2026-10', budget_id: 'budget-food' },
        },
      ]),
    ).toEqual({
      allowed: false,
      code: 'TOOL_NOT_ALLOWED',
      deniedToolCallIds: ['good', 'bad'],
    });
  });

  it('rejects duplicate IDs before accepting otherwise permitted calls', () => {
    expect(
      checkAdviceToolBatch(snapshotPolicy, base, [
        {
          id: 'same',
          name: 'get_financial_snapshot',
          params: { months: 6, fields: ['monthly_income_avg'] },
        },
        {
          id: 'same',
          name: 'get_financial_snapshot',
          params: { months: 6, fields: ['monthly_expense_avg'] },
        },
      ]),
    ).toMatchObject({ allowed: false, code: 'INVALID_PARAMS' });
  });

  it.each([
    'Thực ra 12 triệu. Tính lại giúp tôi.',
    'Vừa muốn vay mua nhà trả góp vừa muốn tính kế hoạch tiết kiệm nghỉ hưu sớm',
    'Thu nhập 15tr, chi 10tr',
  ])('does not infer a scenario or broad permissions for %s', (question) => {
    expect(
      resolveAdviceToolPolicy({ ...base, scenarioId: null, question }),
    ).not.toMatchObject({ status: 'allowed' });
  });

  it.each([
    'Cho tôi xem chi tiêu trung bình trong 3 tháng và thu nhập 15 triệu.',
    'Cho toi xem chi tieu trung binh trong 3 thang va thu nhap 15 trieu.',
  ])(
    'review: excludes self-declared income from average reads: %s',
    (question) => {
      expect(resolve(question)).toMatchObject({
        status: 'allowed',
        policy: {
          grants: [
            {
              name: 'get_financial_snapshot',
              params: { months: 3, fields: ['monthly_expense_avg'] },
            },
          ],
        },
      });
    },
  );

  it.each([
    'Cho tôi xem chi tiêu trung bình trong 3 tháng, còn thu nhập trung bình trong 6 tháng.',
    'Cho toi xem chi tieu trung binh trong 3 thang, con thu nhap trung binh trong 6 thang.',
  ])(
    'review: does not merge distinct requested observation horizons: %s',
    (question) => {
      expect(resolve(question)).toEqual({
        status: 'needs_clarification',
        fields: ['snapshotMonths'],
      });
    },
  );

  it.each([
    'Liệt kê 3 giao dịch từ ngày 01/11/2026 đến ngày 16/11/2026 thuộc danh mục ăn uống.',
    'Liet ke 3 giao dich tu ngay 01/11/2026 den ngay 16/11/2026 thuoc danh muc an uong.',
  ])('review: preserves category filters after the range: %s', (question) => {
    expect(resolve(question)).toMatchObject({
      status: 'allowed',
      policy: {
        grants: [
          { name: 'get_transactions', params: { category_id: 'cat-food' } },
        ],
      },
    });
  });

  it.each([
    'Liệt kê 3 giao dịch từ ngày 01/11/2026 đến ngày 16/11/2026, loại chi.',
    'Liet ke 3 giao dich tu ngay 01/11/2026 den ngay 16/11/2026, loai chi.',
  ])('review: preserves transaction kind after the range: %s', (question) => {
    expect(resolve(question)).toMatchObject({
      status: 'allowed',
      policy: {
        grants: [{ name: 'get_transactions', params: { kind: 'expense' } }],
      },
    });
  });

  it.each([
    'Cho tôi xem chi tiêu trung bình trong 3 tháng và không cần biết số dư khả dụng.',
    'Cho toi xem chi tieu trung binh trong 3 thang va khong can biet so du kha dung.',
  ])(
    'review: does not grant explicitly unwanted balance reads: %s',
    (question) => {
      expect(resolve(question)).not.toMatchObject({ status: 'allowed' });
    },
  );

  it.each([
    ['chỉ chi', 'expense'],
    ['chỉ thu', 'income'],
  ])('review boundary: preserves a trailing %s filter', (suffix, kind) => {
    expect(
      resolve(
        `Liệt kê 3 giao dịch từ ngày 01/11/2026 đến ngày 16/11/2026, ${suffix}.`,
      ),
    ).toMatchObject({
      status: 'allowed',
      policy: { grants: [{ name: 'get_transactions', params: { kind } }] },
    });
  });
});
