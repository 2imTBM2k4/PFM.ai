import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flags } from '../../app.config';
import { vi as messages } from '@/messages/vi';
import { en } from '@/messages/en';
import { classifyLocally, defaultAIService } from './ai-service';
import { runAdvice } from './advice-agent';

const preferences = vi.hoisted(() => ({ language: 'vi', currency: 'VND' }));
vi.mock('expo-crypto', () => ({ randomUUID: () => '11111111-2222-4333-8444-555555555555' }));
vi.mock('@/data/connection', () => ({ withDatabase: (fn: (db: unknown) => unknown) => fn({ getAllAsync: async () => [], getFirstAsync: async () => null }) }));
vi.mock('./ai-auth', () => ({ readAIAuth: async () => ({}), aiAuthHeaders: () => ({}) }));
vi.mock('@/state/preferences', () => ({
  usePreferences: { getState: () => preferences },
}));
vi.mock('./ai-service', () => ({
  classifyLocally: vi.fn(),
  defaultAIService: { sendMessage: vi.fn() },
  getProxyBaseUrl: () => 'https://example.test',
  isDevRuntime: () => false,
  buildAdviceClarification: () => 'clarification',
  applyAdviceDisclaimer: (value: unknown) => value,
}));
const input = {
  prompt: 'Tính kế hoạch tiết kiệm giúp tôi',
  userMessageId: 'current',
  history: [
    { id: 'old', role: 'user' as const, text: 'Thu nhập 15 triệu/tháng.' },
  ],
  context: {
    balance: 0,
    monthlyIncome: 0,
    monthlyExpense: 0,
    monthlyNet: 0,
    topCategories: [],
    budgetsCount: 0,
    goalsCount: 0,
  },
};
const reply = {
  id: 'reply',
  userMessageId: 'current',
  replyText: 'Kết quả đã kiểm tra.',
  createdAt: '2026-11-18T00:00:00Z',
};
beforeEach(() => {
  flags.useAgentLoop = false;
  preferences.language = 'vi';
  vi.mocked(classifyLocally)
    .mockReset()
    .mockResolvedValue({ requiresTool: true });
  vi.mocked(defaultAIService.sendMessage).mockReset().mockResolvedValue(reply);
});
afterEach(() => {
  flags.useAgentLoop = false;
});

it.each(['a@example.com', '+84912345678', 'https://example.com', '12345678901'])(
  'blocks personal information locally: %s',
  async (personalData) => {
    flags.useAgentLoop = true;
    const fetchFn = vi.fn<typeof fetch>();
    expect(await runAdvice({ ...input, prompt: personalData, fetchFn })).toMatchObject({
      replyText: messages.aiReplyPii,
    });
    expect(classifyLocally).not.toHaveBeenCalled();
    expect(defaultAIService.sendMessage).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  },
);

it('bypasses mini routing when disabled and forwards the original arguments once', async () => {
  expect(await runAdvice(input)).toBe(reply);
  expect(classifyLocally).not.toHaveBeenCalled();
  expect(defaultAIService.sendMessage).toHaveBeenCalledExactlyOnceWith(
    input.prompt,
    input.context,
    input.userMessageId,
    input.history,
  );
});
it('returns the local reply without a legacy/model call when enabled', async () => {
  flags.useAgentLoop = true;
  vi.mocked(classifyLocally).mockResolvedValue({
    requiresTool: false,
    localReply: reply,
  });
  expect(await runAdvice(input)).toBe(reply);
  expect(defaultAIService.sendMessage).not.toHaveBeenCalled();
});
it('uses the agent endpoint for supported advice when enabled', async () => {
  flags.useAgentLoop = true;
  const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
  const original = structuredClone(input);
  await runAdvice({ ...input, fetchFn });
  expect(fetchFn).toHaveBeenCalled();
  expect(String(fetchFn.mock.calls[0][0])).toContain('/v1/advice/step');
  expect(defaultAIService.sendMessage).not.toHaveBeenCalled();
  expect(input).toEqual(original);
});
it.each(['vi', 'en'] as const)(
  'returns a deterministic %s clarification for an unsupported route',
  async (language) => {
    flags.useAgentLoop = true;
    preferences.language = language;
    vi.mocked(classifyLocally).mockResolvedValue({ requiresTool: false, localReply: { ...reply, replyText: (language === 'vi' ? messages : en).aiReplyAmbiguous } });
    expect(await runAdvice(input)).toMatchObject({
      userMessageId: 'current',
      replyText: (language === 'vi' ? messages : en).aiReplyAmbiguous,
    });
    expect(defaultAIService.sendMessage).not.toHaveBeenCalled();
  },
);
it('returns immediately to the legacy path after switching the flag off', async () => {
  flags.useAgentLoop = true;
  await runAdvice(input);
  vi.mocked(classifyLocally).mockClear();
  vi.mocked(defaultAIService.sendMessage).mockClear();
  flags.useAgentLoop = false;
  expect(await runAdvice(input)).toBe(reply);
  expect(classifyLocally).not.toHaveBeenCalled();
  expect(defaultAIService.sendMessage).toHaveBeenCalledOnce();
});
it('does not retry a failing legacy request or mutate its input', async () => {
  flags.useAgentLoop = false;
  const before = structuredClone(input);
  const error = new Error('synthetic failure');
  vi.mocked(defaultAIService.sendMessage).mockRejectedValue(error);
  await expect(runAdvice(input)).rejects.toBe(error);
  expect(defaultAIService.sendMessage).toHaveBeenCalledOnce();
  expect(input).toEqual(before);
});
