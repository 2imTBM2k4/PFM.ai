import { describe, expect, it } from 'vitest';
import {
  verifyAgentAnswer,
  type AgentAnswerEvidence,
} from './verify-agent-answer';

const evidence: AgentAnswerEvidence = {
  tools: [
    {
      name: 'plan_savings_goal',
      params: {},
      data: {
        monthlyAvailable: 5000000,
        requiredMonthlySaving: 4000000,
        remainingAfterSaving: -2000000,
        months: 6,
        goalAmount: 24000000,
        savingsForGoal: 0,
      },
    },
  ],
};
describe('verifyAgentAnswer', () => {
  const regressionEvidence: AgentAnswerEvidence = {
    ...evidence,
    context: {
      savingsMonths: 3,
      paymentMonths: 2,
      income: 15000000,
      expenseTotal: 500000,
    },
  };
  it.each([
    'Có 2 khoản chi.',
    '3 mục tiêu.',
    'Trong 6 months.',
    '6 trong số đó.',
  ])('does not treat the next word as a numeric suffix: %s', (text) => {
    expect(verifyAgentAnswer(text, regressionEvidence)).toMatchObject({
      isValid: true,
    });
  });
  it.each([
    'Mục tiêu 24.000.000 đ trong 6 tháng.',
    'Thu nhập trung bình 15.000.000 đ/tháng trong 3 tháng.',
    'Đã chi 500.000 đ cho 2 giao dịch.',
  ])('does not reuse a monetary label for a count or duration: %s', (text) => {
    expect(verifyAgentAnswer(text, regressionEvidence)).toMatchObject({
      isValid: true,
    });
  });
  it('still rejects a wrong first value before a correct duration', () => {
    expect(
      verifyAgentAnswer(
        'Mục tiêu 5.000.000 đ trong 6 tháng.',
        regressionEvidence,
      ).violations.map((item) => item.code),
    ).toContain('LABEL_MISMATCH');
  });
  it('still checks a new monetary label after an earlier duration', () => {
    expect(
      verifyAgentAnswer(
        'Trong 6 tháng mục tiêu 5.000.000 đ.',
        regressionEvidence,
      ).violations.map((item) => item.code),
    ).toContain('LABEL_MISMATCH');
  });
  it.each(['Thu nhập trung bình tháng 15.000.000 đ.', 'Dư tháng 5.000.000 đ.'])(
    'does not interpret a grouped amount as a calendar month: %s',
    (text) => {
      expect(verifyAgentAnswer(text, regressionEvidence)).toMatchObject({
        isValid: true,
      });
    },
  );
  it('does not treat month zero as a calendar month', () => {
    expect(
      verifyAgentAnswer('Tháng 0.', regressionEvidence).violations.map(
        (item) => item.code,
      ),
    ).not.toContain('PERIOD_MISMATCH');
  });
  it.each(['5.000.000,00 đ', '5,000,000.00 VND'])(
    'accepts grouped currency with decimals %s',
    (text) => {
      expect(verifyAgentAnswer(text, evidence).isValid).toBe(true);
    },
  );
  it.each(['5.000.000 đ', '5 triệu', '5tr', '0 đ', '6 tháng'])(
    'accepts the grounded numeric form %s',
    (value) => {
      expect(verifyAgentAnswer(value, evidence).isValid).toBe(true);
    },
  );
  it('accepts grounded 500k but rejects negative claims against positive evidence', () => {
    const data: AgentAnswerEvidence = {
      tools: [
        {
          name: 'calculate_budget_status',
          params: { month: '2026-11' },
          data: {
            budgets: [
              {
                id: 'b',
                category_id: null,
                limit_amount: 1000000,
                spent_amount: 500000,
                remaining_amount: 500000,
                overspent_amount: 0,
              },
            ],
          },
        },
      ],
    };
    expect(verifyAgentAnswer('500k', data).isValid).toBe(true);
    for (const text of ['-500k', 'thiếu 500k'])
      expect(
        verifyAgentAnswer(text, data).violations.map((v) => v.code),
      ).toContain('WRONG_SIGN');
  });
  it('distinguishes a duration from an invented calendar month', () => {
    expect(verifyAgentAnswer('Trong 6 tháng.', evidence).isValid).toBe(true);
    expect(
      verifyAgentAnswer('Tháng 6.', evidence).violations.map((v) => v.code),
    ).toContain('PERIOD_MISMATCH');
  });
  it.each(['https://example.com', '0912345678', '123456789012'])(
    'rejects identifying text %s',
    (text) => {
      expect(
        verifyAgentAnswer(text, evidence).violations.map((v) => v.code),
      ).toContain('PII_DETECTED');
    },
  );
  it('recognizes monthly shortfall with an approximation qualifier', () => {
    expect(
      verifyAgentAnswer('Thiếu hụt mỗi tháng khoảng 2 triệu.', evidence)
        .isValid,
    ).toBe(true);
  });
  it('returns a violation instead of throwing on impossible dates', () => {
    const data: AgentAnswerEvidence = {
      tools: [
        {
          name: 'calculate_budget_status',
          params: { month: '2026-02' },
          data: { budgets: [] },
        },
      ],
    };
    expect(
      verifyAgentAnswer('Ngày 31/02/2026.', data).violations.map((v) => v.code),
    ).toContain('PERIOD_MISMATCH');
  });
  it('checks snapshot income and expense labels separately within one sentence', () => {
    const data: AgentAnswerEvidence = {
      tools: [
        {
          name: 'get_financial_snapshot',
          params: {
            months: 3,
            fields: ['monthly_income_avg', 'monthly_expense_avg'],
          },
          data: {
            indicators: {
              monthly_income_avg: 15000000,
              monthly_expense_avg: 10000000,
            },
            period: { from: '2026-08-01', to: '2026-10-31' },
            currency: 'VND',
            dataQuality: 'complete',
          },
        },
      ],
    };
    expect(
      verifyAgentAnswer(
        'Thu nhập trung bình 15.000.000 đ/tháng, chi tiêu trung bình 10.000.000 đ/tháng.',
        data,
      ).isValid,
    ).toBe(true);
    expect(
      verifyAgentAnswer(
        'Thu nhập trung bình 10.000.000 đ/tháng, chi tiêu trung bình 15.000.000 đ/tháng.',
        data,
      ).violations.map((v) => v.code),
    ).toContain('LABEL_MISMATCH');
    expect(
      verifyAgentAnswer('Từ 01/08/2026 đến 31/10/2026.', data).isValid,
    ).toBe(true);
    expect(
      verifyAgentAnswer('Trong 3 tháng gần đây (01/08–31/10/2026).', data)
        .isValid,
    ).toBe(true);
    expect(
      verifyAgentAnswer(
        'Trong 3 tháng gần đây (01/07–31/10/2026).',
        data,
      ).violations.map((v) => v.code),
    ).toContain('PERIOD_MISMATCH');
    expect(
      verifyAgentAnswer('Từ 01/07/2026 đến 31/10/2026.', data).violations.map(
        (v) => v.code,
      ),
    ).toContain('PERIOD_MISMATCH');
  });
  it('distinguishes an overspent budget from its account balance', () => {
    const data: AgentAnswerEvidence = {
      tools: [
        {
          name: 'calculate_budget_status',
          params: { month: '2026-11' },
          data: {
            budgets: [
              {
                id: 'b',
                category_id: null,
                limit_amount: 1000000,
                spent_amount: 1500000,
                remaining_amount: 0,
                overspent_amount: 500000,
              },
            ],
          },
        },
        {
          name: 'get_financial_snapshot',
          params: { months: 1, fields: ['liquid_balance'] },
          data: {
            indicators: { liquid_balance: 12000000 },
            period: { from: '2026-11-01', to: '2026-11-30' },
            currency: 'VND',
            dataQuality: 'complete',
          },
        },
      ],
    };
    expect(verifyAgentAnswer('Vượt ngân sách 500.000 đ.', data).isValid).toBe(
      true,
    );
    expect(verifyAgentAnswer('Vượt hạn mức 500.000 đ.', data).isValid).toBe(
      true,
    );
    expect(
      verifyAgentAnswer(
        'Số dư tài khoản 12.000.000 đ, ngân sách còn lại 0 đ.',
        data,
      ).isValid,
    ).toBe(true);
    expect(
      verifyAgentAnswer(
        'Số dư tài khoản 0 đ, ngân sách còn lại 12.000.000 đ.',
        data,
      ).violations.map((v) => v.code),
    ).toContain('LABEL_MISMATCH');
  });
  it.each(['-2.000.000 đ', 'thiếu 2 triệu', 'âm 2 triệu'])(
    'accepts grounded shortfall %s',
    (text) => {
      expect(verifyAgentAnswer(text, evidence).isValid).toBe(true);
    },
  );
  it.each(['+2 triệu', 'còn dư 2.000.000 đ'])(
    'rejects inverted positive shortfall %s',
    (text) => {
      expect(
        verifyAgentAnswer(text, evidence).violations.map((v) => v.code),
      ).toContain('WRONG_SIGN');
    },
  );
  it.each(['3 tháng', '20%', '50/30/20'])(
    'rejects unsupported small numbers %s',
    (text) => {
      expect(
        verifyAgentAnswer(text, evidence).violations.map((v) => v.code),
      ).toContain('UNGROUNDED_NUMBER');
    },
  );
  it('permits numbered lists', () => {
    expect(
      verifyAgentAnswer('1. Xem xét.\n2. Cân nhắc.', evidence).isValid,
    ).toBe(true);
  });
  it('requires approximation words for close values', () => {
    const adjusted: AgentAnswerEvidence = {
      tools: [
        {
          name: 'plan_savings_goal',
          params: {},
          data: {
            monthlyAvailable: 4950000,
            requiredMonthlySaving: 4000000,
            remainingAfterSaving: 950000,
            months: 6,
            goalAmount: 24000000,
            savingsForGoal: 0,
          },
        },
      ],
    };
    expect(verifyAgentAnswer('Khoảng 5 triệu.', adjusted).isValid).toBe(true);
    expect(
      verifyAgentAnswer('5 triệu.', adjusted).violations.map((v) => v.code),
    ).toContain('UNGROUNDED_NUMBER');
  });
  it('distinguishes account balance from budget remainder', () => {
    const data: AgentAnswerEvidence = {
      tools: [
        {
          name: 'calculate_budget_status',
          params: { month: '2026-11' },
          data: {
            budgets: [
              {
                id: 'b',
                category_id: null,
                limit_amount: 1000000,
                spent_amount: 500000,
                remaining_amount: 500000,
                overspent_amount: 0,
              },
            ],
          },
        },
      ],
    };
    expect(
      verifyAgentAnswer('Số dư tài khoản còn 500.000 đ.', data).violations.map(
        (v) => v.code,
      ),
    ).toContain('LABEL_MISMATCH');
    expect(
      verifyAgentAnswer('Ngân sách còn lại 500.000 đ tháng 11/2026.', data)
        .isValid,
    ).toBe(true);
    expect(
      verifyAgentAnswer(
        'Ngân sách còn lại 500.000 đ tháng 12/2025.',
        data,
      ).violations.map((v) => v.code),
    ).toContain('PERIOD_MISMATCH');
  });
  it('detects internal fields, PII, unsafe advice and unrelated scope', () => {
    for (const [text, code] of [
      ['remaining_amount', 'INTERNAL_FIELD_LEAK'],
      ['Email a@example.com', 'PII_DETECTED'],
      ['Tôi cam kết lợi nhuận', 'UNSAFE_ADVICE'],
      ['Cách nấu món phở', 'SCOPE_VIOLATION'],
    ])
      expect(
        verifyAgentAnswer(text, evidence).violations.map((v) => v.code),
      ).toContain(code);
  });
  it.each([
    'Khả năng tiết kiệm mỗi tháng 5 triệu.',
    'Thiếu 2 triệu.',
    'Trong 6 tháng.',
    'Đã có sẵn 0 đ.',
  ])('accepts supported facts: %s', (text) => {
    expect(verifyAgentAnswer(text, evidence).isValid).toBe(true);
  });
  it.each([
    ['Dư 2 triệu.', 'WRONG_SIGN'],
    ['Cần tiết kiệm mỗi tháng 5 triệu.', 'LABEL_MISMATCH'],
    ['Trong 3 tháng.', 'UNGROUNDED_NUMBER'],
    ['Tháng 12/2025.', 'PERIOD_MISMATCH'],
    ['remainingAfterSaving', 'INTERNAL_FIELD_LEAK'],
  ])('rejects %s', (text, code) => {
    expect(
      verifyAgentAnswer(text, evidence).violations.map((item) => item.code),
    ).toContain(code);
  });
});
