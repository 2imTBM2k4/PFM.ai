import MaterialCommunityIcons from '@/components/platform-icon';
import { useFocusEffect, useRouter } from 'expo-router';
import { budgetBannerItems, monthKey } from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import type { TransactionInput } from '@pfm/contracts';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  ActivityIndicator,
  Button,
  Divider,
  ProgressBar,
  Text,
} from 'react-native-paper';
import { EmptyStateCard, IconBadge, Screen, styles } from '@/components/screen';
import { GlassCard, Pill } from '@/components/ui';
import {
  createSoftShadow,
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
  walletKindVisual,
} from '@/constants/theme';
import { useResponsiveLayout } from '@/constants/responsive-layout';
import { withDatabase } from '@/data/connection';
import {
  budgetBannerDismissKey,
  dismissBudgetBannerItems,
  filterVisibleBudgetBannerItems,
} from '@/data/budgets';
import { readDashboard, type Dashboard } from '@/data/dashboard';
import { prioritizePinnedWallets } from '@/data/wallets';
import { DEBT_KIND_LABELS } from '@/features/debts/labels';

import { vi } from '@/messages/vi';
import { displayCategoryName, displayWalletName } from '@/messages/seed-labels';
import { useApp } from '@/state/app';
import { usePreferences } from '@/state/preferences';
import { useCurrentDate } from '@/hooks/use-current-date';
import { BudgetBanner } from './budget-banner';
import { formatRecentTransactionTime } from './transaction-time';

/**
 * Converts integer basis points into a localized percentage delta label.
 */
function changeLabel(bps: number | null) {
  if (bps === null) return vi.overviewNew;
  return `${bps > 0 ? '+' : bps < 0 ? '−' : ''}${(Math.abs(bps) / 100)
    .toFixed(2)
    .replace(/\.00$/, '')
    .replace(/(\.\d)0$/, '$1')
    .replace('.', ',')}%`;
}

/**
 * Home (Overview) screen matching the reference Pastel Sunset + Glassmorphism design.
 * Calculates total balance, month-over-month %, Income/Expenses/Savings cards,
 * AI Assistant Orb card, and Recent Transactions from real local SQLite data.
 */
