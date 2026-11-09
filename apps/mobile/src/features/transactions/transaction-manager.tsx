import { MaterialCommunityIcons } from '@expo/vector-icons';
import { uuid } from 'expo';
import { useFocusEffect } from 'expo-router';
import { parseEntry, today, validateDate, type ParseResult } from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import type { TransactionInput, TransactionFilters } from '@pfm/contracts';
import { TransactionFilterForm } from './transaction-filters';
import { DEBT_KIND_LABELS } from '@/features/debts/labels';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import {
  BackHandler,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput as RNTextInput,
  View,
} from 'react-native';
import {
  ActivityIndicator,
  Button,
  Divider,
  HelperText,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import {
  EmptyStateCard,
  IconBadge,
  QuickTile,
  Screen,
  StatusPill,
  styles,
} from '@/components/screen';
import {
  AppleMenuPicker,
  DateField,
  GlassCard,
  MoneyInput,
  Pill,
} from '@/components/ui';
import {
  createSoftShadow,
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
  walletKindVisual,
} from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import type { Database } from '@/data/migrate';
import { listCategories, type CategoryRow } from '@/data/categories';
import { readQuickEntryContext, saveParsedEntries } from '@/data/quick-entry';
import { listWallets, type WalletRow } from '@/data/repository';
import { foldSearchText } from '@/data/search-text';
import {
  createTransaction,
  updateTransaction,
  deleteTransaction,
  undoDeleteTransaction,
  type TransactionRow,
} from '@/data/transactions';
import {
  listTransactionHistory,
  type TransactionHistoryRow,
} from '@/data/transaction-history';
import {
  confirmSelectedEntries,
  makeEntryDrafts,
  type EntryDraft,
} from '@/features/quick-entry/draft';
import { EntryConfirmation } from '@/features/quick-entry/confirmation';
import { useApp } from '@/state/app';
import { useTabBarScroll } from '@/hooks/use-tab-bar-scroll';
import {
  formatTransactionCurrencyAmount,
  usePreferences,
} from '@/state/preferences';
import { vi } from '@/messages/vi';
import { displayCategoryName, displayWalletName } from '@/messages/seed-labels';
import { logAppEvent } from '@/services/logger';
import { formatDisplayDate } from '@/utils/display';
import {
  formatAmountInput,
  parseAmountInput,
  manualOccurredAt,
  isFutureDate,
} from './form';

const KINDS = [
  { value: 'expense', label: vi.transactionExpense },
  { value: 'income', label: vi.transactionIncome },
  { value: 'transfer', label: vi.transactionTransfer },
] as const;

function formatEntryAmount(row: TransactionRow): string {
  const { currency, exchangeRate } = usePreferences.getState();
  return formatTransactionCurrencyAmount(row, currency, exchangeRate);
}

type Mode =
  | { type: 'list' }
  | { type: 'filters' }
  | { type: 'detail'; row: TransactionHistoryRow }
  | { type: 'form'; row: TransactionRow | null; id: string }
  | { type: 'delete'; row: TransactionRow };

/**
 * Transaction Manager handling list, instant search, filters, transaction detail view,
 * manual create/edit/delete, and natural language quick-entry with confirmation sheet.
 */
export function TransactionManager({
  onManageRecurring,
  onManageDebts,
}: {
  onManageRecurring(): void;
  onManageDebts(): void;
}) {
  const [rows, setRows] = useState<TransactionHistoryRow[]>([]);
  const [filters, setFilters] = useState<TransactionFilters>({});
  const [quickQuery, setQuickQuery] = useState('');
  const [quickKind, setQuickKind] = useState<string>('all');
  const filtersRef = useRef<TransactionFilters>({});
  const hasFilters = Object.values(filters).some(
    (value) => value !== undefined && value !== '',
  );
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [mode, setMode] = useState<Mode>({ type: 'list' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [undo, setUndo] = useState<TransactionRow | null>(null);
  const working = useRef(false);
  const focused = useRef(false);
  const hasLoadedOnce = useRef(false);
  const tabBarScroll = useTabBarScroll();
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const theme = useDesignTheme();
  const language = usePreferences((state) => state.language);
  const recurringVersion = useApp((state) => state.recurringVersion);
  const consumeAddTransaction = usePreferences(
    (state) => state.consumeAddTransaction,
  );
  const pendingTransactionEntry = usePreferences(
    (state) => state.pendingTransactionEntry,
  );

  const load = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    if (!hasLoadedOnce.current) {
      setLoading(true);
    }
    setError('');
    try {
      const data = await withDatabase(async (db) => ({
        rows: await listTransactionHistory(db, undefined, filtersRef.current),
        wallets: await listWallets(db, true),
        categories: await listCategories(db, true),
      }));
      hasLoadedOnce.current = true;
      logAppEvent('debug', {
        route: 'entry',
        status: 'ready',
        action: data.rows.some((row) => row.source === 'parsed')
          ? 'history_with_parsed'
          : 'history_without_parsed',
      });
      setRows(data.rows);
      setMore(data.rows.length === 50);
      setWallets(data.wallets);
      setCategories(data.categories);
      useApp.setState({ wallets: data.wallets.filter((w) => !w.is_archived) });
    } catch {
      setError(vi.transactionsLoadError);
    } finally {
      working.current = false;
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      const pendingEntry = consumeAddTransaction();
      if (pendingEntry) {
        usePreferences.getState().openAddTransaction(pendingEntry);
      }
      const frame = requestAnimationFrame(() => {
        void load();
      });
      return () => {
        cancelAnimationFrame(frame);
        focused.current = false;
        setUndo(null);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Automatic entries refresh this focused list.
    }, [
      load,
      recurringVersion,
      consumeAddTransaction,
      pendingTransactionEntry,
    ]),
  );

  useEffect(() => {
    if (!focused.current || pendingTransactionEntry === null) return;

    const frame = requestAnimationFrame(() => {
      const pendingEntry = consumeAddTransaction();
      if (!pendingEntry || !focused.current) return;
      usePreferences.getState().openAddTransaction(pendingEntry);
      setError('');
      setNotice('');
    });
    return () => cancelAnimationFrame(frame);
  }, [consumeAddTransaction, pendingTransactionEntry]);

  const back = useCallback(() => {
    if (!working.current) {
      setMode({ type: 'list' });
      setError('');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      const listener = BackHandler.addEventListener('hardwareBackPress', () => {
        if (mode.type === 'list') return false;
        back();
        return true;
      });
      return () => listener.remove();
    }, [mode.type, back]),
  );

  const mutate = async (
    action: (db: Database) => Promise<TransactionRow | void>,
    undoing = false,
  ) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    let committed = false;
    try {
      const data = await withDatabase(async (db) => {
        const deleted = await action(db);
        committed = true;
        setUndo(focused.current ? (deleted ?? null) : null);
        return {
          rows: await listTransactionHistory(db, undefined, filtersRef.current),
          wallets: await listWallets(db, true),
        };
      });
      setRows(data.rows);
      setMore(data.rows.length === 50);
      setWallets(data.wallets);
      useApp.setState((s) => ({
        wallets: data.wallets.filter((w) => !w.is_archived),
        recurringVersion: s.recurringVersion + 1,
      }));
      setMode({ type: 'list' });
      setNotice(vi.transactionSaved);
      void useApp.getState().refreshRecurring(true);
    } catch (failure) {
      if (committed) {
        setMode({ type: 'list' });
        setError(vi.walletSavedRefreshFailed);
      } else if (
        failure instanceof Error &&
        failure.message === 'TRANSACTION_CHANGED'
      )
        setError(vi.transactionChanged);
      else
        setError(
          failure instanceof Error && failure.message.startsWith('DEBT_')
            ? vi.debtInvalidBalance
            : undoing
              ? vi.transactionUndoFailed
              : failure instanceof Error &&
                  /^(WALLET_|CATEGORY_)/.test(failure.message)
                ? vi.transactionReferencesInvalid
                : vi.saveError,
        );
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const loadMore = async () => {
    if (working.current || !rows.length) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const page = await withDatabase((db) =>
        listTransactionHistory(db, rows.at(-1), filtersRef.current),
      );
      setRows((current) => [
        ...current,
        ...page.filter(
          (row) => !current.some((existing) => existing.id === row.id),
        ),
      ]);
      setMore(page.length === 50);
    } catch {
      setError(vi.transactionsLoadError);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const viewDetail = useCallback((row: TransactionHistoryRow) => {
    setMode({ type: 'detail', row });
    setError('');
    setNotice('');
  }, []);

  const edit = useCallback((row: TransactionRow) => {
    setMode({ type: 'form', row, id: row.id });
    setError('');
    setNotice('');
  }, []);

  const remove = useCallback((row: TransactionRow) => {
    setMode({ type: 'delete', row });
    setError('');
    setNotice('');
  }, []);

  const filteredRows = useMemo(() => {
    const normalizedQuery = foldSearchText(quickQuery.trim());
    return rows.filter((row) => {
      if (quickKind !== 'all' && row.kind !== quickKind) return false;
      if (!normalizedQuery) return true;
      const categoryName =
        categories.find((c) => c.id === row.category_id)?.name ?? '';
      const walletName =
        wallets.find((w) => w.id === row.wallet_id)?.name ?? '';
      const combined = foldSearchText(
        `${row.note ?? ''} ${categoryName} ${walletName} ${row.amount} ${row.occurred_on}`,
      );
      return combined.includes(normalizedQuery);
    });
  }, [rows, quickKind, quickQuery, categories, wallets]);

  const renderItem = useCallback(
    ({ item }: { item: TransactionHistoryRow }) => (
      <TransactionItem
        row={item}
        wallets={wallets}
        categories={categories}
        busy={busy || loading}
        onPress={viewDetail}
        onEdit={edit}
        onDelete={remove}
      />
    ),
    [wallets, categories, busy, loading, viewDetail, edit, remove],
  );

  if (mode.type === 'filters')
    return (
      <TransactionFilterForm
        filters={filters}
        wallets={wallets}
        categories={categories}
        busy={busy || loading}
        onBack={back}
        onApply={(next) => {
          filtersRef.current = next;
          setFilters(next);
          setMode({ type: 'list' });
          void load();
        }}
      />
    );

  if (mode.type === 'detail') {
    const detailRow = mode.row;
    const category = categories.find((c) => c.id === detailRow.category_id);
    const wallet = wallets.find((w) => w.id === detailRow.wallet_id);
    const toWallet = wallets.find((w) => w.id === detailRow.to_wallet_id);
    const isIncome = detailRow.kind === 'income';
    const isExpense = detailRow.kind === 'expense';
    const kindLabel =
      KINDS.find((k) => k.value === detailRow.kind)?.label ??
      DEBT_KIND_LABELS[detailRow.kind] ??
      detailRow.kind;

    return (
      <Screen title={vi.txDetailTitle} onBack={back} backDisabled={busy}>
        <GlassCard variant="elevated" radius="xl" padding={DesignSpacing.xl}>
          <View style={{ alignItems: 'center', gap: 10 }}>
            <Pill
              label={kindLabel}
              tone={isIncome ? 'income' : isExpense ? 'expense' : 'primary'}
              size="md"
            />
            <Text
              variant="headlineMedium"
              style={[
                styles.number,
                {
                  fontWeight: '800',
                  color: isIncome
                    ? theme.finance.incomeText
                    : isExpense
                      ? theme.finance.expenseText
                      : theme.text.primary,
                },
              ]}
            >
              {isExpense ? '−' : isIncome ? '+' : ''}
              {formatEntryAmount(detailRow)}
            </Text>
            {detailRow.original_currency === 'USD' && (
              <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
                {`${language === 'en' ? 'Original' : 'Gốc'}: $${((detailRow.original_amount_minor ?? 0) / 100).toFixed(2)} · ${language === 'en' ? 'Booked to wallet' : 'Đã ghi vào ví'}: ${detailRow.amount.toLocaleString('vi-VN')} ₫`}
              </Text>
            )}
            <Text variant="bodyMedium" style={{ color: theme.text.secondary }}>
              {formatDisplayDate(detailRow.occurred_on)}
            </Text>
          </View>

          <Divider
            style={{
              backgroundColor: theme.card.border,
              marginVertical: DesignSpacing.md,
            }}
          />

          <View style={{ gap: 12 }}>
            <View style={styles.row}>
              <Text style={{ color: theme.text.secondary }}>
                {vi.transactionWallet}
              </Text>
              <Text style={{ fontWeight: '700', color: theme.text.primary }}>
                {wallet?.name ?? ''}
                {toWallet ? ` → ${displayWalletName(toWallet.name)}` : ''}
              </Text>
            </View>

            {detailRow.kind !== 'transfer' && (
              <View style={styles.row}>
                <Text style={{ color: theme.text.secondary }}>
                  {vi.transactionCategory}
                </Text>
                <Text style={{ fontWeight: '700', color: theme.text.primary }}>
                  {category?.name ?? vi.transactionUncategorized}
                </Text>
              </View>
            )}

            {!!detailRow.note && (
              <View style={{ gap: 4 }}>
                <Text style={{ color: theme.text.secondary }}>
                  {vi.transactionNote}
                </Text>
                <Text style={{ fontWeight: '600', color: theme.text.primary }}>
                  {detailRow.note}
                </Text>
              </View>
            )}
          </View>
          <TransactionBalance row={detailRow} wallets={wallets} />
        </GlassCard>

        <View style={localStyles.detailActions}>
          <Button
            mode="contained"
            icon="pencil-outline"
            buttonColor={theme.brand.primaryStrong}
            textColor="#FFFFFF"
            contentStyle={styles.button}
            style={{ flex: 1 }}
            disabled={busy}
            onPress={() => edit(detailRow)}
          >
            {vi.editTransaction}
          </Button>
          <Button
            mode="outlined"
            icon="trash-can-outline"
            textColor={palette.danger}
            contentStyle={styles.button}
            style={{ flex: 1 }}
            disabled={busy}
            onPress={() => remove(detailRow)}
          >
            {vi.deleteTransaction}
          </Button>
        </View>
      </Screen>
    );
  }

  if (mode.type === 'form')
    return (
      <TransactionForm
        row={mode.row}
        wallets={wallets}
        categories={categories}
        busy={busy || loading}
        error={error}
        onBack={back}
        onNaturalSaved={async () => {
          setMode({ type: 'list' });
          setNotice(vi.quickSaved);
          useApp.setState((s) => ({
            recurringVersion: s.recurringVersion + 1,
          }));
          await load();
        }}
        onSave={(input) =>
          mutate((db) =>
            mode.row
              ? updateTransaction(
                  db,
                  mode.id,
                  input,
                  new Date().toISOString(),
                  mode.row.updated_at,
                )
              : createTransaction(db, mode.id, input, new Date().toISOString()),
          )
        }
      />
    );

  if (mode.type === 'delete')
    return (
      <Screen title={vi.deleteTransaction} onBack={back} backDisabled={busy}>
        <GlassCard variant="elevated" radius="lg" padding={DesignSpacing.lg}>
          <View style={styles.inlineRow}>
            <IconBadge
              icon="alert-circle-outline"
              bg={palette.dangerSoft}
              fg={palette.dangerInk}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="titleMedium" style={{ fontWeight: '700' }}>
                {formatEntryAmount(mode.row)} ·{' '}
                {formatDisplayDate(mode.row.occurred_on)}
              </Text>
              {!!mode.row.note && (
                <Text style={{ color: palette.textMuted }}>
                  {mode.row.note}
                </Text>
              )}
            </View>
          </View>
          <Text style={{ lineHeight: 21, marginTop: 8 }}>
            {vi.transactionDeleteConfirm}
          </Text>
        </GlassCard>
        {!!error && (
          <Text accessibilityRole="alert" style={{ color: colors.error }}>
            {error}
          </Text>
        )}
        <Button
          mode="contained"
          buttonColor={colors.error}
          icon="trash-can-outline"
          contentStyle={styles.button}
          disabled={busy}
          loading={busy}
          onPress={() => {
            void mutate((db) =>
              deleteTransaction(db, mode.row.id, mode.row.updated_at),
            );
          }}
        >
          {vi.deleteTransaction}
        </Button>
        <Button
          mode="outlined"
          contentStyle={styles.button}
          disabled={busy}
          onPress={back}
        >
          {vi.cancel}
        </Button>
      </Screen>
    );

  return (
    <Screen
      title={vi.transactions}
      scroll={false}
      headerRight={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={vi.addTransaction}
          hitSlop={6}
          onPress={() => usePreferences.getState().openAddTransaction()}
          style={({ pressed }) => [
            localStyles.headerAddBtn,
            createSoftShadow(theme.mode, 'sm'),
            {
              backgroundColor: pressed
                ? theme.brand.primarySoft
                : theme.card.surfaceElevated,
              borderColor: theme.card.border,
            },
          ]}
        >
          <MaterialCommunityIcons
            name="plus"
            size={20}
            color={theme.text.primary}
          />
        </Pressable>
      }
    >
      {/* Instant Search Input Bar */}
      <View
        style={[
          localStyles.searchBar,
          {
            backgroundColor: theme.card.surfaceElevated,
            borderColor: theme.card.border,
          },
        ]}
      >
        <MaterialCommunityIcons
          name="magnify"
          size={20}
          color={theme.text.muted}
        />
        <RNTextInput
          accessibilityLabel={vi.txSearchPlaceholder}
          placeholder={vi.txSearchPlaceholder}
          placeholderTextColor={theme.text.muted}
          value={quickQuery}
          onChangeText={setQuickQuery}
          style={[localStyles.searchInput, { color: theme.text.primary }]}
        />
        {!!quickQuery && (
          <Pressable
            accessibilityRole="button"
            onPress={() => setQuickQuery('')}
          >
            <MaterialCommunityIcons
              name="close-circle"
              size={18}
              color={theme.text.muted}
            />
          </Pressable>
        )}
      </View>

      {/* Kind Filter Pills + Add Transaction CTA */}
      <View style={localStyles.filterPillsRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          <Pill
            label={vi.txFilterAll}
            tone="primary"
            selected={quickKind === 'all'}
            size="sm"
            onPress={() => setQuickKind('all')}
          />
          <Pill
            label={vi.transactionExpense}
            tone="expense"
            selected={quickKind === 'expense'}
            size="sm"
            onPress={() => setQuickKind('expense')}
          />
          <Pill
            label={vi.transactionIncome}
            tone="income"
            selected={quickKind === 'income'}
            size="sm"
            onPress={() => setQuickKind('income')}
          />
          <Pill
            label={vi.transactionTransfer}
            tone="neutral"
            selected={quickKind === 'transfer'}
            size="sm"
            onPress={() => setQuickKind('transfer')}
          />
        </ScrollView>
      </View>

      {/* Quick Navigation Row for Advanced Filters, Recurring, Debts */}
      <View style={localStyles.quickRow}>
        <QuickTile
          icon="tune-variant"
          label={vi.filterAdvanced}
          bg={hasFilters ? palette.warningSoft : palette.primarySoft}
          fg={hasFilters ? palette.warningInk : palette.primaryInk}
          disabled={busy || loading}
          onPress={() => setMode({ type: 'filters' })}
        />
        <QuickTile
          icon="calendar-sync-outline"
          label={vi.recurringTitle}
          bg={palette.tealSoft}
          fg={palette.tealInk}
          disabled={busy || loading}
          onPress={onManageRecurring}
        />
        <QuickTile
          icon="handshake-outline"
          label={vi.debtsTitle}
          bg={palette.purpleSoft}
          fg={palette.purpleInk}
          disabled={busy || loading}
          onPress={onManageDebts}
        />
      </View>

      {hasFilters && (
        <StatusPill
          icon="filter-check-outline"
          label={vi.filterActive}
          bg={palette.warningSoft}
          fg={palette.warningInk}
        />
      )}

      {!loading && !wallets.some((w) => !w.is_archived) && (
        <Text style={{ color: palette.textMuted }}>{vi.noWallet}</Text>
      )}

      {!!notice && !undo && (
        <View
          style={[
            styles.subtlePanel,
            {
              backgroundColor: palette.incomeSoft,
              borderColor: palette.income,
            },
          ]}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: palette.incomeInk, fontWeight: '600' }}
          >
            {notice}
          </Text>
        </View>
      )}

      {undo && (
        <View
          style={[
            styles.subtlePanel,
            {
              backgroundColor: palette.warningSoft,
              borderColor: palette.warning,
            },
          ]}
        >
          <View style={styles.row}>
            <Text
              accessibilityLiveRegion="polite"
              variant="titleSmall"
              style={{ color: palette.warningInk, fontWeight: '700' }}
            >
              {vi.transactionDeleted}
            </Text>
            <Button
              compact
              mode="contained-tonal"
              disabled={busy || loading}
              onPress={() => {
                void mutate((db) => undoDeleteTransaction(db, undo), true);
              }}
            >
              {vi.transactionUndo}
            </Button>
          </View>
          <Text variant="bodySmall" style={{ color: palette.warningInk }}>
            {vi.transactionUndoDescription}
          </Text>
        </View>
      )}

      {!!error && (
        <View
          style={[
            styles.subtlePanel,
            {
              backgroundColor: palette.dangerSoft,
              borderColor: palette.danger,
            },
          ]}
        >
          <Text accessibilityRole="alert" style={{ color: colors.error }}>
            {error}
          </Text>
          <Button disabled={busy || loading} onPress={load}>
            {vi.retry}
          </Button>
        </View>
      )}

      {loading ? (
        <View style={{ paddingVertical: 28, alignItems: 'center' }}>
          <ActivityIndicator size="large" accessibilityLabel={vi.loading} />
        </View>
      ) : (
        <FlatList
          style={styles.fill}
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          onScroll={tabBarScroll.onScroll}
          scrollEventThrottle={tabBarScroll.scrollEventThrottle}
          data={filteredRows}
          keyExtractor={(row) => row.id}
          renderItem={renderItem}
          contentContainerStyle={{
            gap: 12,
            paddingBottom: DesignSpacing.bottomTabClearance,
          }}
          ListEmptyComponent={
            <EmptyStateCard
              icon="receipt-text-outline"
              message={
                hasFilters || quickQuery || quickKind !== 'all'
                  ? vi.filterEmpty
                  : vi.transactionsEmpty
              }
            />
          }
          ListFooterComponent={
            more ? (
              <Button
                mode="outlined"
                contentStyle={styles.button}
                disabled={busy}
                loading={busy}
                onPress={loadMore}
              >
                {vi.transactionMore}
              </Button>
            ) : undefined
          }
        />
      )}
    </Screen>
  );
}

// Wrap wallet names and values naturally on small screens and with larger text.
function TransactionBalance({
  row,
  wallets,
}: {
  row: TransactionHistoryRow;
  wallets: WalletRow[];
}) {
  const theme = useDesignTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text variant="labelSmall" style={{ color: theme.text.secondary }}>
        {vi.transactionBalanceAfter}
      </Text>
      <Text variant="bodySmall" style={{ color: theme.text.primary }}>
        {wallets.find((wallet) => wallet.id === row.wallet_id)?.name ?? '—'}:{' '}
        {formatVnd(row.wallet_balance_after)}
      </Text>
      {row.to_wallet_id && row.to_wallet_balance_after !== null && (
        <Text variant="bodySmall" style={{ color: theme.text.primary }}>
          {wallets.find((wallet) => wallet.id === row.to_wallet_id)?.name ??
            '—'}
          : {formatVnd(row.to_wallet_balance_after)}
        </Text>
      )}
    </View>
  );
}

const TransactionItem = memo(function TransactionItem({
  row,
  wallets,
  categories,
  busy,
  onPress,
  onEdit,
  onDelete,
}: {
  row: TransactionHistoryRow;
  wallets: WalletRow[];
  categories: CategoryRow[];
  busy: boolean;
  onPress(row: TransactionHistoryRow): void;
  onEdit(row: TransactionRow): void;
  onDelete(row: TransactionRow): void;
}) {
  const palette = useFinancePalette();
  const theme = useDesignTheme();
  const category = categories.find((c) => c.id === row.category_id);
  const parent = categories.find((c) => c.id === category?.parent_id);
  const isIncome = row.kind === 'income';
  const isExpense = row.kind === 'expense';
  const isTransfer = row.kind === 'transfer';

  const badgeBg = isIncome
    ? theme.finance.incomeSoft
    : isExpense
      ? theme.finance.expenseSoft
      : isTransfer
        ? palette.transferSoft
        : palette.purpleSoft;
  const badgeFg = isIncome
    ? theme.finance.incomeText
    : isExpense
      ? theme.finance.expenseText
      : isTransfer
        ? palette.transferInk
        : palette.purpleInk;
  const badgeIcon =
    category?.icon ??
    (isIncome
      ? 'arrow-bottom-left'
      : isExpense
        ? 'arrow-top-right'
        : isTransfer
          ? 'swap-horizontal'
          : 'handshake-outline');

  const kindTitle =
    KINDS.find((kind) => kind.value === row.kind)?.label ??
    DEBT_KIND_LABELS[row.kind] ??
    vi.transactionPendingKind;
  const categoryTitle =
    row.kind !== 'transfer' && !row.debt_id
      ? category
        ? `${parent ? `${displayCategoryName(parent.name)} › ` : ''}${displayCategoryName(category.name)}`
        : vi.transactionUncategorized
      : null;

  return (
    <GlassCard
      variant="elevated"
      radius="lg"
      padding={16}
      onPress={() => onPress(row)}
      style={{ gap: 10 }}
    >
      <View style={styles.row}>
        <View style={[styles.inlineRow, { flex: 1 }]}>
          <IconBadge
            icon={badgeIcon}
            bg={badgeBg}
            fg={category?.color ?? badgeFg}
            size={42}
            iconSize={20}
          />
          <View style={{ flex: 1, gap: 4 }}>
            <View style={[styles.inlineRow, { gap: 6 }]}>
              <Text
                variant="titleMedium"
                numberOfLines={1}
                style={{
                  fontWeight: '700',
                  color: theme.text.primary,
                  flexShrink: 1,
                }}
              >
                {categoryTitle ?? kindTitle}
              </Text>
              <Pill
                label={kindTitle}
                tone={isIncome ? 'income' : isExpense ? 'expense' : 'primary'}
                size="sm"
              />
            </View>
            <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
              {formatDisplayDate(row.occurred_on)} ·{' '}
              {displayWalletName(
                wallets.find((w) => w.id === row.wallet_id)?.name,
              )}
              {row.to_wallet_id
                ? ` → ${wallets.find((w) => w.id === row.to_wallet_id)?.name ?? ''}`
                : ''}
            </Text>
          </View>
        </View>
        <Text
          variant="titleMedium"
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.75}
          style={[
            styles.number,
            {
              fontWeight: '800',
              maxWidth: '44%',
              color: isIncome
                ? theme.finance.incomeText
                : isExpense
                  ? theme.finance.expenseText
                  : theme.text.primary,
            },
          ]}
        >
          {row.kind === 'expense' ? '−' : row.kind === 'income' ? '+' : ''}
          {formatEntryAmount(row)}
        </Text>
      </View>

      {!!row.note && (
        <Text variant="bodyMedium" style={{ color: theme.text.primary }}>
          {row.note}
        </Text>
      )}

      {!!row.recurring_rule_id && (
        <StatusPill
          icon="calendar-sync-outline"
          label={vi.recurringEntry}
          bg={palette.tealSoft}
          fg={palette.tealInk}
        />
      )}

      <TransactionBalance row={row} wallets={wallets} />

      <Divider style={{ backgroundColor: theme.card.border }} />

      <View style={[styles.row, { justifyContent: 'flex-end' }]}>
        <Button
          compact
          mode="contained-tonal"
          icon="pencil-outline"
          disabled={busy}
          onPress={() => onEdit(row)}
        >
          {vi.editTransaction}
        </Button>
        <Button
          compact
          mode="text"
          textColor={palette.danger}
          icon="trash-can-outline"
          disabled={busy}
          onPress={() => onDelete(row)}
        >
          {vi.deleteTransaction}
        </Button>
      </View>
    </GlassCard>
  );
});

interface Fields {
  kind: 'expense' | 'income' | 'transfer';
  amount: string;
  walletId: string;
  toWalletId: string;
  categoryId: string;
  date: string;
  note: string;
}

interface NaturalConfirmSession {
  result: ParseResult;
  drafts: EntryDraft[];
  context: Awaited<ReturnType<typeof readQuickEntryContext>>;
}

export function TransactionForm({
  row,
  wallets,
  categories,
  busy,
  error,
  onBack,
  onNaturalSaved,
  onSave,
  hideHeader = false,
}: {
  row: TransactionRow | null;
  wallets: WalletRow[];
  categories: CategoryRow[];
  busy: boolean;
  error: string;
  onBack(): void;
  onNaturalSaved?(): Promise<void>;
  onSave(input: TransactionInput): Promise<void>;
  hideHeader?: boolean;
}) {
  const selectedCurrency = usePreferences((state) => state.currency);
  const language = usePreferences((state) => state.language);
  const currentRate = usePreferences((state) => state.exchangeRate);
  const currency = row?.original_currency ?? selectedCurrency;
  const originalAmount = row?.original_amount_minor ?? row?.amount ?? 0;
  const [naturalText, setNaturalText] = useState('');
  const [naturalBusy, setNaturalBusy] = useState(false);
  const [naturalError, setNaturalError] = useState('');
  const [naturalSession, setNaturalSession] =
    useState<NaturalConfirmSession | null>(null);

  const {
    control,
    setValue,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<Fields>({
    defaultValues: {
      kind:
        row?.kind === 'income' || row?.kind === 'transfer'
          ? row.kind
          : 'expense',
      amount: row
        ? currency === 'USD'
          ? (originalAmount / 100).toFixed(2)
          : formatAmountInput(String(originalAmount))
        : '',
      walletId: row?.wallet_id ?? wallets.find((w) => !w.is_archived)?.id ?? '',
      toWalletId: row?.to_wallet_id ?? '',
      categoryId: row?.category_id ?? '',
      date:
        row?.occurred_on ??
        today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' }),
      note: row?.note ?? '',
    },
  });

  const kind = useWatch({ control, name: 'kind' });
  const walletId = useWatch({ control, name: 'walletId' });
  const date = useWatch({ control, name: 'date' });
  const disabled = busy || isSubmitting || naturalBusy;
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const theme = useDesignTheme();

  let future = false;
  try {
    future = isFutureDate(date, new Date());
  } catch {
    /* Partial dates are validated on save. */
  }

  const availableCategories = categories.filter(
    (c) =>
      c.kind === kind &&
      (!c.is_archived || (c.id === row?.category_id && kind === row.kind)),
  );

  const kindOptions = useMemo(
    () => [
      {
        value: 'expense',
        label: language === 'en' ? 'Expense' : vi.transactionExpense,
        icon: 'arrow-down-circle',
        iconBg: palette.expenseSoft,
        iconColor: palette.expenseInk,
      },
      {
        value: 'income',
        label: vi.transactionIncome,
        icon: 'arrow-up-circle',
        iconBg: palette.incomeSoft,
        iconColor: palette.incomeInk,
      },
      {
        value: 'transfer',
        label: vi.transactionTransfer,
        icon: 'swap-horizontal-circle',
        iconBg: palette.purpleSoft,
        iconColor: palette.purpleInk,
      },
    ],
    [palette, language],
  );

  const walletOptions = useMemo(
    () =>
      wallets
        .filter((w) => !w.is_archived || w.id === row?.wallet_id)
        .map((w) => {
          const visual = walletKindVisual(w.kind, palette);
          return {
            value: w.id,
            label: `${displayWalletName(w.name, language)}${w.is_archived ? ` · ${vi.transactionArchivedReference}` : ''}`,
            icon: visual.icon,
            iconBg: visual.bg,
            iconColor: visual.fg,
          };
        }),
    [wallets, row?.wallet_id, palette, language],
  );

  const toWalletOptions = useMemo(
    () =>
      wallets
        .filter(
          (w) =>
            w.id !== walletId && (!w.is_archived || w.id === row?.to_wallet_id),
        )
        .map((w) => {
          const visual = walletKindVisual(w.kind, palette);
          return {
            value: w.id,
            label: `${displayWalletName(w.name, language)}${w.is_archived ? ` · ${vi.transactionArchivedReference}` : ''}`,
            icon: visual.icon,
            iconBg: visual.bg,
            iconColor: visual.fg,
          };
        }),
    [wallets, walletId, row?.to_wallet_id, palette, language],
  );

  const categoryOptions = useMemo(
    () => [
      {
        value: '',
        label: vi.transactionUncategorized,
        icon: 'help-circle-outline',
        iconBg: palette.surfaceMuted,
        iconColor: palette.textMuted,
      },
      ...availableCategories.map((c) => {
        const isExpense = c.kind === 'expense';
        const parent = c.parent_id
          ? categories.find((p) => p.id === c.parent_id)
          : null;
        return {
          value: c.id,
          label: displayCategoryName(c.name, language),
          icon: c.icon || 'tag-outline',
          iconBg: isExpense ? palette.expenseSoft : palette.incomeSoft,
          iconColor:
            c.color || (isExpense ? palette.expenseInk : palette.incomeInk),
          subtitle: parent
            ? `${language === 'en' ? 'Under' : 'Thuộc'}: ${displayCategoryName(parent.name, language)}`
            : undefined,
        };
      }),
    ],
    [availableCategories, categories, palette, language],
  );

  const handleParseNatural = async () => {
    if (!naturalText.trim() || disabled) return;
    setNaturalBusy(true);
    setNaturalError('');
    try {
      const context = await withDatabase(readQuickEntryContext);
      const parsed = parseEntry(naturalText, {
        clock: { now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' },
        currency: usePreferences.getState().currency,
        ...context,
      });
      if (!parsed.candidates.length) {
        setNaturalError(vi.quickInvalid);
        return;
      }
      const drafts = makeEntryDrafts(
        parsed,
        context,
        uuid.v4,
        usePreferences.getState().currency,
      );
      setNaturalSession({ result: parsed, drafts, context });
    } catch {
      setNaturalError(vi.quickParseError);
    } finally {
      setNaturalBusy(false);
    }
  };

  const handleSaveNatural = async (drafts: EntryDraft[]) => {
    if (!naturalSession || naturalBusy) return;
    setNaturalBusy(true);
    setNaturalError('');
    try {
      const confirmed = confirmSelectedEntries(
        naturalSession.result,
        drafts,
        new Date(),
        usePreferences.getState().exchangeRate,
      );
      await withDatabase((db) =>
        saveParsedEntries(
          db,
          naturalSession.result.raw,
          confirmed,
          new Date().toISOString(),
          uuid.v4(),
        ),
      );
      setNaturalSession(null);
      setNaturalText('');
      await onNaturalSaved?.();
    } catch {
      setNaturalError(vi.quickInvalid);
    } finally {
      setNaturalBusy(false);
    }
  };

  return (
    <Screen
      title={row ? vi.editTransaction : vi.addTransaction}
      onBack={onBack}
      backDisabled={disabled}
      hideHeader={hideHeader}
      inModal={hideHeader}
    >
      {/* Natural Language Quick-Entry Card with Confirmation Sheet before saving */}
      {!row && (
        <GlassCard
          variant="elevated"
          radius="xl"
          padding={DesignSpacing.md}
          style={{ gap: 10 }}
        >
          <View style={styles.inlineRow}>
            <MaterialCommunityIcons
              name="lightning-bolt-circle"
              size={22}
              color={theme.brand.primary}
            />
            <Text
              variant="titleSmall"
              style={{ fontWeight: '700', color: theme.text.primary, flex: 1 }}
            >
              {vi.txNaturalTitle}
            </Text>
          </View>

          <TextInput
            mode="outlined"
            placeholder={vi.txNaturalHint}
            accessibilityLabel={vi.txNaturalTitle}
            value={naturalText}
            onChangeText={(value) => {
              setNaturalText(value);
              setNaturalError('');
            }}
            disabled={disabled}
          />

          <View style={localStyles.sampleRow}>
            <Pill
              label={
                language === 'en'
                  ? selectedCurrency === 'USD'
                    ? 'spent $10 on breakfast'
                    : 'spent 10000 VND on breakfast'
                  : 'ăn sáng 30k'
              }
              tone="primary"
              size="sm"
              onPress={() =>
                setNaturalText(
                  language === 'en'
                    ? selectedCurrency === 'USD'
                      ? 'spent $10 on breakfast'
                      : 'spent 10000 VND on breakfast'
                    : 'ăn sáng 30k',
                )
              }
            />
            <Pill
              label={
                language === 'en'
                  ? selectedCurrency === 'USD'
                    ? 'coffee $5 and lunch $12'
                    : 'coffee 5000 VND and lunch 12000 VND'
                  : 'cf 25k bánh 20k'
              }
              tone="glass"
              size="sm"
              onPress={() =>
                setNaturalText(
                  language === 'en'
                    ? selectedCurrency === 'USD'
                      ? 'coffee $5 and lunch $12'
                      : 'coffee 5000 VND and lunch 12000 VND'
                    : 'cf 25k bánh 20k',
                )
              }
            />
            <Pill
              label={
                language === 'en'
                  ? selectedCurrency === 'USD'
                    ? 'salary $500'
                    : 'salary 500000 VND'
                  : 'lương 15tr'
              }
              tone="income"
              size="sm"
              onPress={() =>
                setNaturalText(
                  language === 'en'
                    ? selectedCurrency === 'USD'
                      ? 'salary $500'
                      : 'salary 500000 VND'
                    : 'lương 15tr',
                )
              }
            />
          </View>

          {!!naturalError && (
            <Text accessibilityRole="alert" style={{ color: palette.danger }}>
              {naturalError}
            </Text>
          )}

          {!naturalSession ? (
            <Button
              mode="contained-tonal"
              icon="creation"
              disabled={disabled || !naturalText.trim()}
              loading={naturalBusy}
              onPress={() => void handleParseNatural()}
            >
              {vi.txNaturalParseBtn}
            </Button>
          ) : (
            <EntryConfirmation
              result={naturalSession.result}
              drafts={naturalSession.drafts}
              refs={naturalSession.context}
              busy={naturalBusy}
              error={naturalError}
              onSave={handleSaveNatural}
              onCancel={() => {
                setNaturalSession(null);
                setNaturalError('');
              }}
            />
          )}
        </GlassCard>
      )}

      {/* Manual Transaction Form */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.md}
        style={{ gap: 12 }}
      >
        {!row?.debt_id && (
          <>
            <Controller
              control={control}
              name="kind"
              render={({ field }) => (
                <AppleMenuPicker
                  label={vi.transactionKind}
                  value={field.value}
                  options={kindOptions}
                  disabled={disabled}
                  onSelect={(value) => {
                    field.onChange(value);
                    setValue('categoryId', '');
                    setValue('toWalletId', '');
                  }}
                />
              )}
            />
            <Divider style={{ backgroundColor: theme.card.border }} />
          </>
        )}

        <Controller
          control={control}
          name="amount"
          rules={{
            validate: (value) => {
              try {
                parseAmountInput(value, currency);
                return true;
              } catch {
                return vi.transactionAmountInvalid;
              }
            },
          }}
          render={({ field, fieldState }) => (
            <View>
              <MoneyInput
                currency={currency}
                label={`${vi.transactionAmount.replace(' (₫)', '')} (${currency})`}
                accessibilityLabel={`${vi.transactionAmount.replace(' (₫)', '')} (${currency})`}
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                disabled={disabled}
                error={!!fieldState.error}
                left={<TextInput.Icon icon="cash" />}
              />
              {!!fieldState.error && (
                <HelperText type="error">{fieldState.error.message}</HelperText>
              )}
            </View>
          )}
        />
        {currency === 'USD' && (
          <Text variant="bodySmall" style={{ color: theme.text.muted }}>
            {currentRate
              ? `1 USD ≈ ${formatVnd(Math.round(currentRate))} · ${usePreferences.getState().exchangeRateDate ?? ''}`
              : usePreferences.getState().language === 'en'
                ? 'USD/VND rate unavailable. Connect to the internet before saving.'
                : 'Chưa có tỷ giá USD/VND. Cần kết nối mạng trước khi lưu.'}
          </Text>
        )}
      </GlassCard>

      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.md}
        style={{ gap: 10 }}
      >
        <Controller
          control={control}
          name="walletId"
          rules={{ required: vi.transactionWalletRequired }}
          render={({ field, fieldState }) => (
            <View>
              <AppleMenuPicker
                label={
                  kind === 'transfer'
                    ? vi.transactionSourceWallet
                    : vi.transactionWallet
                }
                value={field.value}
                options={walletOptions}
                disabled={disabled}
                onSelect={(value) => {
                  field.onChange(value);
                  setValue('toWalletId', '');
                }}
              />
              {!!fieldState.error && (
                <HelperText type="error">{fieldState.error.message}</HelperText>
              )}
            </View>
          )}
        />
        {row?.debt_id ? (
          <StatusPill
            icon="handshake-outline"
            label={DEBT_KIND_LABELS[row.kind] ?? ''}
            bg={palette.purpleSoft}
            fg={palette.purpleInk}
          />
        ) : kind === 'transfer' ? (
          <>
            <Divider style={{ backgroundColor: theme.card.border }} />
            <Controller
              control={control}
              name="toWalletId"
              shouldUnregister
              rules={{
                validate: (value) =>
                  kind !== 'transfer' ||
                  (!!value && value !== walletId) ||
                  vi.transactionWalletRequired,
              }}
              render={({ field, fieldState }) => (
                <View>
                  <AppleMenuPicker
                    label={vi.transactionDestination}
                    value={field.value}
                    options={toWalletOptions}
                    disabled={disabled}
                    onSelect={field.onChange}
                  />
                  {!!fieldState.error && (
                    <HelperText type="error">
                      {fieldState.error.message}
                    </HelperText>
                  )}
                </View>
              )}
            />
          </>
        ) : (
          <>
            <Divider style={{ backgroundColor: theme.card.border }} />
            <Controller
              control={control}
              name="categoryId"
              render={({ field }) => (
                <AppleMenuPicker
                  label={vi.transactionCategory}
                  value={field.value}
                  options={categoryOptions}
                  disabled={disabled}
                  onSelect={field.onChange}
                />
              )}
            />
          </>
        )}
      </GlassCard>

      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.md}
        style={{ gap: 12 }}
      >
        <Controller
          control={control}
          name="date"
          rules={{
            validate: (value) => {
              try {
                validateDate(value);
                return true;
              } catch {
                return vi.transactionDateInvalid;
              }
            },
          }}
          render={({ field, fieldState }) => (
            <DateField
              label={vi.transactionDate}
              value={field.value}
              onChange={field.onChange}
              disabled={disabled}
              error={!!fieldState.error}
              helperText={fieldState.error?.message}
            />
          )}
        />
        {future && (
          <View
            style={[
              styles.subtlePanel,
              {
                backgroundColor: palette.warningSoft,
                borderColor: palette.warning,
              },
            ]}
          >
            <Text
              accessibilityRole="alert"
              style={{ color: palette.warningInk }}
            >
              {vi.transactionFutureWarning}
            </Text>
          </View>
        )}
        <Controller
          control={control}
          name="note"
          render={({ field }) => (
            <TextInput
              mode="outlined"
              label={vi.transactionNote}
              accessibilityLabel={vi.transactionNote}
              multiline
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              disabled={disabled}
              left={<TextInput.Icon icon="note-text-outline" />}
            />
          )}
        />
      </GlassCard>

      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}
      <Button
        mode="contained"
        icon="check"
        buttonColor={theme.brand.primaryStrong}
        textColor="#FFFFFF"
        contentStyle={styles.button}
        disabled={
          disabled || (currency === 'USD' && !currentRate && !row?.booking_rate)
        }
        loading={disabled}
        onPress={() => {
          void handleSubmit((values) =>
            onSave({
              kind: row?.debt_id ? row.kind : values.kind,
              debtId: row?.debt_id ?? null,
              amount: parseAmountInput(values.amount, currency),
              currency,
              vndPerUsd:
                currency === 'USD'
                  ? row?.original_currency === 'USD' &&
                    parseAmountInput(values.amount, currency) === originalAmount
                    ? row.booking_rate
                    : currentRate
                  : null,
              walletId: values.walletId,
              toWalletId: values.kind === 'transfer' ? values.toWalletId : null,
              categoryId:
                row?.debt_id || values.kind === 'transfer'
                  ? null
                  : values.categoryId || null,
              occurredOn: values.date,
              occurredAt:
                row && values.date === row.occurred_on
                  ? row.occurred_at
                  : manualOccurredAt(values.date, new Date()),
              note: values.note,
            }),
          )();
        }}
      >
        {vi.saveTransaction}
      </Button>
    </Screen>
  );
}

const localStyles = StyleSheet.create({
  headerAddBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 2,
  },
  filterPillsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  quickRow: {
    flexDirection: 'row',
    gap: 10,
  },
  detailActions: {
    flexDirection: 'row',
    gap: 12,
  },
  sampleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
});
