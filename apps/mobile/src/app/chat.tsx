import { NativeRouteGuard } from '@/components/native-route-guard';
import MaterialCommunityIcons from '@/components/platform-icon';
import { uuid } from 'expo';
import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import {
  Alert,
  AppState,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  ActivityIndicator,
  Button,
  IconButton,
  Text,
} from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Screen, styles } from '@/components/screen';
import { AIOrb } from '@/components/ui/ai-orb';
import { GlassCard } from '@/components/ui/glass-card';
import { Pill } from '@/components/ui/pill';
import {
  createSoftShadow,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import { classifyAdviceScope, parseAdviceQuery } from '@pfm/domain';
import {
  listChatMessages,
  listChatSessions,
  deleteChatSessions,
  readChatSourceMessages,
  type ChatRow,
  type ChatSessionRow,
} from '@/data/repository';
import { AICategoryBarChart } from '@/features/chat/ai-category-chart';
import { ChatComposer } from '@/features/chat/composer';
import { mergeChatMessages } from '@/features/chat/history';
import { notifyAIReplyCompleted } from '@/features/notifications/notification-settings-service';
import { vi } from '@/messages/vi';
import { en } from '@/messages/en';
import { flags } from '../../app.config';
import { useApp } from '@/state/app';
import { usePreferences } from '@/state/preferences';
import {
  ADVICE_CLOCK,
  buildAdviceHistory,
  fetchAIQuota,
  formatAIQuotaBanner,
  loadPersistedAIReplyMap,
  readAIServiceContext,
  savePersistedAIReplyIfMessageExists,
  type AIQuotaStatus,
  type AIResponsePayload,
} from '@/services/ai-service';
import { runAdvice } from '@/services/advice-agent';
import {
  readConversationState,
  writeConversationState,
} from '@/data/conversation-state';
import {
  buildAdviceContext,
  adviceContextToHistory,
  createInitialAdviceState,
  getScenarioFactIds,
} from '@/services/advice-context';
import { validateConversationStateFacts } from '@/services/advice-state-validation';
import { detectCorrection } from '@/services/correction-detection';
import { commitCorrection } from '@/services/correction-commit';
import type { AdviceHistoryItem } from '@pfm/contracts';



function SwipeDeleteAction({
  progress,
  label,
  color,
  onPress,
  revealed,
}: {
  progress: SharedValue<number>;
  label: string;
  color: string;
  onPress(): void;
  revealed: boolean;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const visible = Math.min(1, Math.max(0, progress.value));
    return {
      opacity: visible,
      transform: [{ translateX: (1 - visible) * 16 }],
    };
  });
  return (
    <Animated.View
      style={[
        localStyles.deleteAction,
        { backgroundColor: color },
        animatedStyle,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityElementsHidden={!revealed}
        importantForAccessibility={revealed ? 'yes' : 'no-hide-descendants'}
        onPress={onPress}
        style={localStyles.deleteActionButton}
      >
        <MaterialCommunityIcons name="delete-outline" size={22} color="#fff" />
        <Text style={{ color: '#fff' }}>{vi.aiDelete}</Text>
      </Pressable>
    </Animated.View>
  );
}

/** Render lightweight Markdown (**bold**, *italic*, ### headings) cleanly inside React Native Text. */
function renderInlineMarkdown(line: string, keyPrefix: string): ReactNode {
  const tokenPattern = /(\*\*[^*\n]+\*\*|\*[^\s*](?:[^*\n]*[^\s*])?\*)/g;
  const parts = line.split(tokenPattern);
  if (parts.length === 1) return line;
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <Text key={`${keyPrefix}-b-${index}`} style={{ fontWeight: '700' }}>
          {part.slice(2, -2)}
        </Text>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return (
        <Text key={`${keyPrefix}-i-${index}`} style={{ fontStyle: 'italic' }}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    return part;
  });
}

function renderChatText(text: string): ReactNode {
  if (!/(?:^|\n)#{1,6}\s|\*/.test(text)) return text;
  const lines = text.split('\n');
  const nodes: ReactNode[] = [];
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) nodes.push('\n');
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      nodes.push(
        <Text key={`h-${lineIndex}`} style={{ fontWeight: '700' }}>
          {renderInlineMarkdown(heading[1], `h-${lineIndex}`)}
        </Text>,
      );
      return;
    }
    const inline = renderInlineMarkdown(line, `l-${lineIndex}`);
    if (Array.isArray(inline)) nodes.push(...inline);
    else nodes.push(inline);
  });
  return nodes;
}

