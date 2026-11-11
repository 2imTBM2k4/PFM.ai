import { MaterialCommunityIcons } from '@expo/vector-icons';
import { uuid } from 'expo';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput as RNTextInput,
  View,
} from 'react-native';
import { ActivityIndicator, Button, Text } from 'react-native-paper';
import { type ParseResult } from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import { styles } from '@/components/screen';
import { Pill } from '@/components/ui/pill';
import {
  createSoftShadow,
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import {
  readQuickEntryContext,
  saveParsedEntries,
  undoParsedEntries,
  type ParsedEntryReceipt,
} from '@/data/quick-entry';
import { saveChatMessage, type ChatRow } from '@/data/repository';
import { listTransactions } from '@/data/transactions';
import { checkBudgetAlerts } from '@/features/budgets/mobile';
import { vi } from '@/messages/vi';
import { getProxyBaseUrl } from '@/services/ai-service';
import { getOrCreateDeviceId } from '@/services/device-id';
import { logAppEvent } from '@/services/logger';
import { scanReceipt } from '@/services/receipt-service';
import { useApp } from '@/state/app';
import { usePreferences } from '@/state/preferences';
import {
  makeEntryDrafts,
  confirmSelectedEntries,
  type EntryDraft,
} from '../quick-entry/draft';
import { EntryConfirmation, entryKindLabel } from '../quick-entry/confirmation';
import {
  hasReceiptConsent,
  saveReceiptConsent,
} from '../quick-entry/receipt-consent';
import { receiptToParseResult } from '../quick-entry/receipt';
import { routeChatInput } from './intent';
import { publishChatCommit } from './commit';

type Context = Awaited<ReturnType<typeof readQuickEntryContext>>;
interface Session {
  result: ParseResult;
  drafts: EntryDraft[];
  messageId: string;
  chatSessionId: string;
}

/**
 * Modern AI & Quick-Entry Chat Composer with '+', image, mic, and purple circular send buttons.
 * Routes transaction phrases through EntryConfirmation and advice questions through AIService.
 */
export function ChatComposer({
  disabled,
  chatSessionId,
  adviceFollowup,
  onMessage,
  onMessageRemoved,
  onAdviceSent,
}: {
  disabled: boolean;
  chatSessionId: string;
  adviceFollowup?: boolean;
  onMessage(message: ChatRow, sessionId: string): void;
  onMessageRemoved(id: string, sessionId: string): void;
  onAdviceSent?(message: ChatRow, sessionId: string): void;
}) {
  const [text, setText] = useState('');
  const [context, setContext] = useState<Context | null>(null);
  const [preview, setPreview] = useState<ReturnType<
    typeof routeChatInput
  > | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [receipt, setReceipt] = useState<ParsedEntryReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [chosenRoute, setChosenRoute] = useState<'advice' | null>(null);
  const [showQuickBar, setShowQuickBar] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const focused = useRef(false);
  const working = useRef(false);
  const request = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      logAppEvent('debug', {
        route: 'entry',
        status: 'ready',
        action: 'screen_unmounted',
      });
    };
  }, []);

  const palette = useFinancePalette();
  const theme = useDesignTheme();
  const selectedCurrency = usePreferences((state) => state.currency);
  const language = usePreferences((state) => state.language);
  const pendingChatAction = usePreferences((state) => state.pendingChatAction);
  const consumeChatAction = usePreferences((state) => state.consumeChatAction);
  const pendingReceiptAsset = usePreferences(
    (state) => state.pendingReceiptAsset,
  );
  const consumeReceiptAsset = usePreferences(
    (state) => state.consumeReceiptAsset,
  );
  const quickSample =
    language === 'en'
      ? selectedCurrency === 'USD'
        ? 'spent $10 on breakfast'
        : 'spent 10000 VND on breakfast'
      : vi.aiQuickMorningSample;
  const router = useRouter();

  const load = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const next = await withDatabase(readQuickEntryContext);
      if (!focused.current || current !== request.current) return;
      setContext(next);
      setPreview(null);
      setError('');
      useApp.setState({ wallets: next.wallets });
    } catch {
      if (focused.current && current === request.current)
        setError(vi.quickLoadError);
    } finally {
      if (focused.current && current === request.current) setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void load();
      return () => {
        focused.current = false;
        logAppEvent('debug', {
          route: 'entry',
          status: 'ready',
          action: 'screen_blurred',
        });
        request.current++;
        setSession(null);
        setReceipt(null);
        setChoosing(false);
      };
    }, [load]),
  );

  useEffect(() => {
    if (!context || !text.trim() || chosenRoute === 'advice') return;
    const timer = setTimeout(() => {
      try {
        const start = performance.now();
        const result = routeChatInput(
          text,
          {
            clock: { now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' },
            currency: usePreferences.getState().currency,
            ...context,
          },
          adviceFollowup,
        );
        logAppEvent('debug', {
          route: 'entry',
          status: 'ready',
          latency: Math.max(0, Math.round(performance.now() - start)),
        });
        setPreview(result);
      } catch {
        setError(vi.quickParseError);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [context, text, chosenRoute, adviceFollowup]);

  const clearInput = () => {
    setText('');
    setPreview(null);
    setChoosing(false);
    setChosenRoute(null);
    setShowQuickBar(false);
  };

  const openTransaction = () => {
    if (
      working.current ||
      disabled ||
      !preview ||
      preview.parsed.raw !== text ||
      !context
    )
      return;
    if (!context.wallets.length) {
      setError(vi.transactionWalletRequired);
      return;
    }
    setError('');
    logAppEvent('debug', {
      route: 'entry',
      status: 'ready',
      action: 'confirm_open',
    });
    setSession({
      result: preview.parsed,
      drafts: makeEntryDrafts(
        preview.parsed,
        context,
        uuid.v4,
        usePreferences.getState().currency,
      ),
      messageId: uuid.v4(),
      chatSessionId,
    });
  };

  const sendAdvice = async () => {
    if (working.current || disabled || !text.trim()) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const message = {
        id: uuid.v4(),
        text: text.trim(),
        created_at: new Date().toISOString(),
      };
      await withDatabase((db) =>
        saveChatMessage(
          db,
          message.id,
          message.text,
          message.created_at,
          chatSessionId,
        ),
      );
      await publishChatCommit(
        { mounted: mounted.current, focused: focused.current },
        () => {
          onMessage(message, chatSessionId);
          onAdviceSent?.(message, chatSessionId);
          clearInput();
          setNotice('');
        },
      );
    } catch {
      if (mounted.current) setError(vi.saveError);
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const save = async (drafts: EntryDraft[]) => {
    if (working.current || !session) return;
    logAppEvent('debug', {
      route: 'entry',
      status: 'loading',
      action: 'save_started',
    });
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    let committed = false;
    let validated = false;
    try {
      const confirmed = confirmSelectedEntries(
        session.result,
        drafts,
        new Date(),
        usePreferences.getState().exchangeRate,
      );
      validated = true;
      const saved = await withDatabase((db) =>
        saveParsedEntries(
          db,
          session.result.raw,
          confirmed,
          new Date().toISOString(),
          session.messageId,
          session.chatSessionId,
        ),
      );
      committed = true;
      logAppEvent('debug', {
        route: 'entry',
        status: 'ready',
        action: 'save_committed',
      });
      await publishChatCommit(
        { mounted: mounted.current, focused: focused.current },
        () => {
          setReceipt(focused.current ? saved : null);
          setSession(null);
          clearInput();
          setNotice(vi.quickSaved);
          if (saved.chatMessage)
            onMessage(saved.chatMessage, session.chatSessionId);
          logAppEvent('debug', {
            route: 'entry',
            status: 'ready',
            action: 'save_published',
          });
        },
        load,
      );
      if (__DEV__) {
        const page = await withDatabase((db) => listTransactions(db));
        logAppEvent('debug', {
          route: 'entry',
          status: 'ready',
          action: saved.transactions.every((entry) =>
            page.some((row) => row.id === entry.id),
          )
            ? 'save_in_history_page'
            : 'save_outside_history_page',
        });
      }
      if (!mounted.current)
        logAppEvent('debug', {
          route: 'entry',
          status: 'ready',
          action: 'save_publication_skipped',
        });
      useApp.setState((s) => ({ recurringVersion: s.recurringVersion + 1 }));
      void checkBudgetAlerts();
      void useApp.getState().refreshRecurring(true);
    } catch (failure) {
      logAppEvent('error', {
        route: 'entry',
        status: 'failed',
        action: 'save_failed',
      });
      if (!mounted.current) return;
      if (committed) setError(vi.quickRefreshError);
      else {
        const code = failure instanceof Error ? failure.message : '';
        const messages: Record<string, string> = {
          ENTRY_KIND: vi.quickKindRequired,
          ENTRY_AMOUNT_CONFIRMATION: vi.quickAmountRequired,
          ENTRY_SELECTION: vi.quickSelectRequired,
          ENTRY_COUNTERPARTY: vi.quickCounterpartyRequired,
          ENTRY_DEBT_REQUIRED: vi.quickDebtRequired,
          TRANSACTION_AMOUNT: vi.transactionAmountInvalid,
        };
        setError(
          messages[code] ??
            (code.startsWith('DEBT_')
              ? vi.debtInvalidBalance
              : /^(WALLET_|CATEGORY_)/.test(code)
                ? vi.transactionReferencesInvalid
                : validated
                  ? vi.saveError
                  : vi.quickInvalid),
        );
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const undo = async () => {
    if (working.current || !receipt) return;
    working.current = true;
    setBusy(true);
    setError('');
    let committed = false;
    try {
      await withDatabase((db) => undoParsedEntries(db, receipt));
      committed = true;
      await publishChatCommit(
        { mounted: mounted.current, focused: focused.current },
        () => {
          if (receipt.chatMessage)
            onMessageRemoved(receipt.chatMessage.id, chatSessionId);
          setReceipt(null);
          setNotice(vi.quickUndone);
        },
        load,
      );
      useApp.setState((s) => ({ recurringVersion: s.recurringVersion + 1 }));
      void checkBudgetAlerts();
      void useApp.getState().refreshRecurring(true);
    } catch {
      if (mounted.current)
        setError(committed ? vi.quickRefreshError : vi.quickUndoFailed);
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const fillQuickSample = (sample: string) => {
    setText(sample);
    setPreview(null);
    setChoosing(false);
    setError('');
    setShowQuickBar(false);
  };

  const processReceiptAsset = async (asset: {
    uri: string;
    width?: number;
    height?: number;
  }) => {
    if (working.current || disabled || !context || !mounted.current) return;
    if (!context.wallets.length) {
      setError(vi.transactionWalletRequired);
      return;
    }
    working.current = true;
    setBusy(true);
    setError('');
    let processedImageUri: string | null = null;
    try {
      const hasConsent = await withDatabase(hasReceiptConsent);
      if (!mounted.current) return;
      if (!hasConsent) {
        const agreed = await new Promise<boolean>((resolve) =>
          Alert.alert(
            vi.receiptConsentTitle,
            vi.receiptConsentBody,
            [
              {
                text: vi.cancel,
                style: 'cancel',
                onPress: () => resolve(false),
              },
              { text: vi.receiptConsentAgree, onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          ),
        );
        if (!agreed || !mounted.current) return;
        await withDatabase((db) =>
          saveReceiptConsent(db, new Date().toISOString()),
        );
      }
      const assetWidth = asset.width ?? 1200;
      const assetHeight = asset.height ?? 1600;
      const resize =
        assetWidth >= assetHeight
          ? { width: Math.min(assetWidth, 1600) }
          : { height: Math.min(assetHeight, 1600) };
      const image = await ImageManipulator.manipulateAsync(
        asset.uri,
        [{ resize }],
        {
          format: ImageManipulator.SaveFormat.JPEG,
          compress: 0.75,
          base64: true,
        },
      );
      processedImageUri = image.uri;
      if (
        !image.base64 ||
        Math.floor((image.base64.length * 3) / 4) > 2 * 1024 * 1024
      )
        throw new Error(vi.receiptTooLarge);
      if (!mounted.current) return;
      const deviceId = await getOrCreateDeviceId();
      if (!mounted.current) return;
      const result = await scanReceipt(
        image.base64,
        getProxyBaseUrl(),
        deviceId,
      );
      if (!mounted.current) return;
      const parsed = receiptToParseResult(result.receipt);
      setShowQuickBar(false);
      setSession({
        result: parsed,
        drafts: makeEntryDrafts(
          parsed,
          context,
          uuid.v4,
          usePreferences.getState().currency,
        ),
        messageId: uuid.v4(),
        chatSessionId,
      });
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error && failure.message.length <= 200
            ? failure.message
            : vi.receiptScanFailed,
        );
    } finally {
      if (processedImageUri)
        await FileSystem.deleteAsync(processedImageUri, {
          idempotent: true,
        }).catch(() => {});
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const captureReceipt = async (source: 'camera' | 'library') => {
    if (working.current || disabled || !context || !mounted.current) return;
    if (!context.wallets.length) {
      setError(vi.transactionWalletRequired);
      return;
    }
    try {
      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) throw new Error(vi.receiptCameraDenied);
      } else {
        const permission =
          await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) throw new Error(vi.receiptCameraDenied);
      }
      const selected =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'] })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              allowsMultipleSelection: false,
            });
      if (selected.canceled || !mounted.current || !selected.assets?.[0])
        return;
      await processReceiptAsset(selected.assets[0]);
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error && failure.message.length <= 200
            ? failure.message
            : vi.receiptScanFailed,
        );
    }
  };

  useEffect(() => {
    if (
      !pendingReceiptAsset ||
      loading ||
      disabled ||
      !context ||
      !mounted.current
    )
      return;

    const frame = requestAnimationFrame(() => {
      const asset = consumeReceiptAsset();
      if (asset) {
        void processReceiptAsset(asset);
      }
    });
    return () => cancelAnimationFrame(frame);
    // processReceiptAsset intentionally runs once for the consumed navigation receipt asset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consumeReceiptAsset, context, disabled, loading, pendingReceiptAsset]);

  useEffect(() => {
    if (
      !pendingChatAction ||
      loading ||
      disabled ||
      !context ||
      !mounted.current
    )
      return;

    const frame = requestAnimationFrame(() => {
      const action = consumeChatAction();
      if (action === 'camera' || action === 'library') {
        void captureReceipt(action);
      } else if (action === 'prompt') {
        Alert.alert(vi.receiptScan, vi.receiptChooseSource, [
          { text: vi.cancel, style: 'cancel' },
          {
            text: vi.receiptTakePhoto,
            onPress: () => void captureReceipt('camera'),
          },
          {
            text: vi.receiptChoosePhoto,
            onPress: () => void captureReceipt('library'),
          },
        ]);
      }
    });
    return () => cancelAnimationFrame(frame);
    // captureReceipt intentionally runs once for the consumed navigation action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consumeChatAction, context, disabled, loading, pendingChatAction]);

  const ready =
    !busy &&
    !loading &&
    !disabled &&
    (chosenRoute === 'advice'
      ? !!text.trim()
      : preview !== null && preview.parsed.raw === text);
  const first = preview?.parsed.candidates[0];

  const handleSendPress = () => {
    if (!ready) return;
    if (chosenRoute === 'advice') void sendAdvice();
    else if (preview?.route === 'transaction') openTransaction();
    else if (
      preview?.route === 'advice' ||
      preview?.route === 'restricted' ||
      preview?.route === 'out_of_scope' ||
      preview?.route === 'ambiguous'
    ) {
      void sendAdvice();
    }
  };

  return (
    <ScrollView
      style={{ flexGrow: 0, flexShrink: 1, maxHeight: '68%' }}
      contentContainerStyle={[
        composerStyles.wrapper,
        {
          backgroundColor: theme.chat.inputSurface,
          borderColor: theme.chat.inputBorder,
        },
        createSoftShadow(theme.mode, 'md'),
      ]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentInsetAdjustmentBehavior="never"
    >
      {/* Expandable '+' quick actions bar */}
      {showQuickBar && (
        <View style={composerStyles.quickActionsRow}>
          <Pill
            label={vi.receiptScan}
            icon="camera-outline"
            tone="primary"
            size="sm"
            onPress={() =>
              Alert.alert(vi.receiptScan, vi.receiptChooseSource, [
                { text: vi.cancel, style: 'cancel' },
                {
                  text: vi.receiptTakePhoto,
                  onPress: () => void captureReceipt('camera'),
                },
                {
                  text: vi.receiptChoosePhoto,
                  onPress: () => void captureReceipt('library'),
                },
              ])
            }
          />
          <Pill
            label={quickSample}
            icon="lightning-bolt-outline"
            tone="primary"
            size="sm"
            onPress={() => fillQuickSample(quickSample)}
          />
          <Pill
            label={vi.aiChipBudgetPlanner}
            icon="chart-pie"
            tone="glass"
            size="sm"
            onPress={() => fillQuickSample(vi.aiChipBudgetPlanner)}
          />
          <Pill
            label={vi.aiChipSpendingInsights}
            icon="trending-up"
            tone="glass"
            size="sm"
            onPress={() => fillQuickSample(vi.aiChipSpendingInsights)}
          />
        </View>
      )}

      {/* Route Preview Badge + Switch Route Action */}
      {chosenRoute === 'advice' ? (
        <Text variant="labelMedium" style={{ color: theme.brand.primaryText }}>
          {vi.chatRouteAdvice}
        </Text>
      ) : (
        preview &&
        preview.parsed.raw === text && (
          <View style={composerStyles.previewBar}>
            <View style={composerStyles.previewLeft}>
              <MaterialCommunityIcons
                name={
                  preview.route === 'advice'
                    ? 'creation'
                    : preview.route === 'transaction'
                      ? 'receipt-text-check-outline'
                      : preview.route === 'restricted'
                        ? 'shield-alert-outline'
                        : preview.route === 'out_of_scope'
                          ? 'close-circle-outline'
                          : 'help-circle-outline'
                }
                size={15}
                color={
                  preview.route === 'out_of_scope'
                    ? palette.danger
                    : preview.route === 'restricted'
                      ? palette.warning
                      : theme.brand.primary
                }
              />
              <Text
                variant="labelMedium"
                accessibilityLiveRegion="polite"
                numberOfLines={1}
                style={{
                  color:
                    preview.route === 'out_of_scope'
                      ? palette.danger
                      : preview.route === 'restricted'
                        ? palette.warning
                        : theme.text.secondary,
                  fontWeight: '600',
                  flexShrink: 1,
                }}
              >
                {preview.route === 'advice'
                  ? vi.chatRouteAdvice
                  : preview.route === 'restricted'
                    ? vi.chatRouteRestricted
                    : preview.route === 'out_of_scope'
                      ? vi.chatRouteOutOfScope
                      : preview.route === 'ambiguous'
                        ? vi.chatRouteAmbiguous
                        : preview.parsed.candidates.length > 1
                          ? `${preview.parsed.candidates.length} ${vi.chatRouteMultiple}`
                          : `${vi.chatRouteTransaction} · ${first ? entryKindLabel(first.kind) : ''}${first?.amount.value !== null && first?.amount.value !== undefined ? ` · ${first.amount.currency === 'USD' ? `$${(first.amount.value / 100).toFixed(2)}` : formatVnd(first.amount.value)}` : ''}`}
              </Text>
            </View>
            {ready &&
              !choosing &&
              preview.route !== 'restricted' &&
              preview.route !== 'out_of_scope' &&
              preview.route !== 'ambiguous' && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setChoosing(true)}
                >
                  <Text
                    variant="labelSmall"
                    style={{
                      color: theme.brand.primaryText,
                      fontWeight: '700',
                    }}
                  >
                    {vi.chatChangeRoute}
                  </Text>
                </Pressable>
              )}
          </View>
        )
      )}

      {/* Main Input Bar matching reference design: (+), TextInput, (image), (mic), (purple send) */}
      <View
        style={[
          composerStyles.inputPillRow,
          {
            backgroundColor: theme.card.surface,
            borderColor: theme.card.border,
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={vi.aiQuickAttach}
          onPress={() => setShowQuickBar((prev) => !prev)}
          style={[
            composerStyles.iconCircle,
            { backgroundColor: theme.brand.primarySoft },
          ]}
        >
          <MaterialCommunityIcons
            name={showQuickBar ? 'close' : 'plus'}
            size={20}
            color={theme.brand.primaryText}
          />
        </Pressable>

        <RNTextInput
          accessibilityLabel={vi.chatInput}
          placeholder={vi.chatInputHint}
          placeholderTextColor={theme.text.muted}
          multiline
          maxLength={500}
          editable={!busy}
          value={text}
          onChangeText={(value) => {
            setText(value);
            setPreview(null);
            setChoosing(false);
            setError('');
          }}
          style={[composerStyles.nativeInput, { color: theme.text.primary }]}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={vi.send}
          disabled={!ready}
          onPress={handleSendPress}
          style={[
            composerStyles.sendCircle,
            {
              backgroundColor: ready
                ? theme.brand.primaryStrong
                : theme.brand.primarySoft,
              opacity: ready ? 1 : 0.6,
            },
          ]}
        >
          {busy || loading ? (
            <ActivityIndicator
              size={16}
              color={ready ? '#FFFFFF' : theme.brand.primaryText}
              accessibilityLabel={vi.loading}
            />
          ) : (
            <MaterialCommunityIcons
              name="arrow-up"
              size={20}
              color={ready ? '#FFFFFF' : theme.brand.primaryText}
            />
          )}
        </Pressable>
      </View>

      {choosing && (
        <View style={composerStyles.chooseBox}>
          <Text variant="labelMedium" style={{ color: theme.text.secondary }}>
            {vi.chatChooseRoute}
          </Text>
          <View style={composerStyles.chooseButtons}>
            <Button
              mode="outlined"
              compact
              disabled={!ready}
              onPress={openTransaction}
            >
              {vi.chatChooseTransaction}
            </Button>
            <Button
              mode="contained"
              compact
              buttonColor={theme.brand.primaryStrong}
              textColor="#FFFFFF"
              disabled={!ready}
              onPress={() => {
                setChosenRoute('advice');
                setPreview(null);
                setChoosing(false);
                void sendAdvice();
              }}
            >
              {vi.chatChooseAdvice}
            </Button>
          </View>
        </View>
      )}

      {!!error && (
        <View style={styles.row}>
          <Text
            accessibilityRole="alert"
            variant="bodySmall"
            style={{ color: palette.danger, flex: 1 }}
          >
            {error}
          </Text>
          <Button compact disabled={busy} onPress={() => void load()}>
            {vi.retry}
          </Button>
        </View>
      )}

      {!!notice && (
        <Text
          accessibilityLiveRegion="polite"
          variant="bodySmall"
          style={{ color: palette.incomeInk, fontWeight: '600' }}
        >
          {notice}
        </Text>
      )}

      {context && !context.wallets.length && (
        <Button compact onPress={() => router.navigate('/')}>
          {vi.manageWallets}
        </Button>
      )}

      {receipt && (
        <Button
          mode="outlined"
          compact
          disabled={busy}
          onPress={() => void undo()}
        >
          {vi.quickUndo}
        </Button>
      )}

      {session && context && (
        <EntryConfirmation
          key={session.messageId}
          result={session.result}
          drafts={session.drafts}
          refs={context}
          busy={busy}
          error={error}
          onSave={save}
          onCancel={() => {
            if (!working.current) {
              logAppEvent('debug', {
                route: 'entry',
                status: 'ready',
                action: 'confirm_cancelled',
              });
              setSession(null);
              setError('');
              void load();
            }
          }}
        />
      )}
    </ScrollView>
  );
}

const composerStyles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: DesignSpacing.sm,
    paddingVertical: DesignSpacing.xs + 2,
    borderRadius: DesignRadius.xl,
    borderWidth: 1,
    gap: 8,
  },
  quickActionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  previewBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 8,
  },
  previewLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  inputPillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 5,
    gap: 4,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nativeInput: {
    flex: 1,
    minHeight: 36,
    maxHeight: 96,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 15,
    lineHeight: 20,
  },
  inlineToolButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chooseBox: {
    gap: 6,
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  chooseButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
});
