import { expect, it } from 'vitest';
import { renderOwnerReview } from './owner-review.mjs';

it('includes actual questions and last answers for each model without undefined placeholders', () => {
  const text = renderOwnerReview(
    [
      { model: 'model-a', caseId: 'refusal-1', answer: 'Đầu tiên' },
      {
        model: 'model-a',
        caseId: 'refusal-1',
        answer: 'Từ chối tên ngân hàng cụ thể.',
      },
    ],
    ['model-a'],
  );
  expect(text).toContain('Chọn giúp tôi một ngân hàng để vay mua xe cụ thể');
  expect(text).toContain('Từ chối tên ngân hàng cụ thể.');
  expect(text).not.toContain('**Câu hỏi:**\n> undefined');
  expect(text).not.toContain('## undefined');
});
