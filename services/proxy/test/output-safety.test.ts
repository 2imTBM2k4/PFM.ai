import { expect, it } from 'vitest';
import { classifyAdviceScope, isUnsafeAdviceAnswer } from '@pfm/domain';
import { UpstreamAiService } from '../src/services/upstream-ai';
import { config } from '../src/config';

it('rejects a model response cut at the token limit, even when it happens to be valid JSON', async () => {
  const previous = config.modelChainFree;
  config.modelChainFree = ['mock'];
  try {
    const service = new UpstreamAiService(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'length',
                message: { content: '{"metrics":[]}' },
              },
            ],
          }),
        ),
    );
    await expect(
      service.callPrompt('system', 'question'),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  } finally {
    config.modelChainFree = previous;
  }
});
it('permits a refusal to guarantee profits while blocking affirmative promises and write claims', () => {
  expect(isUnsafeAdviceAnswer('Tôi không cam kết lợi nhuận.')).toBe(false);
  expect(classifyAdviceScope('Tôi không cam kết lợi nhuận.').status).not.toBe(
    'restricted',
  );
  expect(isUnsafeAdviceAnswer('Tôi cam kết lợi nhuận.')).toBe(true);
  expect(isUnsafeAdviceAnswer('Tôi đã tạo ngân sách.')).toBe(true);
});