export function OverviewScreen({
  onWallets,
  onGoals: _onGoals,
}: {
  onWallets(): void;
  onGoals?(): void;
}) {
  const date = useCurrentDate();
  const [data, setData] = useState<Dashboard | null>(null);
  const [dismissedBannerKeys, setDismissedBannerKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const request = useRef(0);
  const hasLoadedOnce = useRef(false);
  const recurringVersion = useApp((state) => state.recurringVersion);
  const palette = useFinancePalette();
  const designTheme = useDesignTheme();
  const { isDuoClosedPortrait } = useResponsiveLayout();
  const router = useRouter();

  const load = useCallback(
    async (showSpinner = false) => {
      const id = ++request.current;
      if (showSpinner || !hasLoadedOnce.current) {
        setLoading(true);
      }
      setError(false);
      try {
        const currentMonth = monthKey(date);
        const next = await withDatabase((db) =>
          readDashboard(db, currentMonth),
        );
        if (id !== request.current) return;
        hasLoadedOnce.current = true;
        setData(next);
        setDismissedBannerKeys(next.dismissedBudgetBannerKeys);
        useApp.setState({
          wallets: next.wallets.filter((wallet) => !wallet.is_archived),
        });
      } catch {
        if (id === request.current) setError(true);
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [date],
  );

  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(() => {
        void load(false);
      });
      const listener = AppState.addEventListener('change', (state) => {
        if (state === 'active') void load(false);
      });
      return () => {
        cancelAnimationFrame(frame);
        request.current++;
        listener.remove();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Automatic transactions change the visible statistics.
    }, [load, recurringVersion]),
  );

  const hideBalance = usePreferences((state) => state.hideBalance);
  const toggleHideBalance = usePreferences((state) => state.toggleHideBalance);

  const activeWallets = data
    ? prioritizePinnedWallets(
        data.wallets.filter((wallet) => !wallet.is_archived),
        data.pinnedWalletIds,
      )
    : [];
  const goals = data?.goals;
  const topGoal = useMemo(() => {
    if (!goals?.length) return null;
    const candidates = goals.filter((g) => g.status !== 'archived');
    if (!candidates.length) return null;
    return [...candidates].sort((a, b) => b.progress - a.progress)[0];
  }, [goals]);
  const visibleBannerItems = data
    ? filterVisibleBudgetBannerItems(
        budgetBannerItems(data.budgets),
        data.current.month,
        dismissedBannerKeys,
      )
    : [];

  const headerActions = (
    <View
      style={[
        localStyles.headerButtons,
        isDuoClosedPortrait && localStyles.verticalHeaderButtons,
        isDuoClosedPortrait && createSoftShadow(designTheme.mode, 'sm'),
        isDuoClosedPortrait && {
          backgroundColor: designTheme.card.surface,
          borderColor: designTheme.card.border,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={vi.notificationsTitle}
        onPress={() =>
          router.push({ pathname: '/detail', params: { screen: 'alerts' } })
        }
        style={({ pressed }) => [
          localStyles.circleHeaderBtn,
          !isDuoClosedPortrait && createSoftShadow(designTheme.mode, 'sm'),
          {
            backgroundColor: isDuoClosedPortrait
              ? pressed
                ? designTheme.brand.primarySoft
                : 'transparent'
              : designTheme.card.surfaceElevated,
            borderColor: isDuoClosedPortrait
              ? 'transparent'
              : designTheme.card.border,
            opacity: pressed ? 0.78 : 1,
          },
        ]}
      >
        <MaterialCommunityIcons
          name="bell-outline"
          size={20}
          color={designTheme.text.primary}
        />
      </Pressable>
    </View>
  );

  return (
    <Screen
      title={vi.overviewTitle}
      headerRight={isDuoClosedPortrait ? undefined : headerActions}
      rightRail={isDuoClosedPortrait ? headerActions : undefined}
    >
      {loading && !data && (
        <View style={localStyles.centerBox}>
          <ActivityIndicator size="large" accessibilityLabel={vi.loading} />
        </View>
      )}

      {error && (
        <GlassCard
          radius="lg"
          style={{
            backgroundColor: palette.dangerSoft,
            borderColor: palette.danger,
          }}
        >
          <Text accessibilityRole="alert" style={{ color: palette.dangerInk }}>
            {vi.overviewLoadError}
          </Text>
          <Button
            hitSlop={4}
            mode="contained-tonal"
            disabled={loading}
            onPress={() => void load(true)}
          >
            {vi.refresh}
          </Button>
        </GlassCard>
      )}

      {data && (
        <>
          <BudgetBanner
            items={visibleBannerItems}
            onPress={() =>
              router.navigate({
                pathname: '/budgets',
                params: { tab: 'budgets' },
              })
            }
            onDismiss={() => {
              const currentMonth = data.current.month;
              const newKeys = visibleBannerItems.map((item) =>
                budgetBannerDismissKey(
                  item.budgetId,
                  item.periodKey ?? currentMonth,
                  item.level,
                ),
              );
              setDismissedBannerKeys((prev) => [
                ...new Set([...prev, ...newKeys]),
              ]);
              void withDatabase((db) =>
                dismissBudgetBannerItems(db, currentMonth, visibleBannerItems),
              ).catch(() => undefined);
            }}
          />

          {/* Hero Total Balance Card */}
          <GlassCard variant="elevated" radius="xl" padding={22}>
            <View style={localStyles.heroTopRow}>
              <View style={{ flex: 1, gap: 4 }}>
                <View style={localStyles.balanceTitleRow}>
                  <Text
                    variant="labelLarge"
                    style={{
                      color: designTheme.text.secondary,
                      fontWeight: '600',
                    }}
                  >
                    {vi.overviewLiveBalance}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      hideBalance
                        ? vi.overviewShowBalance
                        : vi.overviewHideBalance
                    }
                    onPress={() => void toggleHideBalance()}
                    style={localStyles.eyeIconButton}
                    hitSlop={8}
                  >
                    <MaterialCommunityIcons
                      name={hideBalance ? 'eye-off-outline' : 'eye-outline'}
                      size={18}
                      color={designTheme.text.secondary}
                    />
                  </Pressable>
                </View>
                <Text
                  style={[
                    styles.number,
                    localStyles.heroBalanceText,
                    { color: designTheme.text.primary },
                  ]}
                >
                  {hideBalance ? '••••••••' : formatVnd(data.balance)}
                </Text>
              </View>

              {/* Income & Expense in top-right corner of hero card */}
              <View style={localStyles.heroIncomeExpenseBlock}>
                <View
                  style={[
                    localStyles.heroStatPill,
                    {
                      backgroundColor: designTheme.finance.incomeSoft,
                      borderColor:
                        designTheme.mode === 'light'
                          ? 'rgba(46, 125, 50, 0.35)'
                          : designTheme.finance.income,
                    },
                  ]}
                >
                  <MaterialCommunityIcons
                    name="arrow-bottom-left"
                    size={14}
                    color={designTheme.finance.incomeText}
                  />
                  <Text
                    style={[
                      styles.number,
                      localStyles.heroStatNumber,
                      { color: designTheme.finance.incomeText },
                    ]}
                  >
                    {hideBalance
                      ? '••••••'
                      : `+${formatVnd(data.current.income)}`}
                  </Text>
                </View>

                <View
                  style={[
                    localStyles.heroStatPill,
                    {
                      backgroundColor: designTheme.finance.expenseSoft,
                      borderColor:
                        designTheme.mode === 'light'
                          ? 'rgba(211, 47, 47, 0.35)'
                          : designTheme.finance.expense,
                    },
                  ]}
                >
                  <MaterialCommunityIcons
                    name="arrow-top-right"
                    size={14}
                    color={designTheme.finance.expenseText}
                  />
                  <Text
                    style={[
                      styles.number,
                      localStyles.heroStatNumber,
                      { color: designTheme.finance.expenseText },
                    ]}
                  >
                    {hideBalance
                      ? '••••••'
                      : `-${formatVnd(data.current.expense)}`}
                  </Text>
                </View>
              </View>
            </View>

            {/* Wallet shortcut + active wallets strip */}
            <View style={[styles.inlineRow, { marginTop: 10 }]}>
              <Pill
                icon="wallet-outline"
                label={vi.manageWallets}
                tone="primary"
                size="sm"
                onPress={onWallets}
              />
            </View>

            {activeWallets.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={localStyles.walletsStrip}
              >
                {activeWallets.map((wallet) => {
                  const visual = walletKindVisual(wallet.kind, palette);
                  return (
                    <Pressable
                      key={wallet.id}
                      onPress={onWallets}
                      style={({ pressed }) => [
                        localStyles.walletMiniCard,
                        createSoftShadow(designTheme.mode, 'sm'),
                        {
                          backgroundColor: designTheme.card.surfaceSubtle,
                          borderColor:
                            designTheme.mode === 'light'
                              ? 'rgba(0, 0, 0, 0.16)'
                              : designTheme.card.border,
                          borderWidth: designTheme.mode === 'light' ? 1.5 : 1,
                          opacity: pressed ? 0.78 : 1,
                        },
                      ]}
                    >
                      <IconBadge
                        icon={visual.icon}
                        bg={visual.bg}
                        fg={visual.fg}
                        size={30}
                        iconSize={16}
                      />
                      <View style={{ flex: 1 }}>
                        <Text
                          variant="labelMedium"

                          style={{
                            color: designTheme.text.secondary,
                            fontWeight: '600',
                          }}
                        >
                          {displayWalletName(wallet.name)}
                        </Text>
                        <Text
                          variant="bodyMedium"

                          style={[
                            styles.number,
                            {
                              color:
                                wallet.balance < 0
                                  ? designTheme.finance.expense
                                  : designTheme.text.primary,
                              fontWeight: '700',
                            },
                          ]}
                        >
                          {hideBalance ? '••••••' : formatVnd(wallet.balance)}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </GlassCard>

          {/* Top Savings Goal Card */}
          {topGoal && (
            <GlassCard
              variant="elevated"
              radius="xl"
              padding={18}
              onPress={() =>
                router.navigate({
                  pathname: '/budgets',
                  params: { tab: 'goals' },
                })
              }
              accessibilityLabel={vi.overviewTopGoal}
            >
              <View style={styles.row}>
                <View style={[styles.inlineRow, { flex: 1 }]}>
                  <IconBadge
                    icon="bullseye-arrow"
                    bg={designTheme.finance.savingsSoft}
                    fg={designTheme.finance.savingsText}
                    size={40}
                    iconSize={20}
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text
                      variant="labelSmall"
                      style={{
                        color: designTheme.text.secondary,
                        fontWeight: '600',
                      }}
                    >
                      {vi.overviewTopGoal}
                    </Text>
                    <Text
                      variant="titleMedium"

                      style={{
                        fontWeight: '800',
                        color: designTheme.text.primary,
                      }}
                    >
                      {topGoal.name}
                    </Text>
                  </View>
                </View>
                <Pill
                  label={
                    topGoal.status === 'achieved'
                      ? vi.overviewTopGoalAchieved
                      : `${Math.min(100, Math.round((topGoal.progress / topGoal.target_amount) * 100))}%`
                  }
                  tone={topGoal.status === 'achieved' ? 'income' : 'primary'}
                  size="sm"
                />
              </View>

              <View style={{ marginTop: 12, gap: 6 }}>
                <View style={styles.row}>
                  <Text
                    variant="bodySmall"
                    style={{ color: designTheme.text.secondary }}
                  >
                    {vi.overviewTopGoalProgress}:{' '}
                    <Text
                      style={[
                        styles.number,
                        {
                          fontWeight: '700',
                          color: designTheme.text.primary,
                        },
                      ]}
                    >
                      {hideBalance ? '••••••' : formatVnd(topGoal.progress)}
                    </Text>
                  </Text>
                  <Text
                    variant="bodySmall"
                    style={[styles.number, { color: designTheme.text.muted }]}
                  >
                    / {formatVnd(topGoal.target_amount)}
                  </Text>
                </View>
                <ProgressBar
                  progress={Math.min(
                    1,
                    topGoal.progress / topGoal.target_amount,
                  )}
                  color={
                    topGoal.status === 'achieved'
                      ? designTheme.finance.income
                      : designTheme.brand.primary
                  }
                  style={localStyles.categoryProgressBar}
                />
              </View>
            </GlassCard>
          )}

          {/* Phân tích chi tiêu: positioned right below Thu trừ chi */}
          <GlassCard
            variant="elevated"
            radius="xl"
            padding={18}
            onPress={() =>
              router.navigate({
                pathname: '/budgets',
                params: { tab: 'stats' },
              })
            }
            accessibilityLabel={vi.overviewAnalysis}
          >
            <View style={styles.row}>
              <View style={[styles.inlineRow, { flex: 1 }]}>
                <IconBadge
                  icon="chart-donut"
                  bg={designTheme.brand.primarySoft}
                  fg={designTheme.brand.primaryText}
                  size={42}
                  iconSize={22}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text
                    variant="titleMedium"
                    style={{
                      fontWeight: '800',
                      color: designTheme.text.primary,
                    }}
                  >
                    {vi.overviewAnalysis}
                  </Text>
                  <Text
                    variant="bodySmall"
                    style={{ color: designTheme.text.secondary }}
                  >
                    {vi.overviewAnalysisHint}
                  </Text>
                </View>
              </View>
              <MaterialCommunityIcons
                name="chevron-right"
                size={24}
                color={designTheme.text.muted}
              />
            </View>

            {data.topCategories.length > 0 && (
              <View style={{ marginTop: 14, gap: 8 }}>
                <Divider style={{ backgroundColor: palette.borderSubtle }} />
                <View style={{ gap: 8, marginTop: 4 }}>
                  {data.topCategories.slice(0, 3).map((cat) => {
                    const totalExpense = data.current.expense || 1;
                    const pct = Math.round((cat.amount / totalExpense) * 100);
                    return (
                      <View key={cat.id ?? cat.name} style={{ gap: 4 }}>
                        <View style={styles.row}>
                          <Text
                            variant="labelMedium"

                            style={{
                              color: designTheme.text.primary,
                              fontWeight: '600',
                              flex: 1,
                            }}
                          >
                            {cat.name
                              ? displayCategoryName(cat.name)
                              : vi.transactionUncategorized}
                          </Text>
                          <Text
                            variant="labelMedium"
                            style={[
                              styles.number,
                              {
                                color: designTheme.text.secondary,
                                fontWeight: '700',
                              },
                            ]}
                          >
                            {formatVnd(cat.amount)} ({pct}%)
                          </Text>
                        </View>
                        <ProgressBar
                          progress={Math.min(1, cat.amount / totalExpense)}
                          color={designTheme.brand.primary}
                          style={localStyles.categoryProgressBar}
                        />
                      </View>
                    );
                  })}
                </View>
              </View>
            )}
          </GlassCard>

          {/* Recent Transactions Card (See All) */}
          <GlassCard radius="xl" padding={20}>
            <View style={styles.row}>
              <Text
                variant="titleMedium"
                accessibilityRole="header"
                style={{
                  fontWeight: '800',
                  color: designTheme.text.primary,
                  flex: 1,
                }}
              >
                {vi.overviewRecent}
              </Text>
              <Pill
                label={vi.overviewOpenTransactions}
                tone="primary"
                size="sm"
                icon="chevron-right"
                onPress={() => router.navigate('/transactions')}
              />
            </View>

            <View style={{ marginTop: 14 }}>
              {!data.recent.length ? (
                <EmptyStateCard
                  icon="receipt-text-outline"
                  message={vi.overviewNoTransactions}
                />
              ) : (
                <View style={{ gap: 12 }}>
                  {data.recent.map((row, idx) => {
                    const isIncome = row.kind === 'income';
                    const isExpense = row.kind === 'expense';
                    const isTransfer = row.kind === 'transfer';
                    const badgeBg = isIncome
                      ? designTheme.finance.incomeSoft
                      : isExpense
                        ? designTheme.finance.expenseSoft
                        : designTheme.brand.primarySoft;
                    const badgeFg = isIncome
                      ? designTheme.finance.incomeText
                      : isExpense
                        ? designTheme.finance.expenseText
                        : designTheme.brand.primary;
                    const badgeIcon = isIncome
                      ? 'arrow-bottom-left'
                      : isExpense
                        ? 'arrow-top-right'
                        : isTransfer
                          ? 'swap-horizontal'
                          : 'handshake-outline';
                    const walletName = data.wallets.find(
                      (wallet) => wallet.id === row.wallet_id,
                    )?.name;

                    return (
                      <View key={row.id} style={{ gap: 12 }}>
                        <View style={styles.row}>
                          <View style={[styles.inlineRow, { flex: 1 }]}>
                            <IconBadge
                              icon={badgeIcon}
                              bg={badgeBg}
                              fg={badgeFg}
                              size={44}
                              iconSize={20}
                            />
                            <View style={{ flex: 1, gap: 3 }}>
                              <Text
                                variant="bodyLarge"

                                style={{
                                  fontWeight: '700',
                                  color: designTheme.text.primary,
                                }}
                              >
                                {row.note || transactionLabel(row.kind)}
                              </Text>
                              <Text
                                variant="bodySmall"
                                style={{ color: designTheme.text.muted }}
                              >
                                {formatRecentTransactionTime(
                                  row.occurred_on,
                                  row.occurred_at,
                                  date,
                                )}
                                {walletName ? ` · ${walletName}` : ''}
                              </Text>
                            </View>
                          </View>

                          <View
                            style={{
                              alignItems: 'flex-end',
                              gap: 4,
                              flexShrink: 1,
                              maxWidth: '46%',
                            }}
                          >
                            <Text
                              variant="bodyLarge"

                              minimumFontScale={0.75}
                              style={[
                                styles.number,
                                {
                                  fontWeight: '800',
                                  color: isIncome
                                    ? designTheme.finance.income
                                    : isExpense
                                      ? designTheme.finance.expense
                                      : designTheme.brand.primaryText,
                                },
                              ]}
                            >
                              {isIncome ? '+' : isExpense ? '−' : ''}
                              {formatVnd(row.amount)}
                            </Text>
                            <Pill
                              label={transactionLabel(row.kind)}
                              tone={
                                isIncome
                                  ? 'income'
                                  : isExpense
                                    ? 'expense'
                                    : 'primary'
                              }
                              size="sm"
                              style={{
                                alignSelf: 'flex-end',
                                maxWidth: '100%',
                              }}
                            />
                          </View>
                        </View>
                        {idx < data.recent.length - 1 && (
                          <Divider
                            style={{ backgroundColor: palette.borderSubtle }}
                          />
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          </GlassCard>
        </>
      )}
    </Screen>
  );
}

/**
 * Resolves the localized label for a transaction kind.
 */
function transactionLabel(kind: TransactionInput['kind']) {
  return kind === 'expense'
    ? vi.transactionExpense
    : kind === 'income'
      ? vi.transactionIncome
      : kind === 'transfer'
        ? vi.transactionTransfer
        : (DEBT_KIND_LABELS[kind] ?? vi.overviewDebtTransaction);
}

const localStyles = StyleSheet.create({
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: DesignSpacing.sm,
    paddingTop: 4,
  },
  greetingGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DesignSpacing.sm,
    flex: 1,
  },
  avatarCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  verticalHeaderButtons: {
    flexDirection: 'column',
    gap: 2,
    width: 56,
    padding: 5,
    borderWidth: 1,
    borderRadius: DesignRadius.pill,
  },
  circleHeaderBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerBox: {
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTopRow: {
    alignItems: 'stretch',
    justifyContent: 'space-between',
    gap: 12,
  },
  balanceTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  eyeIconButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
    borderRadius: DesignRadius.pill,
  },
  heroIncomeExpenseBlock: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  heroStatPill: {
    flex: 1,
    minWidth: 120,
    flexWrap: 'wrap',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
  },
  heroStatNumber: {
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '800',
  },
  heroBalanceText: {
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  walletsStrip: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: 16,
    paddingRight: 4,
  },
  walletMiniCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: DesignRadius.md,
    borderWidth: 1,
    width: 210,
    flexShrink: 0,
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  summaryCardItem: {
    flexGrow: 1,
    flexBasis: '47%',
    minWidth: 150,
  },
  summaryCardWide: {
    flexGrow: 0,
    flexBasis: '100%',
  },
  summaryIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  categoryProgressBar: {
    height: 6,
    borderRadius: 3,
  },
});
