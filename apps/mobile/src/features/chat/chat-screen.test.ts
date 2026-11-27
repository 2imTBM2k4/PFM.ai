import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from 'react-native';
import { flags } from '../../../app.config';
import * as adviceAgent from '@/services/advice-agent';
import Chat from '@/app/chat';
import { vi as viMessages } from '@/messages/vi';
import * as adviceContext from '@/services/advice-context';
import * as stateValidation from '@/services/advice-state-validation';
import * as correctionDetection from '@/services/correction-detection';
import { adviceStateFixture } from '@/services/advice-context.fixtures';
import {
  buildAdviceHistory,
  classifyLocally,
  defaultAIService,
} from '@/services/ai-service';

const harness = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as { current: unknown }[],
  cursor: 0,
  refCursor: 0,
  backSpy: vi.fn(),
  useStateContext: false,
  readState: vi.fn(),
  writeState: vi.fn(),
  readSources: vi.fn(),
  savedReply: vi.fn(async () => true),
  notify: vi.fn(async () => {}),
  currentSession: 'session-1',
  effects: [] as (() => unknown)[],
  persisted: {} as Record<string, unknown>,
  previousRows: [] as { id: string; text: string; created_at: string }[],
  sessions: [
    {
      id: 'session-1',
      title: 'Chi tiêu tháng 11',
      updatedAt: '2026-11-16T08:00:00.000Z',
      messageCount: 2,
    },
  ],
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => '11111111-2222-4333-8444-555555555555',
}));
vi.mock('@/services/ai-auth', () => ({
  readAIAuth: async () => ({ mode: 'guest', deviceId: 'test-device' }),
  aiAuthHeaders: () => ({}),
}));

vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return {
        extra: { flags: { useStateBackedContext: harness.useStateContext } },
      };
    },
  },
}));
vi.mock('@/data/conversation-state', () => ({
  readConversationState: harness.readState,
  writeConversationState: harness.writeState,
}));

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values))
      harness.values[index] =
        typeof initial === 'function' ? initial() : initial;
    return [
      harness.values[index],
      (next: unknown) => {
        harness.values[index] =
          typeof next === 'function' ? next(harness.values[index]) : next;
      },
    ];
  },
  useRef: (value: unknown) =>
    (harness.refs[harness.refCursor++] ??= { current: value }),
  useCallback: <T,>(fn: T) => fn,
  useEffect: (effect: () => unknown) => { harness.effects.push(effect); },
}));

