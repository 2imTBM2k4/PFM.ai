import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  PixelRatio,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  ActivityIndicator,
  Button,
  Divider,
  Text,
  useTheme,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { daysInMonth } from '@pfm/domain';
import MaterialCommunityIcons from '@/components/platform-icon';
import { IconBadge, Screen, styles } from '@/components/screen';
import { AppleMenuPicker, GlassCard, Pill } from '@/components/ui';
import { useResponsiveLayout } from '@/constants/responsive-layout';
import {
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import {
  listCategories,
  orderCategoriesByParent,
  type CategoryRow,
} from '@/data/categories';
import { withDatabase } from '@/data/connection';
import { listWallets, type WalletRow } from '@/data/repository';
import {
  isCashFlowKind,
  isDebtTransactionKind,
  readCalendarDayTransactions,
  readCalendarMonthData,
  type CalendarDayDetails,
  type CalendarKindFilter,
  type CalendarMonthData,
  type CalendarMonthFilter,
} from '@/data/stats';
import {
  deleteTransaction,
  updateTransaction,
  type TransactionRow,
} from '@/data/transactions';
import { checkBudgetAlerts } from '@/features/budgets/mobile';
import { TransactionForm } from '@/features/transactions/transaction-manager';
import { useAccessibilityPreferences } from '@/hooks/use-accessibility-preferences';
import { useCurrentDate } from '@/hooks/use-current-date';
import { useTabBarScroll } from '@/hooks/use-tab-bar-scroll';
import { displayCategoryName, displayWalletName } from '@/messages/seed-labels';
import { vi } from '@/messages/vi';
import { useApp } from '@/state/app';
import {
  formatCurrencyAmount,
  usePreferences,
} from '@/state/preferences';
import {
  calendarDays,
  calendarMonthFromKey,
  shiftMonthKey,
} from '@/utils/calendar';
import {
  formatCompactVndShort,
  formatDisplayDate,
} from '@/utils/display';
import { requestGuardLeave } from '@/utils/unsaved-changes';
import { FloatingGlassControl } from './floating-glass-control';
import {
  getStatsResponsiveProfile,
  STATS_MIN_FONT_SIZE,
  STATS_MIN_TOUCH_TARGET,
} from './stats-layout';
import { resolveCategoryVisual } from './stats-summary';

const MASKED_AMOUNT = '••••••';

type CalendarMode =
  | { type: 'calendar' }
  | { type: 'detail'; row: TransactionRow }
  | { type: 'edit'; row: TransactionRow }
  | { type: 'delete'; row: TransactionRow };

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function clampDayInMonth(month: string, preferredDay: number): string {
  const [y, m] = month.split('-').map(Number);
  const maxDay = daysInMonth(y, m);
  return `${month}-${pad2(Math.min(Math.max(1, preferredDay), maxDay))}`;
}

function debtKindLabel(kind: TransactionRow['kind']): string {
  if (kind === 'debt_borrow') return vi.debtBorrow;
  if (kind === 'debt_lend') return vi.debtLend;
  if (kind === 'debt_repay_paid') return vi.debtRepayPaid;
  if (kind === 'debt_repay_received') return vi.debtRepayReceived;
  return '';
}

function transactionSignPrefix(row: TransactionRow): '+' | '−' | '' {
  if (
    row.kind === 'income' ||
    row.kind === 'debt_borrow' ||
    row.kind === 'debt_repay_received'
  ) {
    return '+';
  }
  if (
    row.kind === 'expense' ||
    row.kind === 'transfer' ||
    row.kind === 'debt_lend' ||
    row.kind === 'debt_repay_paid'
  ) {
    return '−';
  }
  return '';
}

/**
 * Interactive Cash Flow Calendar showing monthly totals, daily income/expense grid,
 * collapsible calendar toggle, filters, and selected day's full transaction history.
 */
export function StatsCalendarView({ onClose }: { onClose?(): void } = {}) {
  const theme = useDesignTheme();
  const palette = useFinancePalette();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarScroll = useTabBarScroll();
  const currentDate = useCurrentDate();
  const fontScale = PixelRatio.getFontScale();
  const { width: viewportWidth } = useResponsiveLayout();
  const { reduceTransparency, increaseContrast } =
    useAccessibilityPreferences();
  const profile = getStatsResponsiveProfile({
    width: viewportWidth,
    fontScale,
    reduceTransparency,
    increaseContrast,
  });

  const hideBalance = usePreferences((state) => state.hideBalance);
  const toggleHideBalance = usePreferences((state) => state.toggleHideBalance);
  const openAddTransaction = usePreferences(
    (state) => state.openAddTransaction,
  );
  const currency = usePreferences((state) => state.currency);
  const language = usePreferences((state) => state.language);
  const recurringVersion = useApp((state) => state.recurringVersion);
  const isAddOpen = usePreferences((state) => state.isAddTransactionOpen);

  const [selectedDate, setSelectedDate] = useState(currentDate);
  const [month, setMonth] = useState(() => currentDate.slice(0, 7));
  const [calendarCollapsed, setCalendarCollapsed] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [filter, setFilter] = useState<CalendarMonthFilter>({ kind: 'all' });

  const [mode, setMode] = useState<CalendarMode>({ type: 'calendar' });
  const [monthData, setMonthData] = useState<CalendarMonthData | null>(null);
  const [dayDetails, setDayDetails] = useState<CalendarDayDetails | null>(null);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dayLoading, setDayLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reqRef = useRef(0);
  const dayReqRef = useRef(0);
  const working = useRef(false);
  const wasAddOpen = useRef(isAddOpen);
  const prevRecurring = useRef(recurringVersion);
  const previousDateRef = useRef(currentDate);

  // Follow rollover to the new real-world day unless user picked another date.
  useEffect(() => {
    setSelectedDate((prev) =>
      prev === previousDateRef.current ? currentDate : prev,
    );
    setMonth((prev) =>
      prev === previousDateRef.current.slice(0, 7)
        ? currentDate.slice(0, 7)
        : prev,
    );
    previousDateRef.current = currentDate;
  }, [currentDate]);

  const loadAll = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading((prev) => (monthData === null ? true : prev));
    setError('');
    try {
      const [mData, dData, wRows, cRows] = await withDatabase(async (db) =>
        Promise.all([
          readCalendarMonthData(db, month, filter),
          readCalendarDayTransactions(db, selectedDate, filter),
          listWallets(db, true),
          listCategories(db, true),
        ]),
      );
      if (req !== reqRef.current) return;
      setMonthData(mData);
      setDayDetails(dData);
      setWallets(wRows);
      setCategories(cRows);
    } catch {
      if (req === reqRef.current) setError(vi.transactionsLoadError);
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Keep previous UI visible while refreshing data.
  }, [filter, month, selectedDate]);

  const loadDayOnly = useCallback(
    async (targetDate: string) => {
      const req = ++dayReqRef.current;
      setDayLoading(true);
      try {
        const nextDay = await withDatabase((db) =>
          readCalendarDayTransactions(db, targetDate, filter),
        );
        if (req !== dayReqRef.current) return;
        setDayDetails(nextDay);
      } catch {
        if (req === dayReqRef.current) setError(vi.transactionsLoadError);
      } finally {
        if (req === dayReqRef.current) setDayLoading(false);
      }
    },
    [filter],
  );

  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(() => {
        void loadAll();
      });
      return () => cancelAnimationFrame(frame);
    }, [loadAll]),
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const addClosed = wasAddOpen.current && !isAddOpen;
      const recurringChanged = prevRecurring.current !== recurringVersion;
      wasAddOpen.current = isAddOpen;
      prevRecurring.current = recurringVersion;
      if (addClosed || recurringChanged) {
        void loadAll();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [isAddOpen, loadAll, recurringVersion]);

  const handleShiftMonth = (delta: -1 | 1) => {
    const nextMonth = shiftMonthKey(month, delta, currentDate.slice(0, 7));
    setMonth(nextMonth);
    const preferredDay =
      nextMonth === currentDate.slice(0, 7)
        ? Number(currentDate.slice(8, 10))
        : Number(selectedDate.slice(8, 10));
    setSelectedDate(clampDayInMonth(nextMonth, preferredDay));
  };

  const handleSelectDay = (date: string) => {
    setSelectedDate(date);
    void loadDayOnly(date);
  };

  const handleJumpToday = () => {
    const todayMonth = currentDate.slice(0, 7);
    setMonth(todayMonth);
    setSelectedDate(currentDate);
    if (month === todayMonth) {
      void loadDayOnly(currentDate);
    }
  };

  const backSubView = useCallback(() => {
    if (working.current) return;
    setError('');
    if (mode.type === 'edit') {
      requestGuardLeave('transaction-form', () =>
        setMode({ type: 'detail', row: mode.row }),
      );
      return;
    }
    if (mode.type === 'delete') {
      setMode({ type: 'detail', row: mode.row });
      return;
    }
    if (mode.type === 'detail') {
      setMode({ type: 'calendar' });
      return;
    }
    onClose?.();
  }, [mode, onClose]);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') return;
      const listener = BackHandler.addEventListener('hardwareBackPress', () => {
        if (mode.type === 'calendar') return false;
        backSubView();
        return true;
      });
      return () => listener.remove();
    }, [backSubView, mode.type]),
  );

  const hasActiveFilter =
    (filter.kind && filter.kind !== 'all') ||
    !!filter.walletId ||
    !!filter.categoryId;

  const formatAmount = (amountVnd: number) =>
    hideBalance ? MASKED_AMOUNT : formatCurrencyAmount(amountVnd, currency);

  const formatSignedNet = (amountVnd: number) => {
    if (hideBalance) return MASKED_AMOUNT;
    if (amountVnd > 0) return formatCurrencyAmount(amountVnd, currency);
    if (amountVnd < 0)
      return `−${formatCurrencyAmount(Math.abs(amountVnd), currency)}`;
    return formatCurrencyAmount(0, currency);
  };

  const walletById = useMemo(
    () => new Map(wallets.map((w) => [w.id, w])),
    [wallets],
  );
  const categoryById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );

  const cells = useMemo(() => {
    const raw = calendarDays(
      calendarMonthFromKey(month, currentDate.slice(0, 7)),
    );
    const padCount = (7 - (raw.length % 7)) % 7;
    const padded = [...raw, ...Array.from({ length: padCount }, () => null)];
    const weeks: (({ date: string; day: number } | null)[])[] = [];
    for (let i = 0; i < padded.length; i += 7) {
      weeks.push(padded.slice(i, i + 7));
    }
    return weeks;
  }, [currentDate, month]);

  const visibleWeeks = useMemo(() => {
    if (!calendarCollapsed) return cells;
    const match = cells.find((week) =>
      week.some((cell) => cell?.date === selectedDate),
    );
    return match ? [match] : cells.slice(0, 1);
  }, [calendarCollapsed, cells, selectedDate]);

  const walletOptions = useMemo(
    () => [
      { value: '', label: vi.txFilterAll },
      ...wallets.map((w) => ({
        value: w.id,
        label: displayWalletName(w.name, language),
      })),
    ],
    [language, wallets],
  );

  const categoryOptions = useMemo(() => {
    const ordered = orderCategoriesByParent(categories);
    return [
      { value: '', label: vi.txFilterAll },
      ...ordered.map((c) => ({
        value: c.id,
        label: c.parent_id
          ? `  ${displayCategoryName(c.name, language)}`
          : displayCategoryName(c.name, language),
      })),
    ];
  }, [categories, language]);

  const monthHeading = vi.statsMonthBanner.replace(
    '{value}',
    `${Number(month.slice(5, 7))}/${month.slice(0, 4)}`,
  );
  const dayTitle = vi.statsCalendarDayTitle.replace(
    '{date}',
    `${Number(selectedDate.slice(8, 10))}/${Number(selectedDate.slice(5, 7))}`,
  );

  // Detail / Edit / Delete sub-views reuse exact repository flows.
  if (mode.type === 'detail') {
    const detailRow = mode.row;
    const category = detailRow.category_id
      ? categoryById.get(detailRow.category_id)
      : undefined;
    const wallet = walletById.get(detailRow.wallet_id);
    const toWallet = detailRow.to_wallet_id
      ? walletById.get(detailRow.to_wallet_id)
      : undefined;
    const isIncome = detailRow.kind === 'income';
    const isExpense = detailRow.kind === 'expense';
    const kindLabel =
      detailRow.kind === 'income'
        ? vi.transactionIncome
        : detailRow.kind === 'expense'
          ? vi.transactionExpense
          : detailRow.kind === 'transfer'
            ? vi.transactionTransfer
            : debtKindLabel(detailRow.kind);

    return (
      <Screen title={vi.txDetailTitle} onBack={backSubView} backDisabled={busy}>
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
              {transactionSignPrefix(detailRow)}
              {formatCurrencyAmount(detailRow.amount, currency)}
            </Text>
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
                {displayWalletName(wallet?.name, language)}
                {toWallet ? ` → ${displayWalletName(toWallet.name, language)}` : ''}
              </Text>
            </View>
            {detailRow.kind !== 'transfer' && (
              <View style={styles.row}>
                <Text style={{ color: theme.text.secondary }}>
                  {vi.transactionCategory}
                </Text>
                <Text style={{ fontWeight: '700', color: theme.text.primary }}>
                  {category
                    ? displayCategoryName(category.name, language)
                    : vi.transactionUncategorized}
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
        </GlassCard>

        <View style={localStyles.detailActions}>
          <Button
            hitSlop={4}
            mode="contained"
            icon="pencil-outline"
            buttonColor={theme.brand.primaryStrong}
            textColor="#FFFFFF"
            contentStyle={styles.button}
            style={{ flex: 1 }}
            disabled={busy}
            onPress={() => setMode({ type: 'edit', row: detailRow })}
          >
            {vi.editTransaction}
          </Button>
          <Button
            hitSlop={4}
            mode="outlined"
            icon="trash-can-outline"
            textColor={palette.danger}
            contentStyle={styles.button}
            style={{ flex: 1 }}
            disabled={busy}
            onPress={() => setMode({ type: 'delete', row: detailRow })}
          >
            {vi.deleteTransaction}
          </Button>
        </View>
      </Screen>
    );
  }

  if (mode.type === 'edit') {
    const editingRow = mode.row;
    return (
      <TransactionForm
        row={editingRow}
        wallets={wallets}
        categories={categories}
        busy={busy || loading}
        error={error}
        guardRouteKey="budgets"
        onBack={() =>
          requestGuardLeave('transaction-form', () =>
            setMode({ type: 'detail', row: editingRow }),
          )
        }
        onNaturalSaved={async () => {
          setMode({ type: 'calendar' });
          useApp.setState((s) => ({
            recurringVersion: s.recurringVersion + 1,
          }));
          void checkBudgetAlerts();
          await loadAll();
        }}
        onSave={async (input) => {
          if (working.current) return;
          working.current = true;
          setBusy(true);
          setError('');
          try {
            await withDatabase((db) =>
              updateTransaction(
                db,
                editingRow.id,
                input,
                new Date().toISOString(),
                editingRow.updated_at,
              ),
            );
            setSelectedDate(input.occurredOn);
            setMonth(input.occurredOn.slice(0, 7));
            setMode({ type: 'calendar' });
            void useApp.getState().refreshWallets();
            useApp.setState((s) => ({
              recurringVersion: s.recurringVersion + 1,
            }));
            void checkBudgetAlerts();
            await loadAll();
          } catch {
            setError(vi.saveError);
          } finally {
            working.current = false;
            setBusy(false);
          }
        }}
      />
    );
  }

  if (mode.type === 'delete') {
    const targetRow = mode.row;
    return (
      <Screen
        title={vi.deleteTransaction}
        onBack={() => setMode({ type: 'detail', row: targetRow })}
        backDisabled={busy}
      >
        <GlassCard variant="elevated" radius="lg" padding={DesignSpacing.lg}>
          <View style={styles.inlineRow}>
            <IconBadge
              icon="alert-circle-outline"
              bg={palette.dangerSoft}
              fg={palette.dangerInk}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="titleMedium" style={{ fontWeight: '700' }}>
                {formatCurrencyAmount(targetRow.amount, currency)} ·{' '}
                {formatDisplayDate(targetRow.occurred_on)}
              </Text>
              {!!targetRow.note && (
                <Text style={{ color: palette.textMuted }}>
                  {targetRow.note}
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
          hitSlop={4}
          mode="contained"
          buttonColor={colors.error}
          icon="trash-can-outline"
          contentStyle={styles.button}
          disabled={busy}
          loading={busy}
          onPress={async () => {
            if (working.current) return;
            working.current = true;
            setBusy(true);
            setError('');
            try {
              await withDatabase((db) =>
                deleteTransaction(db, targetRow.id, targetRow.updated_at),
              );
              setMode({ type: 'calendar' });
              void useApp.getState().refreshWallets();
              useApp.setState((s) => ({
                recurringVersion: s.recurringVersion + 1,
              }));
              void checkBudgetAlerts();
              await loadAll();
            } catch {
              setError(vi.saveError);
            } finally {
              working.current = false;
              setBusy(false);
            }
          }}
        >
          {vi.deleteTransaction}
        </Button>
        <Button
          hitSlop={4}
          mode="outlined"
          contentStyle={styles.button}
          disabled={busy}
          onPress={() => setMode({ type: 'detail', row: targetRow })}
        >
          {vi.cancel}
        </Button>
      </Screen>
    );
  }

  const dailyTotals = monthData?.dailyTotals ?? {};
  const activityDates = monthData?.activityDates ?? {};
  const dayRows = dayDetails?.rows ?? [];
  const dayIncome = dayDetails?.dayIncome ?? 0;
  const dayExpense = dayDetails?.dayExpense ?? 0;

  const cardBorderWidth = profile.highContrast ? 1.5 : 1;

  const filterPanelCard = showFilter ? (
    <GlassCard variant="elevated" radius="lg" padding={DesignSpacing.md}>
      <View style={{ gap: 10 }}>
        <View style={styles.row}>
          <Text
            variant="titleSmall"
            style={{ fontWeight: '700', color: theme.text.primary }}
          >
            {vi.statsCalendarFilterTitle}
          </Text>
          {hasActiveFilter && (
            <Pressable
              accessibilityRole="button"
              onPress={() => setFilter({ kind: 'all' })}
              style={localStyles.filterResetBtn}
            >
              <Text
                variant="labelMedium"
                style={{
                  color: theme.brand.primaryText,
                  fontWeight: '700',
                }}
              >
                {vi.statsCalendarFilterReset}
              </Text>
            </Pressable>
          )}
        </View>
        {profile.reflowLargeText ? (
          <View style={localStyles.filterKindWrap}>
            {(
              [
                { key: 'all', label: vi.txFilterAll },
                { key: 'expense', label: vi.transactionExpense },
                { key: 'income', label: vi.transactionIncome },
                { key: 'transfer', label: vi.transactionTransfer },
                { key: 'debt', label: vi.statsKindDebtFilter },
              ] as const
            ).map((item) => (
              <Pill
                key={item.key}
                label={item.label}
                tone={filter.kind === item.key ? 'primary' : 'glass'}
                size="sm"
                onPress={() =>
                  setFilter((prev) => ({
                    ...prev,
                    kind: item.key as CalendarKindFilter,
                  }))
                }
              />
            ))}
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8 }}
          >
            {(
              [
                { key: 'all', label: vi.txFilterAll },
                { key: 'expense', label: vi.transactionExpense },
                { key: 'income', label: vi.transactionIncome },
                { key: 'transfer', label: vi.transactionTransfer },
                { key: 'debt', label: vi.statsKindDebtFilter },
              ] as const
            ).map((item) => (
              <Pill
                key={item.key}
                label={item.label}
                tone={filter.kind === item.key ? 'primary' : 'glass'}
                size="sm"
                onPress={() =>
                  setFilter((prev) => ({
                    ...prev,
                    kind: item.key as CalendarKindFilter,
                  }))
                }
              />
            ))}
          </ScrollView>
        )}
        <View style={{ gap: 8 }}>
          <AppleMenuPicker
            label={vi.transactionWallet}
            value={filter.walletId ?? ''}
            options={walletOptions}
            onSelect={(value) =>
              setFilter((prev) => ({
                ...prev,
                walletId: value || undefined,
              }))
            }
          />
          <AppleMenuPicker
            label={vi.transactionCategory}
            value={filter.categoryId ?? ''}
            options={categoryOptions}
            onSelect={(value) =>
              setFilter((prev) => ({
                ...prev,
                categoryId: value || undefined,
              }))
            }
          />
        </View>
      </View>
    </GlassCard>
  ) : null;

  const summaryItems = [
    {
      key: 'income',
      label: vi.transactionIncome,
      value: formatAmount(monthData?.totalIncome ?? 0),
      color: theme.finance.incomeText,
    },
    {
      key: 'expense',
      label: vi.transactionExpense,
      value: formatAmount(monthData?.totalExpense ?? 0),
      color: theme.text.primary,
    },
    {
      key: 'net',
      label: vi.statsDifferenceLabel,
      value: formatSignedNet(monthData?.totalNet ?? 0),
      color: theme.text.primary,
    },
  ];

  const monthSummaryCard = (
    <GlassCard variant="elevated" radius="lg" padding={DesignSpacing.md}>
      {profile.reflowLargeText ? (
        <View style={localStyles.summaryStackedList}>
          {summaryItems.map((item, idx) => (
            <View
              key={item.key}
              style={[
                localStyles.summaryStackedRow,
                idx > 0 && {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: theme.card.border,
                  paddingTop: 8,
                },
              ]}
            >
              <Text
                variant="labelMedium"
                style={{ color: theme.text.secondary, flexShrink: 1 }}
              >
                {item.label}
              </Text>
              <Text
                variant="titleSmall"
                style={[styles.number, { color: item.color, fontWeight: '800' }]}
              >
                {item.value}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <View style={localStyles.summaryTripleRow}>
          {summaryItems.map((item, idx) => (
            <View key={item.key} style={localStyles.summaryColWrap}>
              {idx > 0 && (
                <View
                  style={[
                    localStyles.summaryDivider,
                    { backgroundColor: theme.card.border },
                  ]}
                />
              )}
              <View style={localStyles.summaryCol}>
                <Text
                  variant="labelSmall"
                  style={{ color: theme.text.secondary }}
                  numberOfLines={1}
                >
                  {item.label}
                </Text>
                <Text
                  variant="titleSmall"
                  style={[styles.number, { color: item.color, fontWeight: '800' }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.75}
                >
                  {item.value}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </GlassCard>
  );

  const errorBannerCard = error ? (
    <GlassCard variant="elevated" radius="lg" padding={DesignSpacing.md}>
      <View style={localStyles.errorBanner}>
        <Text
          accessibilityRole="alert"
          variant="bodyMedium"
          style={{ color: palette.danger, flex: 1 }}
        >
          {error}
        </Text>
        <Button mode="outlined" onPress={() => void loadAll()}>
          {vi.retry}
        </Button>
      </View>
    </GlassCard>
  ) : null;

  const calendarGridCard = (
    <GlassCard variant="elevated" radius="xl" padding={DesignSpacing.md}>
      <View style={localStyles.weekHeaderRow}>
        {[
          vi.statsCalendarWeekdayMon,
          vi.statsCalendarWeekdayTue,
          vi.statsCalendarWeekdayWed,
          vi.statsCalendarWeekdayThu,
          vi.statsCalendarWeekdayFri,
          vi.statsCalendarWeekdaySat,
          vi.statsCalendarWeekdaySun,
        ].map((label) => (
          <Text
            key={label}
            variant="labelSmall"
            style={[localStyles.weekdayLabel, { color: theme.text.muted }]}
          >
            {label}
          </Text>
        ))}
      </View>

      <View style={{ gap: 6 }}>
        {visibleWeeks.map((week, rowIdx) => (
          <View key={`wk-${rowIdx}`} style={localStyles.weekRow}>
            {week.map((cell, colIdx) => {
              if (!cell) {
                return (
                  <View
                    key={`empty-${rowIdx}-${colIdx}`}
                    style={localStyles.dayCellSpacer}
                  />
                );
              }
              const totals = dailyTotals[cell.date];
              const hasIncome = (totals?.income ?? 0) > 0;
              const hasExpense = (totals?.expense ?? 0) > 0;
              const hasOtherOnly =
                !hasIncome && !hasExpense && !!activityDates[cell.date];
              const isSelected = cell.date === selectedDate;
              const isToday = cell.date === currentDate;
              const dayText =
                cell.day === 1
                  ? `1/${Number(month.slice(5, 7))}`
                  : String(cell.day);

              return (
                <Pressable
                  key={cell.date}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={`${formatDisplayDate(cell.date)}${hasIncome ? `, ${vi.transactionIncome} ${formatAmount(totals.income)}` : ''}${hasExpense ? `, ${vi.transactionExpense} ${formatAmount(totals.expense)}` : ''}`}
                  onPress={() => handleSelectDay(cell.date)}
                  style={[
                    localStyles.dayCell,
                    {
                      backgroundColor: isSelected
                        ? theme.brand.primarySoft
                        : theme.card.surfaceSubtle,
                      borderColor: isSelected
                        ? theme.brand.primaryStrong
                        : isToday
                          ? theme.brand.primary
                          : theme.card.border,
                      borderWidth: isSelected ? 2 : cardBorderWidth,
                    },
                  ]}
                >
                  <View style={localStyles.dayNumRow}>
                    <Text
                      style={[
                        localStyles.dayNumText,
                        {
                          color: isSelected
                            ? theme.brand.primaryText
                            : isToday
                              ? theme.brand.primaryStrong
                              : theme.text.secondary,
                          fontWeight: isSelected || isToday ? '800' : '600',
                        },
                      ]}
                    >
                      {dayText}
                    </Text>
                    {isToday && (
                      <View
                        style={[
                          localStyles.todayDot,
                          {
                            backgroundColor: theme.brand.primaryStrong,
                          },
                        ]}
                      />
                    )}
                  </View>

                  <View style={localStyles.dayAmountsWrap}>
                    {hasIncome && (
                      <Text
                        style={[
                          localStyles.cellAmountText,
                          { color: theme.finance.incomeText },
                        ]}
                        numberOfLines={1}
                        adjustsFontSizeToFit={!profile.reflowLargeText}
                        minimumFontScale={0.85}
                      >
                        {hideBalance
                          ? '••'
                          : formatCompactVndShort(totals.income)}
                      </Text>
                    )}
                    {hasExpense && (
                      <Text
                        style={[
                          localStyles.cellAmountText,
                          { color: theme.text.primary },
                        ]}
                        numberOfLines={1}
                        adjustsFontSizeToFit={!profile.reflowLargeText}
                        minimumFontScale={0.85}
                      >
                        {hideBalance
                          ? '••'
                          : formatCompactVndShort(totals.expense)}
                      </Text>
                    )}
                    {hasOtherOnly && (
                      <View
                        style={[
                          localStyles.activityDot,
                          { backgroundColor: theme.text.muted },
                        ]}
                      />
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>

      {/* Legend */}
      <View style={localStyles.legendRow}>
        <View style={localStyles.legendItem}>
          <View
            style={[
              localStyles.legendDot,
              { backgroundColor: theme.finance.income },
            ]}
          />
          <Text variant="labelSmall" style={{ color: theme.text.secondary }}>
            {vi.statsCalendarLegendIncome}
          </Text>
        </View>
        <View style={localStyles.legendItem}>
          <View
            style={[
              localStyles.legendDot,
              { backgroundColor: theme.text.primary },
            ]}
          />
          <Text variant="labelSmall" style={{ color: theme.text.secondary }}>
            {vi.statsCalendarLegendExpense}
          </Text>
        </View>
      </View>

      {/* Collapse / Expand Chevron Handle */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          calendarCollapsed
            ? vi.statsCalendarExpand
            : vi.statsCalendarCollapse
        }
        accessibilityState={{ expanded: !calendarCollapsed }}
        onPress={() => setCalendarCollapsed((prev) => !prev)}
        style={[
          localStyles.collapseHandle,
          { borderTopColor: theme.card.border },
        ]}
      >
        <MaterialCommunityIcons
          name={
            calendarCollapsed ? 'chevron-double-down' : 'chevron-double-up'
          }
          size={18}
          color={theme.text.muted}
        />
      </Pressable>
    </GlassCard>
  );

  const dayTransactionsSection = (
    <View style={{ gap: 8 }}>
      <View
        style={[
          localStyles.dayHeaderRow,
          profile.reflowLargeText && {
            flexDirection: 'column',
            alignItems: 'flex-start',
          },
        ]}
      >
        <Text
          variant="titleMedium"
          style={{
            color: theme.text.primary,
            fontWeight: '800',
            flex: profile.reflowLargeText ? 0 : 1,
          }}
        >
          {dayTitle}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={vi.statsCalendarAddTx}
          onPress={() => openAddTransaction('manual', selectedDate)}
          style={localStyles.addDayTxBtn}
        >
          <MaterialCommunityIcons
            name="plus"
            size={16}
            color={theme.brand.primaryText}
          />
          <Text
            variant="labelLarge"
            style={{
              color: theme.brand.primaryText,
              fontWeight: '700',
            }}
          >
            {vi.statsCalendarAddTx}
          </Text>
        </Pressable>
      </View>

      <View
        style={[
          localStyles.dayTotalsSubRow,
          profile.reflowLargeText && {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 10,
          },
        ]}
      >
        <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
          {`${vi.statsCalendarTotalIncome} `}
          <Text
            style={[
              styles.number,
              { color: theme.finance.incomeText, fontWeight: '700' },
            ]}
          >
            {formatAmount(dayIncome)}
          </Text>
        </Text>
        {!profile.reflowLargeText && (
          <Text variant="bodySmall" style={{ color: theme.text.muted }}>
            {' | '}
          </Text>
        )}
        <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
          {`${vi.statsCalendarTotalExpense} `}
          <Text
            style={[
              styles.number,
              { color: theme.text.primary, fontWeight: '700' },
            ]}
          >
            {formatAmount(dayExpense)}
          </Text>
        </Text>
      </View>

      <GlassCard variant="elevated" radius="xl" padding={0}>
        <View
          style={[
            localStyles.dayDateBanner,
            { backgroundColor: theme.brand.primarySoft },
          ]}
        >
          <Text
            variant="labelMedium"
            style={{ color: theme.text.secondary, fontWeight: '600' }}
          >
            {formatDisplayDate(selectedDate)}
          </Text>
        </View>

        {dayLoading ? (
          <View style={{ padding: 20, alignItems: 'center' }}>
            <ActivityIndicator size="small" />
          </View>
        ) : dayRows.length === 0 ? (
          <View style={{ padding: 20, alignItems: 'center' }}>
            <Text
              variant="bodyMedium"
              style={{ color: theme.text.muted, textAlign: 'center' }}
            >
              {vi.statsCalendarEmptyDay}
            </Text>
          </View>
        ) : (
          <View style={{ padding: 14, gap: 12 }}>
            {dayRows.map((row, idx) => {
              const cat = row.category_id
                ? categoryById.get(row.category_id)
                : undefined;
              const parentCat =
                cat?.parent_id ? categoryById.get(cat.parent_id) : undefined;
              const catName = cat
                ? displayCategoryName(cat.name, language)
                : vi.transactionUncategorized;
              const cashFlow = isCashFlowKind(row.kind);
              const isTransfer = row.kind === 'transfer';
              const isDebt = isDebtTransactionKind(row.kind);
              const wallet = walletById.get(row.wallet_id);

              const visual = cashFlow
                ? resolveCategoryVisual(
                    {
                      systemKey: cat?.system_key ?? parentCat?.system_key,
                      icon: cat?.icon ?? parentCat?.icon,
                      color: cat?.color ?? parentCat?.color,
                      id: cat?.id ?? null,
                    },
                    idx,
                    !cat,
                  )
                : {
                    icon: isTransfer
                      ? 'swap-horizontal'
                      : 'handshake-outline',
                    color: isTransfer
                      ? theme.brand.primaryStrong
                      : palette.purple,
                  };

              const fallbackTitle = isTransfer
                ? vi.transactionTransfer
                : isDebt
                  ? debtKindLabel(row.kind)
                  : catName;
              const primaryTitle = row.note?.trim() || fallbackTitle;
              const sign = transactionSignPrefix(row);
              const amountColor = !cashFlow
                ? theme.text.muted
                : row.kind === 'income'
                  ? theme.finance.incomeText
                  : theme.text.primary;

              return (
                <Pressable
                  key={row.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${primaryTitle}, ${sign}${formatAmount(row.amount)}`}
                  onPress={() => setMode({ type: 'detail', row })}
                  style={[
                    localStyles.txRow,
                    profile.reflowLargeText && { alignItems: 'flex-start' },
                    idx > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: theme.card.border,
                      paddingTop: 12,
                    },
                  ]}
                >
                  <View
                    style={[
                      localStyles.txIconCircle,
                      { backgroundColor: `${visual.color}1C` },
                    ]}
                  >
                    <MaterialCommunityIcons
                      name={visual.icon as never}
                      size={19}
                      color={visual.color}
                    />
                  </View>

                  <View style={{ flex: 1, gap: 4 }}>
                    <Text
                      variant="bodyLarge"
                      style={{
                        color: theme.text.primary,
                        fontWeight: '600',
                      }}
                      numberOfLines={profile.reflowLargeText ? 2 : 1}
                    >
                      {primaryTitle}
                    </Text>

                    {cashFlow ? (
                      <View style={localStyles.txMetaRow}>
                        <View
                          style={[
                            localStyles.categoryChip,
                            {
                              backgroundColor: `${visual.color}18`,
                              borderColor: `${visual.color}55`,
                              borderWidth: cardBorderWidth,
                            },
                          ]}
                        >
                          <MaterialCommunityIcons
                            name={visual.icon as never}
                            size={12}
                            color={visual.color}
                          />
                          <Text
                            style={[
                              localStyles.categoryChipText,
                              { color: visual.color },
                            ]}
                            numberOfLines={profile.reflowLargeText ? 2 : 1}
                          >
                            {catName}
                          </Text>
                        </View>
                        {!!wallet && (
                          <Text
                            variant="labelSmall"
                            style={{ color: theme.text.muted }}
                            numberOfLines={profile.reflowLargeText ? 2 : 1}
                          >
                            {displayWalletName(wallet.name, language)}
                          </Text>
                        )}
                      </View>
                    ) : (
                      <View style={localStyles.txMetaRow}>
                        <MaterialCommunityIcons
                          name="chart-bar"
                          size={13}
                          color={theme.text.muted}
                        />
                        <Text
                          variant="bodySmall"
                          style={{
                            color: theme.text.muted,
                            flexShrink: 1,
                          }}
                          numberOfLines={profile.reflowLargeText ? 2 : 1}
                        >
                          {vi.statsCalendarExcludedHint}
                        </Text>
                      </View>
                    )}

                    {profile.reflowLargeText && (
                      <Text
                        variant="bodyLarge"
                        style={[
                          styles.number,
                          { color: amountColor, fontWeight: '700' },
                        ]}
                      >
                        {hideBalance
                          ? MASKED_AMOUNT
                          : `${sign}${formatCurrencyAmount(row.amount, currency)}`}
                      </Text>
                    )}
                  </View>

                  {!profile.reflowLargeText && (
                    <Text
                      variant="bodyLarge"
                      style={[
                        styles.number,
                        { color: amountColor, fontWeight: '700' },
                      ]}
                    >
                      {hideBalance
                        ? MASKED_AMOUNT
                        : `${sign}${formatCurrencyAmount(row.amount, currency)}`}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
      </GlassCard>
    </View>
  );

  return (
    <Screen
      title={vi.statsCalendarTitle}
      onBack={onClose}
      scroll={false}
      maxWidth={1120}
      headerRight={
        selectedDate !== currentDate || month !== currentDate.slice(0, 7) ? (
          <FloatingGlassControl
            shape="pill"
            minHeight={STATS_MIN_TOUCH_TARGET}
            paddingHorizontal={14}
            tintColor={theme.brand.primarySoft}
            accessibilityLabel={vi.statsCalendarTodayBtn}
            onPress={handleJumpToday}
          >
            <Text
              variant="labelMedium"
              style={{ color: theme.brand.primaryText, fontWeight: '700' }}
            >
              {vi.statsCalendarTodayBtn}
            </Text>
          </FloatingGlassControl>
        ) : undefined
      }
    >
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        onScroll={tabBarScroll.onScroll}
        scrollEventThrottle={tabBarScroll.scrollEventThrottle}
        contentContainerStyle={{
          gap: 12,
          paddingBottom: DesignSpacing.bottomTabClearance + insets.bottom,
        }}
      >
        {/* Top Toolbar: Eye | < Month/Year > | Filter */}
        <View style={localStyles.toolbarRow}>
          <FloatingGlassControl
            shape="circle"
            minWidth={STATS_MIN_TOUCH_TARGET}
            minHeight={STATS_MIN_TOUCH_TARGET}
            accessibilityLabel={
              hideBalance ? vi.statsShowAmountsA11y : vi.statsHideAmountsA11y
            }
            accessibilityState={{ selected: hideBalance }}
            onPress={() => void toggleHideBalance()}
          >
            <MaterialCommunityIcons
              name={hideBalance ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color={theme.text.primary}
            />
          </FloatingGlassControl>

          <View style={localStyles.monthSwitcher}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={vi.statsPreviousMonthA11y}
              onPress={() => handleShiftMonth(-1)}
              style={localStyles.toolbarIconBtn}
            >
              <MaterialCommunityIcons
                name="chevron-left"
                size={22}
                color={theme.text.primary}
              />
            </Pressable>
            <Text
              variant="titleMedium"
              style={{ color: theme.text.primary, fontWeight: '700' }}
            >
              {monthHeading}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={vi.statsNextMonthA11y}
              onPress={() => handleShiftMonth(1)}
              style={localStyles.toolbarIconBtn}
            >
              <MaterialCommunityIcons
                name="chevron-right"
                size={22}
                color={theme.text.primary}
              />
            </Pressable>
          </View>

          <FloatingGlassControl
            shape="circle"
            minWidth={STATS_MIN_TOUCH_TARGET}
            minHeight={STATS_MIN_TOUCH_TARGET}
            tintColor={
              hasActiveFilter || showFilter ? theme.brand.primarySoft : undefined
            }
            accessibilityLabel={vi.statsCalendarFilterBtn}
            accessibilityState={{ expanded: showFilter }}
            onPress={() => setShowFilter((prev) => !prev)}
          >
            <View>
              <MaterialCommunityIcons
                name="filter-variant"
                size={20}
                color={
                  hasActiveFilter || showFilter
                    ? theme.brand.primaryStrong
                    : theme.text.primary
                }
              />
              {hasActiveFilter && (
                <View
                  style={[
                    localStyles.filterDot,
                    { backgroundColor: theme.brand.primaryStrong },
                  ]}
                />
              )}
            </View>
          </FloatingGlassControl>
        </View>

        {errorBannerCard}

        {loading && !monthData ? (
          <View style={{ paddingVertical: 32, alignItems: 'center' }}>
            <ActivityIndicator size="large" accessibilityLabel={vi.loading} />
          </View>
        ) : profile.isWide ? (
          <View style={localStyles.wideSplitRow}>
            <View style={localStyles.wideLeftCol}>
              {filterPanelCard}
              {monthSummaryCard}
              {calendarGridCard}
            </View>
            <View style={localStyles.wideRightCol}>
              {dayTransactionsSection}
            </View>
          </View>
        ) : (
          <>
            {filterPanelCard}
            {monthSummaryCard}
            {calendarGridCard}
            {dayTransactionsSection}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const localStyles = StyleSheet.create({
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toolbarIconBtn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthSwitcher: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  filterDot: {
    position: 'absolute',
    top: -1,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  summaryTripleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  summaryColWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  summaryCol: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 4,
  },
  summaryStackedList: {
    gap: 8,
  },
  summaryStackedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  wideSplitRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
  },
  wideLeftCol: {
    flex: 1,
    gap: 12,
  },
  wideRightCol: {
    flex: 1,
    gap: 12,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
  },
  filterResetBtn: {
    minHeight: STATS_MIN_TOUCH_TARGET,
    paddingHorizontal: 8,
    justifyContent: 'center',
  },
  filterKindWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  summaryDivider: {
    width: 1,
    height: 32,
  },
  weekHeaderRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  weekdayLabel: {
    flex: 1,
    textAlign: 'center',
    fontWeight: '600',
  },
  weekRow: {
    flexDirection: 'row',
    gap: 4,
  },
  dayCellSpacer: {
    flex: 1,
    minHeight: 58,
  },
  dayCell: {
    flex: 1,
    minHeight: 58,
    borderRadius: DesignRadius.sm,
    borderWidth: 1,
    paddingHorizontal: 2,
    paddingVertical: 4,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dayNumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  dayNumText: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  todayDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  dayAmountsWrap: {
    width: '100%',
    alignItems: 'center',
    gap: 1,
    minHeight: 26,
    justifyContent: 'flex-end',
  },
  cellAmountText: {
    fontSize: STATS_MIN_FONT_SIZE,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  activityDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginBottom: 4,
  },
  legendRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
    marginTop: 10,
    marginBottom: 4,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  collapseHandle: {
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    minHeight: STATS_MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  dayHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  addDayTxBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 44,
    paddingHorizontal: 8,
  },
  dayTotalsSubRow: {
    marginTop: -4,
    flexDirection: 'row',
    alignItems: 'center',
  },
  dayDateBanner: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopLeftRadius: DesignRadius.xl,
    borderTopRightRadius: DesignRadius.xl,
  },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 48,
  },
  txIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  txMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  categoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
    maxWidth: '72%',
  },
  categoryChipText: {
    fontSize: STATS_MIN_FONT_SIZE,
    fontWeight: '600',
  },
  detailActions: {
    flexDirection: 'row',
    gap: 12,
  },
});
