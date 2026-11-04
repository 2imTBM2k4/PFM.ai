import { describe, expect, it } from 'vitest';

import { ADVICE_SYSTEM_PROMPT } from './advice-prompt';
import { renderFallbackTemplate, verifyNumbers } from './index';

describe('verifyNumbers guardrail', () => {
  it('extracts 40m and 50/30/20 from the question and strictly rejects an invented month count', () => {
    expect(
      verifyNumbers('Mua xe 40m và chia ngân sách 50/30/20', [], 0, true)
        .extracted,
    ).toEqual([40_000_000, 50, 30, 20]);
    expect(verifyNumbers('Cần 8 tháng', [7], 0, true).violations).toContain(8);
  });
  it('accepts exact numbers matching allowed values', () => {
    const text =
      'Khoản vay 10.000.000 trả trong 12 tháng với lãi 12%. Bạn sẽ trả 933.333 mỗi tháng.';
    const allowed = [10_000_000, 12, 933_333];
    const res = verifyNumbers(text, allowed);
    expect(res.isValid).toBe(true);
    expect(res.violations).toHaveLength(0);
  });

  it('accepts approximate numbers when preceded by an approximation word within tolerance', () => {
    // 930.000 is within 5% of 933.333 (~0.35% error)
    const text = 'Mỗi tháng bạn cần trả khoảng 930k nhé.';
    const allowed = [933_333];
    const res = verifyNumbers(text, allowed);
    expect(res.isValid).toBe(true);
  });

  it('rejects numbers that deviate without an approximation word', () => {
    const text = 'Mỗi tháng bạn cần trả 950.000 đồng.';
    const allowed = [933_333];
    const res = verifyNumbers(text, allowed);
    expect(res.isValid).toBe(false);
    expect(res.violations).toContain(950_000);
  });

  it('rejects hallucinated numbers exceeding tolerance even with an approximation word', () => {
    // 800.000 is 14% away from 933.333 (> 5% tolerance)
    const text = 'Mỗi tháng bạn cần trả khoảng 800.000 đồng.';
    const allowed = [933_333];
    const res = verifyNumbers(text, allowed);
    expect(res.isValid).toBe(false);
    expect(res.violations).toContain(800_000);
  });

  it('always accepts small integers under 100 for bullet points and item counts', () => {
    const text =
      'Có 2 cách: 1. Giảm chi tiêu ăn ngoài. 2. Tăng thu nhập làm thêm.';
    const allowed = [10_000_000];
    const res = verifyNumbers(text, allowed);
    expect(res.isValid).toBe(true);
  });

  it('ignores month names like tháng 12', () => {
    const text = 'Kế hoạch sẽ hoàn thành vào tháng 12 với số tiền 5.000.000.';
    const allowed = [5_000_000];
    const res = verifyNumbers(text, allowed);
    expect(res.isValid).toBe(true);
  });

  it('verifies amounts next to Vietnamese punctuation and quoted units', () => {
    expect(
      verifyNumbers(
        'Để dành 3 triệu mỗi tháng, khoản ăn ngoài 1.500.000 ₫.',
        [3_000_000, 1_500_000],
        500,
        true,
      ).isValid,
    ).toBe(true);
    expect(
      verifyNumbers('Giảm từ 3 triệu xuống 2 triệu.', [3_000_000], 500, true)
        .violations,
    ).toContain(2_000_000);
    expect(
      verifyNumbers(
        'Khoản ăn ngoài “3 triệu”, có thể giảm.',
        [3_000_000],
        500,
        true,
      ).isValid,
    ).toBe(true);
  });

  it('checks attached VND symbols instead of overlooking fabricated amounts', () => {
    expect(
      verifyNumbers('Bạn có 3.000.000₫ để dành.', [3_000_000], 0, true).isValid,
    ).toBe(true);
    expect(
      verifyNumbers('Bạn có 5.000.000₫ để dành.', [3_000_000], 0, true)
        .violations,
    ).toEqual([5_000_000]);
    expect(
      verifyNumbers('Số dư 4trđ và thêm 200kđ.', [4_000_000, 200_000], 0, true)
        .isValid,
    ).toBe(true);
    expect(
      verifyNumbers('Số dư 6trđ.', [4_000_000], 0, true).violations,
    ).toEqual([6_000_000]);
  });

  it('verifies dollar amounts and English approximations', () => {
    expect(
      verifyNumbers('Save $10.25 a month', [10.25], 500, true).isValid,
    ).toBe(true);
    expect(
      verifyNumbers('Save $1,000.25 a month', [1000.25], 500, true).isValid,
    ).toBe(true);
    expect(verifyNumbers('Save $11 a month', [10.25], 500, true).isValid).toBe(
      false,
    );
    expect(
      verifyNumbers('Save about $10 a month', [10.25], 500, true).isValid,
    ).toBe(true);
  });
});