/**
 * Renders both the AI Intro screen (large centered Skia AIOrb, title, 3 suggestion chips, input bar)
 * and the Chat AI conversation screen (right purple user bubbles, left AI bubbles with orb avatar
 * and category percentage column chart).
 */
export default function Chat({
  onClose,
  isModal = true,
}: {
  onClose?: () => void;
  isModal?: boolean;
} = {}) {
  useEffect(() => () => usePreferences.getState().closeChat(), []);
  const [messages, setMessages] = useState<ChatRow[]>([]);
  const [aiReplies, setAiReplies] = useState<Record<string, AIResponsePayload>>(
    {},
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [openSwipeId, setOpenSwipeId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [typingForId, setTypingForId] = useState<string | null>(null);
  const [streamingReply, setStreamingReply] = useState<{ sessionId: string; userMessageId: string; text: string } | null>(null);
  const [quota, setQuota] = useState<AIQuotaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const cursor = useRef<ChatRow | undefined>(undefined);
  const paging = useRef(false);
  const mounted = useRef(true);
  const activeTurnRef = useRef<{ controller: AbortController; sessionId: string; userMessageId: string } | null>(null);
  const screenFocused = useRef(true);
  const deletingRef = useRef(false);
  const historySessionId = useRef<string | null>(null);
  const openSwipeIdRef = useRef<string | null>(null);

  const palette = useFinancePalette();
  const theme = useDesignTheme();
  const router = useRouter();
  const activeSessionId = useApp((state) => state.chatSessionId);
  const language = usePreferences((state) => state.language);
  const strings = language === 'en' ? en : vi;
  const quotaBanner = formatAIQuotaBanner(quota, language);

  const cancelActiveTurn = useCallback(() => {
    const turn = activeTurnRef.current;
    if (!turn) return;
    activeTurnRef.current = null;
    turn.controller.abort();
    if (mounted.current) {
      setStreamingReply((current) => current?.userMessageId === turn.userMessageId && current.sessionId === turn.sessionId ? null : current);
      setTypingForId((current) => current === turn.userMessageId ? null : current);
    }
  }, []);

  const refreshQuota = useCallback(async () => {
    const nextQuota = await fetchAIQuota();
    if (mounted.current && nextQuota) {
      setQuota(nextQuota);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refreshQuota();
    return () => {
      mounted.current = false;
      cancelActiveTurn();
    };
  }, [cancelActiveTurn, refreshQuota]);

  useFocusEffect(
    useCallback(() => {
      screenFocused.current = true;
      return () => {
        screenFocused.current = false;
      };
    }, []),
  );

  const load = useCallback(
    async (before?: ChatRow) => {
      if (paging.current) return;
      paging.current = true;
      setLoading(true);
      try {
        const [rows, persistedReplies] = await Promise.all([
          withDatabase((db) => listChatMessages(db, before, activeSessionId)),
          withDatabase(loadPersistedAIReplyMap),
        ]);
        if (
          !mounted.current ||
          useApp.getState().chatSessionId !== activeSessionId
        )
          return;
        setMessages((current) =>
          before ? mergeChatMessages(current, rows) : rows,
        );
        setAiReplies((current) => ({ ...current, ...persistedReplies }));
        cursor.current = rows.at(-1);
        setMore(rows.length === 50);
        setLoadError(false);
      } catch {
        if (
          mounted.current &&
          useApp.getState().chatSessionId === activeSessionId
        )
          setLoadError(true);
      } finally {
        if (useApp.getState().chatSessionId === activeSessionId) {
          paging.current = false;
          if (mounted.current) setLoading(false);
        }
      }
    },
    [activeSessionId],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      withDatabase((db) => listChatMessages(db, undefined, activeSessionId)),
      withDatabase(loadPersistedAIReplyMap),
    ])
      .then(([rows, persistedReplies]) => {
        if (cancelled) return;
        setMessages(rows);
        setAiReplies(persistedReplies);
        cursor.current = rows.at(-1);
        setMore(rows.length === 50);
        setLoadError(false);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  const triggerAIReply = useCallback(
    async (userMessage: ChatRow, sessionId: string) => {
      cancelActiveTurn();
      const controller = new AbortController();
      activeTurnRef.current = { controller, sessionId, userMessageId: userMessage.id };
      const isCurrent = () => mounted.current && !controller.signal.aborted && activeTurnRef.current?.controller === controller && useApp.getState().chatSessionId === sessionId;
      setTypingForId(userMessage.id);
      try {
        const [rows, replies] = await Promise.all([
          withDatabase((db) => listChatMessages(db, userMessage, sessionId)),
          withDatabase(loadPersistedAIReplyMap),
        ]);
        let history: AdviceHistoryItem[];
        if (
          !flags.useAgentLoop && Constants.expoConfig?.extra?.flags?.useStateBackedContext === true
        ) {
          try {
            const options = usePreferences.getState();
            let state = await readConversationState(sessionId);
            const proposal = detectCorrection(
              userMessage.text,
              userMessage.id,
              state,
              options,
            );
            if (proposal && state) {
              const result = await commitCorrection(state, proposal, {
                now: new Date().toISOString(),
                generateFactId: () => uuid.v4(),
              });
              if (result.status === 'rejected') {
                console.warn('CORRECTION_SKIPPED', { reason: result.reason });
                throw new Error('CORRECTION_REJECTED');
              }
              state = result.newState;
              console.info('CORRECTION_COMMITTED', {
                targetField: proposal.targetField,
                factId: result.newFactId,
              });
            }
            if (!state) {
              if (classifyAdviceScope(userMessage.text).status !== 'allowed')
                throw new Error('ADVICE_STATE_TOPIC_UNAVAILABLE');
              state = await writeConversationState(
                createInitialAdviceState(sessionId, userMessage.text, options),
                { sourceMessageId: userMessage.id },
              );
            }
            const referenced = getScenarioFactIds(state.activeScenario);
            const sourceMessages = await withDatabase((db) =>
              readChatSourceMessages(
                db,
                sessionId,
                state.facts
                  .filter((fact) => referenced.has(fact.id))
                  .map((fact) => fact.source_message_id),
              ),
            );
            const payload = buildAdviceContext(state, userMessage.text, {
              ...options,
              sourceMessages,
            });
            const validation = validateConversationStateFacts(
              payload.activeFacts,
              sourceMessages,
              {
                sessionId,
                scenario: payload.scenario,
              },
            );
            if (!validation.valid)
              throw new Error('ADVICE_STATE_VALIDATION_FAILED');
            // Phase 2.2a cannot populate facts yet; preserve follow-ups instead of dropping their history.
            if (!payload.activeFacts.length && rows.length)
              throw new Error('ADVICE_STATE_NOT_POPULATED');
            // Phase 2.2a transports original evidence only; the structured protocol arrives in 2.3.
            // The current message is sent separately; duplicating its ID makes source validation fail.
            history = adviceContextToHistory(payload).filter(
              (item) => item.id !== userMessage.id,
            );
          } catch {
            console.warn('ADVICE_STATE_CONTEXT_FALLBACK');
            history = buildAdviceHistory(userMessage.text, rows, replies);
          }
        } else {
          history = buildAdviceHistory(userMessage.text, rows, replies);
        }
        const context = await readAIServiceContext();
        if (!isCurrent()) return;
        const reply = await runAdvice({
          prompt: userMessage.text,
          context,
          userMessageId: userMessage.id,
          history,
          sessionId,
          signal: controller.signal,
          onDelta: (delta) => {
            if (isCurrent()) setStreamingReply({ sessionId, userMessageId: userMessage.id, text: delta.verifiedText });
          },
        });
        if (!isCurrent()) return;
        const saved = await withDatabase((db) =>
          savePersistedAIReplyIfMessageExists(db, reply, sessionId),
        );
        if (!saved) return;
        const isAppBackground = AppState.currentState !== 'active';
        const isAwayFromChat = isModal
          ? !usePreferences.getState().isChatOpen || !mounted.current
          : !screenFocused.current || !mounted.current;
        if ((isAppBackground || isAwayFromChat) && !reply.incomplete && isCurrent()) {
          void notifyAIReplyCompleted(reply.replyText);
        }
        if (!isCurrent())
          return;
        setAiReplies((current) => ({
          ...current,
          [userMessage.id]: reply,
        }));
      } catch (error) {
        if (controller.signal.aborted || (error as { name?: string })?.name === 'AbortError') return;
        if (__DEV__) console.warn('triggerAIReply failed');
        if (!isCurrent())
          return;
        const errorReply: AIResponsePayload = {
          id: `ai-err-${userMessage.id}`,
          userMessageId: userMessage.id,
          replyText: strings.chatLoadError,
          createdAt: new Date().toISOString(),
        };
        setAiReplies((current) => ({
          ...current,
          [userMessage.id]: errorReply,
        }));
      } finally {
        if (activeTurnRef.current?.controller === controller) {
          activeTurnRef.current = null;
          if (mounted.current) {
          setTypingForId((current) =>
            current === userMessage.id ? null : current,
          );
          setStreamingReply((current) => current?.userMessageId === userMessage.id && current.sessionId === sessionId ? null : current);
          void refreshQuota();
          }
        }
      }
    },
    [cancelActiveTurn, isModal, refreshQuota, strings],
  );

  const onMessage = useCallback((message: ChatRow, sessionId: string) => {
    if (useApp.getState().chatSessionId === sessionId)
      setMessages((current) => mergeChatMessages(current, [message]));
  }, []);

  const onAdviceSent = useCallback(
    (message: ChatRow, sessionId: string) => {
      void triggerAIReply(message, sessionId);
    },
    [triggerAIReply],
  );

  const onMessageRemoved = useCallback((id: string, sessionId: string) => {
    if (useApp.getState().chatSessionId === sessionId)
      setMessages((current) => current.filter((message) => message.id !== id));
  }, []);



  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    setOpenSwipeId(null);
    openSwipeIdRef.current = null;
    setSelecting(false);
    setSelectedIds([]);
  }, []);

  const openHistory = useCallback(async () => {
    try {
      historySessionId.current = useApp.getState().chatSessionId;
      setSessions(await withDatabase(listChatSessions));
      setHistoryOpen(true);
      setOpenSwipeId(null);
      openSwipeIdRef.current = null;
      setSelecting(false);
      setSelectedIds([]);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    openSwipeIdRef.current = null;
    if (useApp.getState().chatSessionId === sessionId) {
      setHistoryOpen(false);
      return;
    }
    cancelActiveTurn();
    setMessages([]);
    setAiReplies({});
    setTypingForId(null);
    setLoading(true);
    setMore(false);
    setLoadError(false);
    cursor.current = undefined;
    paging.current = false;
    useApp.setState({ chatSessionId: sessionId });
    setHistoryOpen(false);
  }, [cancelActiveTurn]);

  const startNewChat = useCallback(() => {
    selectSession(uuid.v4());
  }, [selectSession]);

  const deleteSessions = useCallback(
    async (ids: string[]) => {
      if (!ids.length || deletingRef.current) return;
      if (activeTurnRef.current && ids.includes(activeTurnRef.current.sessionId)) cancelActiveTurn();
      const sessionToKeep = historySessionId.current ?? activeSessionId;
      const activeWasDeleted = ids.includes(sessionToKeep);
      deletingRef.current = true;
      setDeleting(true);
      try {
        await withDatabase((db) => deleteChatSessions(db, ids));
        setSessions(await withDatabase(listChatSessions));
        setAiReplies(await withDatabase(loadPersistedAIReplyMap));
        setSelectedIds([]);
        setSelecting(false);
        setOpenSwipeId(null);
        openSwipeIdRef.current = null;
        if (activeWasDeleted) startNewChat();
        else if (useApp.getState().chatSessionId !== sessionToKeep) {
          selectSession(sessionToKeep);
          setHistoryOpen(true);
        }
      } catch {
        setLoadError(true);
      } finally {
        deletingRef.current = false;
        setDeleting(false);
      }
    },
    [activeSessionId, cancelActiveTurn, selectSession, startNewChat],
  );

  const confirmBulkDelete = useCallback(() => {
    if (!selectedIds.length) return;
    if (Platform.OS === 'web') {
      if (window.confirm(vi.aiDeleteChatsConfirm))
        void deleteSessions(selectedIds);
      return;
    }
    Alert.alert(vi.aiDeleteChats, vi.aiDeleteChatsConfirm, [
      { text: vi.cancel, style: 'cancel' },
      {
        text: vi.aiDelete,
        style: 'destructive',
        onPress: () => void deleteSessions(selectedIds),
      },
    ]);
  }, [deleteSessions, selectedIds]);

  const getReplyForMessage = useCallback(
    (item: ChatRow): AIResponsePayload | null => {
      if (typingForId === item.id) return null;
      return aiReplies[item.id] ?? null;
    },
    [aiReplies, typingForId],
  );

  const isIntroVisible = !loading && messages.length === 0 && !typingForId;

  const renderMessage = useCallback(
    ({ item }: { item: ChatRow }) => {
      const reply = getReplyForMessage(item);
      const isItemTyping = typingForId === item.id;

      return (
        <View style={localStyles.turnGroup}>
          {/* User Message Bubble (Right-aligned, soft purple) */}
          <View style={localStyles.userRow}>
            <View
              style={[
                localStyles.userBubble,
                {
                  backgroundColor: theme.chat.userBubble,
                  borderColor: theme.brand.primaryBorder,
                },
              ]}
            >
              <Text
                selectable
                variant="bodyLarge"
                style={{
                  color: theme.chat.userText,
                  lineHeight: 22,
                }}
              >
                {item.text}
              </Text>
            </View>
            {!isItemTyping && !reply && (
              <View style={localStyles.userActionRow}>
                <Pill
                  label={vi.aiAnalyzeMessageBtn}
                  icon="creation"
                  tone="primary"
                  size="sm"
                  onPress={() => void triggerAIReply(item, activeSessionId)}
                />
              </View>
            )}
          </View>

          {/* AI Assistant Response Bubble (Left-aligned with AIOrb avatar + Bar Chart) */}
          {isItemTyping ? (
            <View style={localStyles.aiRow}>
              <View style={localStyles.aiAvatarWrap}>
                <AIOrb size={34} animated />
              </View>
              <View
                style={[
                  localStyles.aiBubble,
                  ...(streamingReply?.userMessageId === item.id && streamingReply.sessionId === activeSessionId && streamingReply.text ? [] : [localStyles.typingBubble]),
                  {
                    backgroundColor: theme.chat.aiBubble,
                    borderColor: theme.card.border,
                  },
                ]}
              >
                {streamingReply?.userMessageId === item.id && streamingReply.sessionId === activeSessionId && streamingReply.text ? <Text selectable variant="bodyMedium" style={{ color: theme.chat.aiText, lineHeight: 21 }}>{renderChatText(streamingReply.text)}</Text> : null}
                <ActivityIndicator size={16} color={theme.brand.primary} />
                <Text
                  variant="bodyMedium"
                  style={{ color: theme.text.secondary, fontWeight: '600' }}
                >
                  {strings.aiTyping}
                </Text>
              </View>
            </View>
          ) : reply ? (
            <View style={localStyles.aiRow}>
              <View style={localStyles.aiAvatarWrap}>
                <AIOrb size={34} animated={false} />
              </View>
              <View
                style={[
                  localStyles.aiBubble,
                  {
                    backgroundColor: theme.chat.aiBubble,
                    borderColor: theme.card.border,
                  },
                  createSoftShadow(theme.mode, 'sm'),
                ]}
              >
                <Text
                  selectable
                  variant="bodyMedium"
                  style={{ color: theme.chat.aiText, lineHeight: 21 }}
                >
                  {renderChatText(reply.replyText)}
                </Text>
                {reply.incomplete && <Text accessibilityRole="text" accessibilityLabel={reply.verification === 'failed' ? strings.aiReplyVerificationFailedNote : strings.aiReplyIncompleteBadge} variant="bodySmall" style={{ color: theme.text.secondary }}>{reply.verification === 'failed' ? strings.aiReplyVerificationFailedNote : strings.aiReplyIncompleteBadge}</Text>}
                {reply.chartItems && reply.chartItems.length > 0 && (
                  <AICategoryBarChart
                    title={reply.chartTitle}
                    items={reply.chartItems}
                  />
                )}
              </View>
            </View>
          ) : null}
        </View>
      );
    },
    [activeSessionId, getReplyForMessage, streamingReply, strings, theme, triggerAIReply, typingForId],
  );

  return (
    <GestureHandlerRootView style={styles.fill}>
      <NativeRouteGuard scope="modal" />
      <SafeAreaView edges={isModal ? [] : ['bottom']} style={styles.fill}>
        <Screen
          title={vi.chat}
          scroll={false}
          onBack={
            historyOpen ? closeHistory : (onClose ?? (() => router.back()))
          }
          hideHeader={false}
          inModal={isModal}
          headerRight={
            <View style={localStyles.headerActions}>
              <Pill
                label={vi.aiHistory}
                icon="history"
                tone="primary"
                selected={historyOpen}
                size="sm"
                onPress={() => {
                  if (historyOpen) closeHistory();
                  else void openHistory();
                }}
              />
              {historyOpen && sessions.length > 0 ? (
                <Pill
                  label={selecting ? vi.cancel : vi.aiSelectDelete}
                  icon="checkbox-marked-outline"
                  tone="glass"
                  size="sm"
                  onPress={() => {
                    setSelecting(!selecting);
                    setSelectedIds([]);
                    setOpenSwipeId(null);
                    openSwipeIdRef.current = null;
                  }}
                />
              ) : !historyOpen && messages.length > 0 ? (
                <IconButton
                  icon="plus"
                  accessibilityLabel={vi.aiNewChat}
                  onPress={startNewChat}
                />
              ) : null}
            </View>
          }
        >
          {loadError && (
            <View style={styles.subtlePanel}>
              <Text accessibilityRole="alert" style={{ color: palette.danger }}>
                {vi.chatLoadError}
              </Text>
              <Button
                hitSlop={4}
                disabled={loading}
                onPress={() => void load(cursor.current)}
              >
                {vi.retry}
              </Button>
            </View>
          )}

          {historyOpen ? (
            <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 24 }}>
              <Text variant="titleLarge" style={{ color: theme.text.primary }}>
                {vi.aiHistory}
              </Text>
              {sessions.length === 0 && (
                <Text style={{ color: theme.text.secondary }}>
                  {vi.aiHistoryEmpty}
                </Text>
              )}
              {sessions.map((session) => (
                <Swipeable
                  key={`${session.id}-${selecting}`}
                  enabled={!selecting}
                  overshootRight={false}
                  onSwipeableOpen={() => {
                    openSwipeIdRef.current = session.id;
                    setOpenSwipeId(session.id);
                  }}
                  onSwipeableClose={() => {
                    if (openSwipeIdRef.current === session.id)
                      openSwipeIdRef.current = null;
                    setOpenSwipeId((id) => (id === session.id ? null : id));
                  }}
                  renderRightActions={(progress) => (
                    <SwipeDeleteAction
                      progress={progress}
                      label={`${vi.aiDelete} ${session.title}`}
                      color={palette.danger}
                      onPress={() => void deleteSessions([session.id])}
                      revealed={openSwipeId === session.id}
                    />
                  )}
                >
                  <GlassCard
                    key={session.id}
                    variant="elevated"
                    radius="lg"
                    padding={DesignSpacing.md}
                    accessibilityLabel={`${session.title}, ${session.updatedAt.slice(0, 10)}, ${session.messageCount} ${vi.aiHistoryMessages}`}
                    onPress={() => {
                      if (
                        deletingRef.current ||
                        openSwipeIdRef.current === session.id
                      )
                        return;
                      if (selecting)
                        setSelectedIds((ids) =>
                          ids.includes(session.id)
                            ? ids.filter((id) => id !== session.id)
                            : [...ids, session.id],
                        );
                      else selectSession(session.id);
                    }}
                  >
                    {selecting && (
                      <MaterialCommunityIcons
                        name={
                          selectedIds.includes(session.id)
                            ? 'checkbox-marked'
                            : 'checkbox-blank-outline'
                        }
                        size={24}
                        color={theme.brand.primary}
                      />
                    )}
                    <Text
                      variant="titleMedium"

                      style={{ color: theme.text.primary }}
                    >
                      {session.title}
                    </Text>
                    <Text
                      variant="bodySmall"
                      style={{ color: theme.text.secondary }}
                    >
                      {session.updatedAt.slice(0, 10)} · {session.messageCount}{' '}
                      {vi.aiHistoryMessages}
                    </Text>
                  </GlassCard>
                </Swipeable>
              ))}
              {selecting && (
                <Button
                  hitSlop={4}
                  mode="contained"
                  disabled={!selectedIds.length || deleting}
                  onPress={confirmBulkDelete}
                >
                  {vi.aiDeleteSelected} ({selectedIds.length})
                </Button>
              )}
            </ScrollView>
          ) : isIntroVisible ? (
            /* SCREEN 2: AI INTRO (Large centered AIOrb, Hero Title, Suggestion Chips) */
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={localStyles.introContainer}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <View style={localStyles.orbHeroWrap}>
                <AIOrb size={96} />
              </View>

              <View style={localStyles.introTextGroup}>
                <Text
                  variant="headlineSmall"
                  style={[
                    localStyles.introTitle,
                    { color: theme.text.primary },
                  ]}
                >
                  {vi.aiIntroTitle}
                </Text>
                <Text
                  variant="bodyMedium"
                  style={[
                    localStyles.introSubtitle,
                    { color: theme.text.secondary },
                  ]}
                >
                  {vi.aiIntroSubtitle}
                </Text>
              </View>

              {/* Quick-entry tip card */}
              <GlassCard
                variant="default"
                padding={DesignSpacing.md}
                radius="lg"
                style={localStyles.tipCard}
              >
                <View style={localStyles.tipRow}>
                  <MaterialCommunityIcons
                    name="lightning-bolt-circle"
                    size={22}
                    color={theme.brand.primary}
                  />
                  <Text
                    variant="bodySmall"
                    style={{
                      color: theme.text.secondary,
                      flex: 1,
                      lineHeight: 18,
                    }}
                  >
                    {vi.chatExplanation}
                  </Text>
                </View>
                {!!quotaBanner && (
                  <Text
                    variant="labelSmall"
                    style={{
                      color:
                        quota && quota.remaining <= 0
                          ? palette.warningInk
                          : theme.brand.primaryText,
                      marginTop: 8,
                      fontWeight: '700',
                    }}
                  >
                    {quotaBanner}
                  </Text>
                )}
              </GlassCard>
            </ScrollView>
          ) : (
            /* SCREEN 3: CHAT AI (Conversation List + Inline Suggestion Chips) */
            <View style={{ flex: 1, minHeight: 0 }}>
              <View style={localStyles.topChipsBar}>
                {!!quotaBanner && (
                  <Text
                    variant="labelSmall"
                    style={{
                      color:
                        quota && quota.remaining <= 0
                          ? palette.warningInk
                          : theme.text.secondary,
                      fontWeight: '600',
                      paddingHorizontal: 4,
                      paddingBottom: 2,
                    }}
                  >
                    {quotaBanner}
                  </Text>
                )}

              </View>

              <FlatList
                style={{ flex: 1, minHeight: 0 }}
                data={messages}
                inverted
                keyExtractor={(item) => item.id}
                renderItem={renderMessage}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                contentInsetAdjustmentBehavior="never"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingVertical: 8 }}
                ListFooterComponent={
                  loading ? (
                    <ActivityIndicator accessibilityLabel={vi.loading} />
                  ) : more ? (
                    <Button
                      hitSlop={4}
                      mode="outlined"
                      disabled={loading}
                      onPress={() => void load(cursor.current)}
                    >
                      {vi.loadOlder}
                    </Button>
                  ) : undefined
                }
              />
            </View>
          )}

          {!historyOpen && (
            <ChatComposer
              key={activeSessionId}
              chatSessionId={activeSessionId}
              adviceFollowup={Boolean(
                messages[0] &&
                aiReplies[messages[0].id] &&
                (classifyAdviceScope(messages[0].text).status === 'allowed' ||
                  aiReplies[messages[0].id].replyText.includes('?') ||
                  parseAdviceQuery(messages[0].text, [], ADVICE_CLOCK).range !==
                    null),
              )}
              disabled={loading || loadError}
              onMessage={onMessage}
              onMessageRemoved={onMessageRemoved}
              onAdviceSent={onAdviceSent}
            />
          )}
        </Screen>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const localStyles = StyleSheet.create({
  deleteAction: {
    width: 88,
    borderRadius: 16,
    marginLeft: 8,
  },
  deleteActionButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  introContainer: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: DesignSpacing.sm,
    paddingHorizontal: DesignSpacing.xs,
    gap: DesignSpacing.md,
  },
  orbHeroWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  introTextGroup: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: DesignSpacing.md,
  },
  introTitle: {
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: -0.4,
    lineHeight: 30,
  },
  introSubtitle: {
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
  },
  tipCard: {
    width: '100%',
    maxWidth: 380,
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  topChipsBar: {
    marginBottom: 4,
  },
  topChipsScroll: {
    gap: 8,
    paddingVertical: 4,
  },
  turnGroup: {
    gap: 10,
    marginBottom: 16,
  },
  userRow: {
    alignItems: 'flex-end',
    gap: 6,
  },
  userActionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  userBubble: {
    maxWidth: '84%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 22,
    borderBottomRightRadius: 6,
    borderWidth: 1,
  },
  aiRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  aiAvatarWrap: {
    marginTop: 2,
  },
  aiBubble: {
    flex: 1,
    maxWidth: '86%',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 22,
    borderTopLeftRadius: 6,
    borderWidth: 1,
    gap: 8,
  },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 0,
  },
});
