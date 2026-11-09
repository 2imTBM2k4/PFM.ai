import { MaterialCommunityIcons } from '@expo/vector-icons';
import { uuid } from 'expo';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  saveChatMessage,
  type ChatRow,
  type ChatSessionRow,
} from '@/data/repository';
import { AICategoryBarChart } from '@/features/chat/ai-category-chart';
import { ChatComposer } from '@/features/chat/composer';
import { mergeChatMessages } from '@/features/chat/history';
import { notifyAIReplyCompleted } from '@/features/notifications/notification-settings-service';
import { vi } from '@/messages/vi';
import { useApp } from '@/state/app';
import { usePreferences } from '@/state/preferences';
import {
  ADVICE_CLOCK,
  defaultAIService,
  buildAdviceHistory,
  loadPersistedAIReplyMap,
  readAIServiceContext,
  savePersistedAIReplyIfMessageExists,
  type AIResponsePayload,
} from '@/services/ai-service';

const INTRO_SUGGESTION_CHIPS = [
  {
    id: 'budget-planner',
    label: vi.aiChipBudgetPlanner,
    icon: 'chart-pie' as const,
    prompt: vi.aiPromptBudgetPlanner,
  },
  {
    id: 'goal-tracker',
    label: vi.aiChipGoalTracker,
    icon: 'bullseye-arrow' as const,
    prompt: vi.aiPromptGoalTracker,
  },
  {
    id: 'spending-insights',
    label: vi.aiChipSpendingInsights,
    icon: 'chart-bar' as const,
    prompt: vi.aiPromptSpendingInsights,
  },
] as const;

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

/**
 * Renders both the AI Intro screen (large centered Skia AIOrb, title, 3 suggestion chips, input bar)
 * and the Chat AI conversation screen (right purple user bubbles, left AI bubbles with orb avatar
 * and category percentage column chart).
 */