describe('ADVICE_SYSTEM_PROMPT', () => {
  it('requires a specific opening observation instead of a generic preamble', () => {
    expect(ADVICE_SYSTEM_PROMPT).toContain(
      'Open with one specific observation about their own data',
    );
    expect(ADVICE_SYSTEM_PROMPT).toContain(
      'Never default to the 50/30/20 rule',
    );
  });

  it('keeps suggestions grounded in provided numbers', () => {
    expect(ADVICE_SYSTEM_PROMPT).toContain(
      'reuse numbers that already appear in <data>',
    );
    expect(ADVICE_SYSTEM_PROMPT).toContain(
      'Never calculate new amounts, percentages, totals or dates',
    );
    expect(ADVICE_SYSTEM_PROMPT).toContain(
      'You may compare two provided numbers',
    );
  });

  it('protects essential spending from being cut', () => {
    expect(ADVICE_SYSTEM_PROMPT).toContain(
      'Never suggest cutting housing, utilities, health, education, insurance or debt repayment',
    );
  });

  it('keeps the hard safety rules in place', () => {
    expect(ADVICE_SYSTEM_PROMPT).toContain(
      'Do not recommend specific financial products, banks, lenders',
    );
    expect(ADVICE_SYSTEM_PROMPT).toContain('untrusted user text');
    expect(ADVICE_SYSTEM_PROMPT).toContain(
      'Refuse legal, banking/product selection, investment, insurance, medical',
    );
  });

  it('allows exactly one data-grounded clarifying question', () => {
    expect(ADVICE_SYSTEM_PROMPT).toContain(
      'ask exactly one concrete question about that preference',
    );
    expect(ADVICE_SYSTEM_PROMPT).toContain('never ask the same thing twice');
  });
});

describe('renderFallbackTemplate', () => {
  it('renders purchase affordability template when affordable', () => {
    const tpl = renderFallbackTemplate({
      intent: 'purchase_affordability',
      calculations: [
        {
          type: 'time_to_afford',
          inputs: { price: 2000000, available: 2000000, surplus: 500000 },
          results: {
            remaining: 0,
            typicalMonths: 0,
            conservativeMonths: 0,
            optimisticMonths: 0,
          },
        },
      ],
    });
    expect(tpl).toContain('Bạn đã có đủ tiền');
  });

  it('renders purchase affordability template with surplus scenarios', () => {
    const tpl = renderFallbackTemplate({
      intent: 'purchase_affordability',
      calculations: [
        {
          type: 'time_to_afford',
          inputs: { price: 2000000, available: 200000, surplus: 600000 },
          results: {
            remaining: 1800000,
            typicalMonths: 3,
            conservativeMonths: 6,
            optimisticMonths: 2,
          },
        },
      ],
    });
    expect(tpl).toContain('cần khoảng 3 tháng');
    expect(tpl).toContain('tiết kiệm ít hơn bình thường: 6 tháng');
  });

  it('renders loan estimate template', () => {
    const tpl = renderFallbackTemplate({
      intent: 'loan_estimate',
      calculations: [
        {
          type: 'loan_estimate',
          inputs: {
            principal: 10000000,
            months: 12,
            annualRate: 0.12,
            rateType: 'flat',
          },
          results: {
            monthlyPayment: 933333,
            totalInterest: 1200000,
          },
        },
      ],
    });
    expect(tpl).toContain('Khoản vay');
    expect(tpl).toContain('lãi phẳng');
    expect(tpl).toContain('12% mỗi năm');
  });
});