vi.mock('@/components/native-route-guard', () => ({
  NativeRouteGuard: 'NativeRouteGuard',
}));
vi.mock('@/components/platform-icon', () => ({
  default: 'MaterialCommunityIcons',
}));
vi.mock('expo', () => ({ uuid: { v4: () => 'new-session' } }));
vi.mock('expo-router', () => ({
  useFocusEffect: () => {},
  useRouter: () => ({ back: harness.backSpy }),
}));
vi.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  default: 'Swipeable',
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: 'GestureHandlerRootView',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useAnimatedStyle: () => ({}),
}));
vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  Alert: { alert: vi.fn() },
  AppState: { currentState: 'active' },
  FlatList: 'FlatList',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
    hairlineWidth: 1,
  },
  View: 'View',
}));
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Button: 'Button',
  IconButton: 'IconButton',
  Text: 'Text',
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
}));
vi.mock('@/components/screen', () => ({
  Screen: 'Screen',
  styles: { fill: {}, subtlePanel: {} },
}));
vi.mock('@/components/ui/ai-orb', () => ({ AIOrb: 'AIOrb' }));
vi.mock('@/components/ui/glass-card', () => ({ GlassCard: 'GlassCard' }));
vi.mock('@/components/ui/pill', () => ({ Pill: 'Pill' }));
vi.mock('@/constants/theme', () => ({
  DesignSpacing: { xs: 8, sm: 12, md: 16 },
  createSoftShadow: () => ({}),
  useDesignTheme: () => ({
    mode: 'light',
    brand: {},
    card: { border: '#D1D1D6' },
    chat: {},
    text: { primary: '#111827', secondary: '#4B5563' },
  }),
  useFinancePalette: () => ({ danger: '#C62828', warningInk: '#B45309' }),
}));
vi.mock('@/data/connection', () => ({
  withDatabase: async (fn: (db: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock('@pfm/domain', async (original) => ({
  ...(await original<typeof import('@pfm/domain')>()),
  classifyAdviceScope: () => ({ status: 'allowed' }),
  parseAdviceQuery: () => ({ range: null }),
}));
vi.mock('@/data/repository', () => ({
  listChatMessages: async () => harness.previousRows,
  listChatSessions: async () => harness.sessions,
  deleteChatSessions: async () => {},
  saveChatMessage: async () => {},
  readChatSourceMessages: harness.readSources,
}));
vi.mock('@/features/chat/ai-category-chart', () => ({
  AICategoryBarChart: 'AICategoryBarChart',
}));
vi.mock('@/features/chat/composer', () => ({
  ChatComposer: 'ChatComposer',
}));
vi.mock('@/features/chat/history', () => ({
  mergeChatMessages: (current: unknown[]) => current,
}));
vi.mock('@/features/notifications/notification-settings-service', () => ({
  notifyAIReplyCompleted: harness.notify,
}));
vi.mock('@/state/app', () => ({
  useApp: Object.assign(
    (selector: (state: { chatSessionId: string }) => unknown) =>
      selector({ chatSessionId: harness.currentSession }),
    {
      getState: () => ({ chatSessionId: harness.currentSession }),
      setState: vi.fn((value: { chatSessionId: string }) => { harness.currentSession = value.chatSessionId; }),
    },
  ),
}));
vi.mock('@/state/preferences', () => ({
  usePreferences: Object.assign(
    (selector: (state: { language: string }) => unknown) =>
      selector({ language: 'vi' }),
    {
      getState: () => ({
        closeChat: vi.fn(),
        isChatOpen: true,
        language: 'vi',
        currency: 'VND',
      }),
    },
  ),
}));
vi.mock('@/services/ai-service', () => ({
  ADVICE_CLOCK: {},
  classifyLocally: vi.fn(async () => ({ requiresTool: true })),
  defaultAIService: { sendMessage: vi.fn() },
  buildAdviceHistory: vi.fn(() => []),
  fetchAIQuota: async () => null,
  formatAIQuotaBanner: () => '',
  loadPersistedAIReplyMap: async () => harness.persisted,
  readAIServiceContext: async () => ({}),
  savePersistedAIReplyIfMessageExists: harness.savedReply,
}));

function collect(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node))
    return node.flatMap((child) => collect(child, predicate));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const props = element.props as Record<string, unknown>;
  return [
    ...(predicate(element) ? [element] : []),
    ...collect(props.children as ReactNode, predicate),
    ...collect(props.headerRight as ReactNode, predicate),
  ];
}

function renderChat(isModal = true) {
  harness.cursor = 0;
  harness.refCursor = 0;
  harness.effects = [];
  return Chat({ isModal });
}

describe('state-backed context before sending advice', () => {
  afterEach(() => {
    flags.useAgentLoop = false;
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    harness.values = [];
    harness.refs = [];
    harness.currentSession = 'session-1';
    harness.savedReply.mockClear();
    harness.notify.mockClear();
    harness.persisted = {};
    harness.useStateContext = false;
    flags.useAgentLoop = false;
    vi.mocked(classifyLocally).mockClear();
    harness.readState.mockReset().mockResolvedValue(null);
    harness.writeState.mockReset().mockImplementation(async (state) => ({
      ...state,
      revision: state.revision + 1,
    }));
    harness.readSources.mockReset().mockResolvedValue([]);
    harness.previousRows = [];
    vi.mocked(buildAdviceHistory).mockReset().mockReturnValue([]);
    vi.mocked(defaultAIService.sendMessage).mockReset().mockResolvedValue({
      id: 'reply',
      userMessageId: 'current',
      replyText: 'Đã ghi nhận.',
      createdAt: '2026-11-16T00:00:00.000Z',
    });
  });

  async function send(prompt = 'Tôi muốn tiết kiệm mỗi tháng', waitForLegacy = true) {
    const composer = collect(
      renderChat(),
      (el) => el.type === 'ChatComposer',
    )[0];
    (
      composer.props.onAdviceSent as (
        message: unknown,
        sessionId: string,
      ) => void
    )(
      {
        id: 'current',
        text: prompt,
        created_at: '2026-11-16T00:00:00.000Z',
      },
      'session-1',
    );
    if (waitForLegacy) await vi.waitFor(() =>
      expect(defaultAIService.sendMessage).toHaveBeenCalledOnce(),
    );
  }

  it('keeps the legacy path without reading or writing state while the flag is off', async () => {
    const build = vi.spyOn(adviceContext, 'buildAdviceContext');
    const detect = vi.spyOn(correctionDetection, 'detectCorrection');
    await send();
    expect(buildAdviceHistory).toHaveBeenCalledOnce();
    expect(build).not.toHaveBeenCalled();
    expect(harness.readState).not.toHaveBeenCalled();
    expect(harness.writeState).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'uses the single advice entry point with useAgentLoop=%s',
    async (enabled) => {
      flags.useAgentLoop = enabled;
      const run = vi.spyOn(adviceAgent, 'runAdvice');
      if (enabled) run.mockResolvedValue({ id: 'reply', userMessageId: 'current', replyText: 'Đã ghi nhận.', createdAt: '2026-11-16T00:00:00.000Z' });
      await send(undefined, !enabled);
      if (enabled) await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0][0]).toMatchObject({
        prompt: 'Tôi muốn tiết kiệm mỗi tháng',
        userMessageId: 'current',
        history: [],
        context: {},
      });
      expect(classifyLocally).not.toHaveBeenCalled();
      expect(defaultAIService.sendMessage).toHaveBeenCalledTimes(enabled ? 0 : 1);
    },
  );

  it('commits explicit income once and builds context with the persisted revision', async () => {
    harness.useStateContext = true;
    const { state, sourceMessages } = adviceStateFixture();
    const prompt =
      'Thực ra thu nhập của tôi là 12 triệu/tháng. Tính lại giúp tôi.';
    harness.readState.mockResolvedValue(state);
    harness.readSources.mockResolvedValue([
      ...sourceMessages,
      {
        id: 'current',
        sessionId: 'session-1',
        text: prompt,
        createdAt: '2026-11-16T12:00:00.000Z',
      },
    ]);
    const build = vi.spyOn(adviceContext, 'buildAdviceContext');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await send(prompt);
    expect(harness.writeState).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 2,
        activeScenario: expect.objectContaining({
          income: expect.objectContaining({
            value: 12_000_000,
            factIds: ['new-session'],
          }),
        }),
      }),
      prompt,
      expect.any(Object),
    );
    expect(buildAdviceHistory).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('CORRECTION_COMMITTED', {
      targetField: 'income',
      factId: 'new-session',
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('12000000');
    expect(JSON.stringify(info.mock.calls)).not.toContain(prompt);
    const history = vi.mocked(defaultAIService.sendMessage).mock.calls[0][3];
    expect(history?.some((item) => item.id === 'current')).toBe(false);
    expect(state.activeScenario.income).toMatchObject({ value: 15_000_000 });
  });

  it.each([
    ['Thực ra tôi chưa dành riêng đồng nào', 'savingsForGoal', 0],
    ['Sửa lại thời hạn 12 tháng', 'savingsMonths', 12],
  ] as const)(
    'commits %s (%s) and builds context with the persisted revision',
    async (prompt, targetField, value) => {
      harness.useStateContext = true;
      const { state, sourceMessages } = adviceStateFixture();
      harness.readState.mockResolvedValue(state);
      harness.readSources.mockResolvedValue([
        ...sourceMessages,
        {
          id: 'current',
          sessionId: 'session-1',
          text: prompt,
          createdAt: '2026-11-16T12:00:00.000Z',
        },
      ]);
      const build = vi.spyOn(adviceContext, 'buildAdviceContext');
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      await send(prompt);
      expect(harness.writeState).toHaveBeenCalledOnce();
      expect(build).toHaveBeenCalledWith(
        expect.objectContaining({
          revision: 2,
          activeScenario: expect.objectContaining({
            [targetField]: expect.objectContaining({
              value,
              factIds: ['new-session'],
            }),
          }),
        }),
        prompt,
        expect.any(Object),
      );
      expect(buildAdviceHistory).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith('CORRECTION_COMMITTED', {
        targetField,
        factId: 'new-session',
      });
    },
  );

  it('falls back without writing after rejecting Thực ra 12 triệu', async () => {
    const prompt = 'Thực ra 12 triệu';
    harness.useStateContext = true;
    const { state, sourceMessages } = adviceStateFixture();
    harness.readState.mockResolvedValue(state);
    harness.readSources.mockResolvedValue(sourceMessages);
    const build = vi.spyOn(adviceContext, 'buildAdviceContext');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await send(prompt);
    expect(harness.writeState).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(buildAdviceHistory).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('CORRECTION_SKIPPED', {
      reason: 'ambiguous',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(prompt);
  });

  it('falls back after an optimistic conflict without retrying or logging evidence', async () => {
    harness.useStateContext = true;
    const { state } = adviceStateFixture();
    harness.readState.mockResolvedValue(state);
    harness.writeState.mockRejectedValue(
      new Error('CONVERSATION_STATE_CONFLICT'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const build = vi.spyOn(adviceContext, 'buildAdviceContext');
    await send('Thực ra thu nhập 12 triệu');
    expect(harness.writeState).toHaveBeenCalledOnce();
    expect(build).not.toHaveBeenCalled();
    expect(buildAdviceHistory).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('CORRECTION_SKIPPED', {
      reason: 'conflict',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('12 triệu');
  });

  it('creates unknown state once and builds with the committed revision while enabled', async () => {
    harness.useStateContext = true;
    const build = vi.spyOn(adviceContext, 'buildAdviceContext');
    await send();
    expect(harness.writeState).toHaveBeenCalledOnce();
    expect(harness.writeState.mock.calls[0][0]).toMatchObject({
      sessionId: 'session-1',
      revision: 0,
      facts: [],
    });
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1, facts: [] }),
      expect.any(String),
      expect.objectContaining({ sourceMessages: [] }),
    );
    expect(buildAdviceHistory).not.toHaveBeenCalled();
    expect(vi.mocked(defaultAIService.sendMessage).mock.calls[0][3]).toEqual(
      [],
    );
  });

  it('builds from existing state and sends only original evidence through history', async () => {
    harness.useStateContext = true;
    const { state, sourceMessages } = adviceStateFixture();
    harness.readState.mockResolvedValue(state);
    harness.readSources.mockResolvedValue(sourceMessages);
    const build = vi.spyOn(adviceContext, 'buildAdviceContext');
    const detect = vi.spyOn(correctionDetection, 'detectCorrection');
    await send();
    expect(detect).toHaveReturnedWith(null);
    expect(build).toHaveBeenCalledWith(
      state,
      expect.any(String),
      expect.any(Object),
    );
    expect(harness.writeState).not.toHaveBeenCalled();
    expect(buildAdviceHistory).not.toHaveBeenCalled();
    expect(vi.mocked(defaultAIService.sendMessage).mock.calls[0][3]).toEqual(
      sourceMessages.map(({ id, text }) => ({ id, role: 'user', text })),
    );
  });

  it('falls back to legacy and logs no private data when source validation fails', async () => {
    harness.useStateContext = true;
    const { state } = adviceStateFixture();
    harness.readState.mockResolvedValue(state);
    const validate = vi.spyOn(
      stateValidation,
      'validateConversationStateFacts',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await send();
    expect(validate).toHaveBeenCalled();
    expect(buildAdviceHistory).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('ADVICE_STATE_CONTEXT_FALLBACK');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('session-1');
  });

  it('preserves a non-correction follow-up through legacy until the initialized state has verified facts', async () => {
    harness.useStateContext = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    harness.writeState.mockImplementation(async (state) => {
      const saved = { ...state, revision: 1 };
      harness.readState.mockResolvedValue(saved);
      return saved;
    });
    await send();
    const prior = {
      id: 'first',
      text: 'Tôi muốn lập kế hoạch tiết kiệm mỗi tháng',
      created_at: '2026-11-15T00:00:00.000Z',
    };
    harness.previousRows = [prior];
    const expectedHistory = [
      { id: prior.id, role: 'user' as const, text: prior.text },
    ];
    vi.mocked(buildAdviceHistory).mockReturnValue(expectedHistory);
    vi.mocked(defaultAIService.sendMessage).mockClear();
    await send('Vậy tính mức dành mỗi tháng giúp tôi?');
    expect(harness.writeState).toHaveBeenCalledOnce();
    expect(buildAdviceHistory).toHaveBeenCalledWith(
      expect.any(String),
      [prior],
      expect.any(Object),
    );
    expect(vi.mocked(defaultAIService.sendMessage).mock.calls[0][3]).toEqual(
      expectedHistory,
    );
  });
});

describe('Chat header history control', () => {
  beforeEach(() => {
    harness.values = [];
    harness.refs = [];
    harness.backSpy.mockReset();
  });

  it.each([true, false])(
    'renders exactly one history button in Screen headerRight (isModal=%s) and toggles history cleanly',
    async (isModal) => {
      let tree = renderChat(isModal);
      const screen = collect(tree, (el) => el.type === 'Screen')[0]!;
      expect(screen.props.hideHeader).toBe(false);

      const historyButtons = collect(
        tree,
        (el) => el.type === 'Pill' && el.props.label === viMessages.aiHistory,
      );
      expect(historyButtons).toHaveLength(1);
      expect(
        collect(
          screen.props.children as ReactNode,
          (el) => el.type === 'Pill' && el.props.label === viMessages.aiHistory,
        ),
      ).toHaveLength(0);
      expect(historyButtons[0]!.props.selected).toBe(false);

      (historyButtons[0]!.props.onPress as () => void)();
      await new Promise((resolve) => setTimeout(resolve, 0));
      tree = renderChat(isModal);

      const openHistoryButtons = collect(
        tree,
        (el) => el.type === 'Pill' && el.props.label === viMessages.aiHistory,
      );
      expect(openHistoryButtons).toHaveLength(1);
      expect(openHistoryButtons[0]!.props.selected).toBe(true);
      expect(
        collect(
          tree,
          (el) => el.type === 'Pill' && el.props.label === viMessages.back,
        ),
      ).toHaveLength(0);

      // Tapping back while history is open returns to chat rather than closing the modal.
      const openScreen = collect(tree, (el) => el.type === 'Screen')[0]!;
      (openScreen.props.onBack as () => void)();
      expect(harness.backSpy).not.toHaveBeenCalled();

      tree = renderChat(isModal);
      const closedHistoryButton = collect(
        tree,
        (el) => el.type === 'Pill' && el.props.label === viMessages.aiHistory,
      )[0]!;
      expect(closedHistoryButton.props.selected).toBe(false);

      const rootScreen = collect(tree, (el) => el.type === 'Screen')[0]!;
      (rootScreen.props.onBack as () => void)();
      expect(harness.backSpy).toHaveBeenCalledOnce();
    },
  );
});

describe('agent streaming in chat', () => {
  const message = { id: 'current', text: 'Tôi muốn tiết kiệm', created_at: '2026-11-16T00:00:00.000Z' };
  const finalReply = { id: 'ai-current', userMessageId: 'current', replyText: 'Đã xong', createdAt: message.created_at };
  beforeEach(() => {
    harness.values = []; harness.refs = []; harness.currentSession = 'session-1';
    harness.savedReply.mockClear(); harness.notify.mockClear(); harness.readState.mockClear(); harness.writeState.mockClear();
    harness.useStateContext = true; flags.useAgentLoop = true;
  });
  afterEach(() => { flags.useAgentLoop = false; harness.useStateContext = false; AppState.currentState = 'active'; vi.restoreAllMocks(); });
  function start() {
    const composer = collect(renderChat(), (el) => el.type === 'ChatComposer')[0];
    (composer.props.onAdviceSent as (item: typeof message, sessionId: string) => void)(message, 'session-1');
  }
  function row() {
    const list = collect(renderChat(), (el) => el.type === 'FlatList')[0];
    return (list.props.renderItem as (input: { item: typeof message }) => ReactNode)({ item: message });
  }
  it('passes session and cancellation to the agent, skips legacy state preparation, and saves in the same session', async () => {
    const run = vi.spyOn(adviceAgent, 'runAdvice').mockResolvedValue(finalReply);
    start();
    await vi.waitFor(() => expect(harness.savedReply).toHaveBeenCalledOnce());
    expect(run.mock.calls[0][0]).toMatchObject({ sessionId: 'session-1', signal: expect.any(AbortSignal), onDelta: expect.any(Function) });
    expect(harness.readState).not.toHaveBeenCalled();
    expect(harness.writeState).not.toHaveBeenCalled();
    expect(harness.savedReply).toHaveBeenCalledWith(expect.anything(), finalReply, 'session-1');
  });
  it('shows verified segments in one bubble and replaces them with the final reply', async () => {
    let finish!: (reply: typeof finalReply) => void;
    const run = vi.spyOn(adviceAgent, 'runAdvice').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const delta = run.mock.calls[0][0].onDelta!;
    delta({ seq: 1, text: 'Một', verifiedText: 'Một', verification: 'segment_passed' });
    expect(collect(row(), (el) => el.type === 'Text' && el.props.children === 'Một')).toHaveLength(1);
    delta({ seq: 2, text: ' hai', verifiedText: 'Một hai', verification: 'segment_passed' });
    expect(collect(row(), (el) => el.type === 'Text' && el.props.children === 'Một hai')).toHaveLength(1);
    finish(finalReply);
    await vi.waitFor(() => expect(harness.savedReply).toHaveBeenCalledOnce());
    expect(collect(row(), (el) => el.type === 'Text' && el.props.children === 'Đã xong')).toHaveLength(1);
  });
  it.each(['failed', 'incomplete'] as const)('labels %s replies and does not notify in background', async (verification) => {
    AppState.currentState = 'background';
    const reply = { ...finalReply, incomplete: true, verification };
    vi.spyOn(adviceAgent, 'runAdvice').mockResolvedValue(reply);
    start();
    await vi.waitFor(() => expect(harness.savedReply).toHaveBeenCalledOnce());
    const label = verification === 'failed' ? viMessages.aiReplyVerificationFailedNote : viMessages.aiReplyIncompleteBadge;
    expect(collect(row(), (el) => el.type === 'Text' && el.props.accessibilityLabel === label)).toHaveLength(1);
    expect(harness.notify).not.toHaveBeenCalled();
  });
  it('notifies for a completed reply in background', async () => {
    AppState.currentState = 'background';
    vi.spyOn(adviceAgent, 'runAdvice').mockResolvedValue({ ...finalReply, incomplete: false });
    start();
    await vi.waitFor(() => expect(harness.notify).toHaveBeenCalledWith('Đã xong'));
  });
  it('aborts an older turn and ignores its late result and delta', async () => {
    let finish!: (reply: typeof finalReply) => void;
    const run = vi.spyOn(adviceAgent, 'runAdvice').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(finalReply);
    start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const previous = run.mock.calls[0][0];
    start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(previous.signal?.aborted).toBe(true);
    previous.onDelta?.({ seq: 1, text: 'cũ', verifiedText: 'cũ', verification: 'segment_passed' });
    finish(finalReply);
    await vi.waitFor(() => expect(harness.savedReply).toHaveBeenCalledOnce());
    expect(collect(row(), (el) => el.type === 'Text' && el.props.children === 'cũ')).toHaveLength(0);
  });
  it.each(['failed', 'incomplete'] as const)('restores the %s badge from persisted replies', async (verification) => {
    harness.persisted = { current: { ...finalReply, incomplete: true, verification } };
    renderChat();
    harness.effects[2]();
    await vi.waitFor(() => expect(harness.values[1]).toMatchObject(harness.persisted));
    const label = verification === 'failed' ? viMessages.aiReplyVerificationFailedNote : viMessages.aiReplyIncompleteBadge;
    expect(collect(row(), (el) => el.type === 'Text' && el.props.accessibilityLabel === label)).toHaveLength(1);
  });
  it('shows a local error and clears typing after an offline failure', async () => {
    vi.spyOn(adviceAgent, 'runAdvice').mockRejectedValue(new Error('offline'));
    start();
    await vi.waitFor(() => expect(collect(row(), (el) => el.type === 'Text' && el.props.children === viMessages.chatLoadError)).toHaveLength(1));
    expect(collect(row(), (el) => el.type === 'ActivityIndicator')).toHaveLength(0);
  });
  it('aborts on unmount and ignores the delayed reply', async () => {
    let finish!: (reply: typeof finalReply) => void;
    const run = vi.spyOn(adviceAgent, 'runAdvice').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderChat();
    const cleanup = harness.effects[1]() as () => void;
    start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.calls[0][0].signal!;
    cleanup();
    expect(signal.aborted).toBe(true);
    finish(finalReply);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.savedReply).not.toHaveBeenCalled();
  });
  it('aborts on session switch and discards the delayed reply', async () => {
    let finish!: (reply: typeof finalReply) => void;
    const run = vi.spyOn(adviceAgent, 'runAdvice').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    harness.sessions = [{ id: 'session-2', title: 'Phiên hai', updatedAt: '2026-11-16T08:00:00.000Z', messageCount: 1 }];
    start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const history = collect(renderChat(), (el) => el.type === 'Pill' && el.props.label === viMessages.aiHistory)[0];
    (history.props.onPress as () => void)();
    await vi.waitFor(() => expect(collect(renderChat(), (el) => el.type === 'GlassCard' && String(el.props.accessibilityLabel).startsWith('Phiên hai'))).toHaveLength(1));
    const session = collect(renderChat(), (el) => el.type === 'GlassCard' && String(el.props.accessibilityLabel).startsWith('Phiên hai'))[0];
    (session.props.onPress as () => void)();
    expect(run.mock.calls[0][0].signal?.aborted).toBe(true);
    run.mock.calls[0][0].onDelta?.({ seq: 1, text: 'trễ', verifiedText: 'trễ', verification: 'segment_passed' });
    finish(finalReply);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.savedReply).not.toHaveBeenCalled();
    expect(collect(row(), (el) => el.type === 'Text' && el.props.children === 'trễ')).toHaveLength(0);
  });
  it('ignores AbortError after a turn is cancelled', async () => {
    let reject!: (error: Error) => void;
    const run = vi.spyOn(adviceAgent, 'runAdvice').mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    harness.values[0] = [message];
    const button = collect(renderChat(), (el) => el.type === 'IconButton' && el.props.accessibilityLabel === viMessages.aiNewChat)[0];
    (button.props.onPress as () => void)();
    reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(collect(row(), (el) => el.type === 'Text' && el.props.children === viMessages.chatLoadError)).toHaveLength(0);
  });
  it('aborts the active turn when starting a new chat', async () => {
    const run = vi.spyOn(adviceAgent, 'runAdvice').mockImplementation(() => new Promise(() => {}));
    start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    harness.values[0] = [message];
    const button = collect(renderChat(), (el) => el.type === 'IconButton' && el.props.accessibilityLabel === viMessages.aiNewChat)[0];
    (button.props.onPress as () => void)();
    expect(run.mock.calls[0][0].signal?.aborted).toBe(true);
  });
  it('aborts the active turn when its session is deleted', async () => {
    const run = vi.spyOn(adviceAgent, 'runAdvice').mockImplementation(() => new Promise(() => {}));
    harness.sessions = [{ id: 'session-1', title: 'Phiên một', updatedAt: '2026-11-16T08:00:00.000Z', messageCount: 1 }];
    start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    (collect(renderChat(), (el) => el.type === 'Pill' && el.props.label === viMessages.aiHistory)[0].props.onPress as () => void)();
    await vi.waitFor(() => expect(collect(renderChat(), (el) => el.type === 'Swipeable')).toHaveLength(1));
    const swipe = collect(renderChat(), (el) => el.type === 'Swipeable')[0];
    const action = (swipe.props.renderRightActions as (progress: unknown) => ReactElement<{ onPress(): void }>)({ value: 0 });
    action.props.onPress();
    expect(run.mock.calls[0][0].signal?.aborted).toBe(true);
  });
  it('renders inline **bold**, *italic*, and ### headings cleanly without raw Markdown markers', async () => {
    vi.spyOn(adviceAgent, 'runAdvice').mockResolvedValue({
      ...finalReply,
      replyText:
        '### Các phương án trả nợ tham khảo\n*Chưa tính lãi/phí của khoản nợ:*\nSố dư là **2.624.000 ₫** (3 * 50.000).',
    });
    start();
    await vi.waitFor(() => expect(harness.savedReply).toHaveBeenCalledOnce());
    const headingSpans = collect(
      row(),
      (el) =>
        el.type === 'Text' &&
        el.props.children === 'Các phương án trả nợ tham khảo',
    );
    expect(headingSpans).toHaveLength(1);
    expect(headingSpans[0]!.props.style).toMatchObject({ fontWeight: '700' });
    const italicSpans = collect(
      row(),
      (el) =>
        el.type === 'Text' &&
        el.props.children === 'Chưa tính lãi/phí của khoản nợ:',
    );
    expect(italicSpans).toHaveLength(1);
    expect(italicSpans[0]!.props.style).toMatchObject({ fontStyle: 'italic' });
    const boldSpans = collect(
      row(),
      (el) => el.type === 'Text' && el.props.children === '2.624.000 ₫',
    );
    expect(boldSpans).toHaveLength(1);
    expect(boldSpans[0]!.props.style).toMatchObject({ fontWeight: '700' });
    const rawMarkers = collect(
      row(),
      (el) =>
        el.type === 'Text' &&
        typeof el.props.children === 'string' &&
        (el.props.children.includes('###') || el.props.children.includes('**')),
    );
    expect(rawMarkers).toHaveLength(0);
  });
});