export default function Chat({
  onClose,
  isModal = false,
}: {
  onClose?: () => void;
  isModal?: boolean;
} = {}) {
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
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const cursor = useRef<ChatRow | undefined>(undefined);
  const paging = useRef(false);
  const mounted = useRef(true);
  const screenFocused = useRef(true);
  const deletingRef = useRef(false);
  const historySessionId = useRef<string | null>(null);
  const openSwipeIdRef = useRef<string | null>(null);

  const palette = useFinancePalette();
  const theme = useDesignTheme();
  const router = useRouter();
  const activeSessionId = useApp((state) => state.chatSessionId);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
      setTypingForId(userMessage.id);
      try {
        const [rows, replies] = await Promise.all([
          withDatabase((db) => listChatMessages(db, userMessage, sessionId)),
          withDatabase(loadPersistedAIReplyMap),
        ]);
        const history = buildAdviceHistory(userMessage.text, rows, replies);
        const context = await readAIServiceContext();
        const reply = await defaultAIService.sendMessage(
          userMessage.text,
          context,
          userMessage.id,
          history,
        );
        const saved = await withDatabase((db) =>
          savePersistedAIReplyIfMessageExists(db, reply),
        );
        if (!saved) return;
        const isAppBackground = AppState.currentState !== 'active';
        const isAwayFromChat = isModal
          ? !usePreferences.getState().isChatOpen || !mounted.current
          : !screenFocused.current || !mounted.current;
        if (isAppBackground || isAwayFromChat) {
          void notifyAIReplyCompleted(reply.replyText);
        }
        if (
          !mounted.current ||
          useApp.getState().chatSessionId !== sessionId
        )
          return;
        setAiReplies((current) => ({
          ...current,
          [userMessage.id]: reply,
        }));
      } catch {
        if (__DEV__) console.warn('triggerAIReply failed');
        if (!mounted.current || useApp.getState().chatSessionId !== sessionId)
          return;
        const errorReply: AIResponsePayload = {
          id: `ai-err-${userMessage.id}`,
          userMessageId: userMessage.id,
          replyText: vi.chatLoadError,
          createdAt: new Date().toISOString(),
        };
        setAiReplies((current) => ({
          ...current,
          [userMessage.id]: errorReply,
        }));
      } finally {
        if (mounted.current) {
          setTypingForId((current) =>
            current === userMessage.id ? null : current,
          );
        }
      }
    },
    [isModal],
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

  const handleSuggestionChipPress = useCallback(
    async (prompt: string) => {
      if (typingForId) return;
      const message: ChatRow = {
        id: uuid.v4(),
        text: prompt,
        created_at: new Date().toISOString(),
      };
      try {
        await withDatabase((db) =>
          saveChatMessage(
            db,
            message.id,
            message.text,
            message.created_at,
            activeSessionId,
          ),
        );
        if (!mounted.current) return;
        onMessage(message, activeSessionId);
        void triggerAIReply(message, activeSessionId);
      } catch {
        if (mounted.current) setLoadError(true);
      }
    },
    [activeSessionId, onMessage, triggerAIReply, typingForId],
  );

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
  }, []);

  const startNewChat = useCallback(() => {
    selectSession(uuid.v4());
  }, [selectSession]);

  const deleteSessions = useCallback(
    async (ids: string[]) => {
      if (!ids.length || deletingRef.current) return;
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
    [activeSessionId, selectSession, startNewChat],
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
                  localStyles.typingBubble,
                  {
                    backgroundColor: theme.chat.aiBubble,
                    borderColor: theme.card.border,
                  },
                ]}
              >
                <ActivityIndicator size={16} color={theme.brand.primary} />
                <Text
                  variant="bodyMedium"
                  style={{ color: theme.text.secondary, fontWeight: '600' }}
                >
                  {vi.aiTyping}
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
                  {reply.replyText}
                </Text>
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
    [activeSessionId, getReplyForMessage, theme, triggerAIReply, typingForId],
  );

  return (
    <GestureHandlerRootView style={styles.fill}>
      <SafeAreaView edges={isModal ? [] : ['bottom']} style={styles.fill}>
        <Screen
          title={vi.chat}
          scroll={false}
          onBack={onClose ?? (() => router.navigate('/'))}
          hideHeader={isModal}
          inModal={isModal}
          headerRight={
            <View style={localStyles.headerActions}>
              <Pill
                label={vi.aiHistory}
                icon="history"
                tone="primary"
                size="sm"
                onPress={() => {
                  if (historyOpen) {
                    setHistoryOpen(false);
                    setOpenSwipeId(null);
                    openSwipeIdRef.current = null;
                    setSelecting(false);
                    setSelectedIds([]);
                  } else void openHistory();
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
          {isModal && (
            <View
              style={[
                localStyles.modalSubheader,
                { borderBottomColor: theme.card.border },
              ]}
            >
              <Pill
                label={historyOpen ? vi.back : vi.aiHistory}
                icon={historyOpen ? 'arrow-left' : 'history'}
                tone="primary"
                size="sm"
                onPress={() => {
                  if (historyOpen) {
                    setHistoryOpen(false);
                    setOpenSwipeId(null);
                    openSwipeIdRef.current = null;
                    setSelecting(false);
                    setSelectedIds([]);
                  } else void openHistory();
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
                  size={20}
                  accessibilityLabel={vi.aiNewChat}
                  onPress={startNewChat}
                />
              ) : null}
            </View>
          )}
          {loadError && (
            <View style={styles.subtlePanel}>
              <Text accessibilityRole="alert" style={{ color: palette.danger }}>
                {vi.chatLoadError}
              </Text>
              <Button
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
                      numberOfLines={2}
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
              </GlassCard>
            </ScrollView>
          ) : (
            /* SCREEN 3: CHAT AI (Conversation List + Inline Suggestion Chips) */
            <View style={{ flex: 1, minHeight: 0 }}>
              <View style={localStyles.topChipsBar}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={localStyles.topChipsScroll}
                >
                  {INTRO_SUGGESTION_CHIPS.map((chip) => (
                    <Pill
                      key={chip.id}
                      label={chip.label}
                      icon={chip.icon}
                      tone="glass"
                      size="sm"
                      onPress={() =>
                        void handleSuggestionChipPress(chip.prompt)
                      }
                    />
                  ))}
                </ScrollView>
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
                    parseAdviceQuery(messages[0].text, [], ADVICE_CLOCK)
                      .range !== null),
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
    alignItems: 'center',
    gap: 8,
  },
  modalSubheader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 6,
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
