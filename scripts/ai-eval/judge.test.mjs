import { expect, it } from 'vitest';
import { judgeAnswer } from './judge.mjs';

const c = {
  summary: { income: 3000000 },
  calculations: [],
  requiredNumbers: [3000000],
  group: 'overview',
};
it('accepts grouped/abbreviated money and exact negative values', () => {
  expect(judgeAnswer('Thu nhập 3.000.000 đồng.', c).strictNumbersValid).toBe(
    true,
  );
  expect(judgeAnswer('Thu nhập 3 triệu.', c).missingRequired).toEqual([]);
  expect(
    judgeAnswer('Phần dư -500.000 đồng.', {
      ...c,
      summary: { surplus: -500000 },
      requiredNumbers: [],
    }).strictNumbersValid,
  ).toBe(true);
});
it('rejects invented small amounts, durations and percentages', () => {
  for (const answer of ['Còn 99 đồng.', 'Cần 42 tháng.', 'Lợi nhuận 49%.'])
    expect(judgeAnswer(answer, c).strictNumbersValid, answer).toBe(false);
});
it('ignores list numbering only, and requires approximation words for rounding', () => {
  expect(
    judgeAnswer('1. Thu nhập 3 triệu.\n2) Kiểm tra lại dữ liệu.', c)
      .strictNumbersValid,
  ).toBe(true);
  expect(judgeAnswer('Thu nhập khoảng 2,9 triệu.', c).strictNumbersValid).toBe(
    true,
  );
  expect(judgeAnswer('Thu nhập 2,9 triệu.', c).strictNumbersValid).toBe(false);
});
it('does not treat percentile labels as invented numbers', () => {
  expect(
    judgeAnswer('Mức p25 là 2,25 triệu và p75 là 3,75 triệu.', {
      ...c,
      summary: { surplusP25Minor: 2250000, surplusP75Minor: 3750000 },
      requiredNumbers: [],
    }).strictNumbersValid,
  ).toBe(true);
});
it('marks empty and numeric-free evasive answers as insufficient without pretending fluency was scored', () => {
  expect(judgeAnswer('', c).strictNumbersValid).toBe(false);
  expect(judgeAnswer('Bạn nên xem lại dữ liệu.', c).missingRequired).toEqual([
    3000000,
  ]);
  expect(judgeAnswer('Bạn nên xem lại dữ liệu.', c).humanReview).toBe(
    'pending',
  );
});
