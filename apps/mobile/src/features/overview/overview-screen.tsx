import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  addMonths,
  goalProgress,
  monthKey,
  today,
} from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import type { TransactionInput } from '@pfm/contracts';
import { useCallback, useRef, useState } from 'react';
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
  IconButton,
  ProgressBar,
  Text,
  useTheme,
} from 'react-native-paper';
import {
  EmptyStateCard,
  IconBadge,
  Screen,
  StatusPill,
  styles,
} from '@/components/screen';
import { AIOrb, GlassCard, Pill } from '@/components/ui';
import {
  createSoftShadow,
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
  walletKindVisual,
} from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import { readDashboard, type Dashboard } from '@/data/dashboard';
import { DEBT_KIND_LABELS } from '@/features/debts/labels';
import { NotificationsView } from '@/features/notifications/notifications-view';
import { vi } from '@/messages/vi';
import { displayCategoryName, displayWalletName } from '@/messages/seed-labels';
import { useApp } from '@/state/app';
import { usePreferences } from '@/state/preferences';
import { formatDisplayMonth } from '@/utils/display';
import { formatRecentTransactionTime } from './transaction-time';

const localToday = () =>
  today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' });

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
  onGoals,
}: {
  onWallets(): void;
  onGoals(): void;
}) {
  const [month, setMonth] = useState(() => monthKey(localToday()));
  const [date, setDate] = useState(localToday);
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const request = useRef(0);
  const hasLoadedOnce = useRef(false);
  const recurringVersion = useApp((state) => state.recurringVersion);
  const requestAddTransaction = usePreferences(
    (state) => state.requestAddTransaction,
  );
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const designTheme = useDesignTheme();
  const router = useRouter();
  const currentMonthKey = monthKey(localToday());

  const load = useCallback(
    async (showSpinner = false) => {
      const id = ++request.current;
      if (showSpinner || !hasLoadedOnce.current) {
        setLoading(true);
      }
      setError(false);
      try {
        const next = await withDatabase((db) => readDashboard(db, month));
        if (id !== request.current) return;
        hasLoadedOnce.current = true;
        setDate(localToday());
        setData(next);
        useApp.setState({
          wallets: next.wallets.filter((wallet) => !wallet.is_archived),
        });
      } catch {
        if (id === request.current) setError(true);
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [month],
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

  const activeWallets =
    data?.wallets.filter((wallet) => !wallet.is_archived) ?? [];

  if (showNotifications) {
    return <NotificationsView onClose={() => setShowNotifications(false)} />;
  }

  return (
    <Screen title={vi.overviewTitle} hideHeader>
      {/* Top Header: Avatar + Greeting + 2 Circular Action Buttons */}
      <View style={localStyles.topHeader}>
        <View style={localStyles.greetingGroup}>
          <View
            style={[
              localStyles.avatarCircle,
              createSoftShadow(designTheme.mode, 'sm'),
              { backgroundColor: designTheme.brand.primary },
            ]}
          >
            <MaterialCommunityIcons
              name="wallet-bifold-outline"
              size={22}
              color={designTheme.text.onPrimary}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text
              variant="labelMedium"
              style={{ color: designTheme.text.secondary, fontWeight: '600' }}
            >
              {vi.appName}
            </Text>
            <Text
              accessibilityRole="header"
              variant="titleLarge"
              style={{
                color: designTheme.text.primary,
                fontWeight: '800',
                letterSpacing: -0.4,
              }}
            >
              {vi.overviewTitle}
            </Text>
          </View>
        </View>

        <View style={localStyles.headerButtons}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={vi.transactionFilters}
            onPress={() => router.navigate('/transactions')}
            style={({ pressed }) => [
              localStyles.circleHeaderBtn,
              createSoftShadow(designTheme.mode, 'sm'),
              {
                backgroundColor: designTheme.card.surfaceElevated,
                borderColor: designTheme.card.border,
                opacity: pressed ? 0.78 : 1,
              },
            ]}
          >
            <MaterialCommunityIcons
              name="magnify"
              size={21}
              color={designTheme.text.primary}
            />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={vi.notificationsTitle}
            onPress={() => setShowNotifications(true)}
            style={({ pressed }) => [
              localStyles.circleHeaderBtn,
              createSoftShadow(designTheme.mode, 'sm'),
              {
                backgroundColor: designTheme.card.surfaceElevated,
                borderColor: designTheme.card.border,
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
      </View>

      {/* Glassmorphic Month Selector Pill Bar */}
      <GlassCard radius="xl" padding={8} style={localStyles.monthBar}>
        <View style={styles.inlineRow}>
          <IconButton
            icon="chevron-left"
            size={20}
            style={localStyles.monthNavBtn}
            accessibilityLabel={vi.budgetPreviousMonth}
            disabled={month <= '0001-06'}
            onPress={() => setMonth(monthKey(addMonths(`${month}-01`, -1)))}
          />
          <Text
            variant="titleMedium"
            accessibilityLiveRegion="polite"
            style={[
              styles.number,
              { fontWeight: '800', color: designTheme.text.primary },
            ]}
          >
            {formatDisplayMonth(month)}
          </Text>
          <IconButton
            icon="chevron-right"
            size={20}
            style={localStyles.monthNavBtn}
            accessibilityLabel={vi.budgetNextMonth}
            disabled={month >= '9999-12'}
            onPress={() => setMonth(monthKey(addMonths(`${month}-01`, 1)))}
          />
        </View>
        <Pill
          label={vi.overviewCurrentMonth}
          tone={month === currentMonthKey ? 'primary' : 'glass'}
          size="sm"
          onPress={
            month === currentMonthKey
              ? undefined
              : () => setMonth(currentMonthKey)
          }
        />
      </GlassCard>

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
          {/* Hero Total Balance Card */}
          <GlassCard variant="elevated" radius="xl" padding={22}>
            <View style={localStyles.heroTopRow}>
              <View style={{ flex: 1, gap: 6 }}>
                <Text
                  variant="labelLarge"
                  style={{
                    color: designTheme.text.secondary,
                    fontWeight: '600',
                  }}
                >
                  {vi.overviewLiveBalance}
                </Text>
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.7}
                  style={[
                    styles.number,
                    localStyles.heroBalanceText,
                    { color: designTheme.text.primary },
                  ]}
                >
                  {formatVnd(data.balance)}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={vi.addTransaction}
                onPress={() => {
                  requestAddTransaction('manual');
                  router.navigate('/transactions');
                }}
                style={({ pressed }) => [
                  localStyles.heroAddCircle,
                  createSoftShadow(designTheme.mode, 'md'),
                  {
                    backgroundColor: designTheme.brand.primary,
                    opacity: pressed ? 0.85 : 1,
                    transform: [{ scale: pressed ? 0.95 : 1 }],
                  },
                ]}
              >
                <MaterialCommunityIcons
                  name="plus"
                  size={26}
                  color={designTheme.text.onPrimary}
                />
              </Pressable>
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
                        {
                          backgroundColor: designTheme.card.surfaceSubtle,
                          borderColor: designTheme.card.border,
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
                          numberOfLines={1}
                          style={{
                            color: designTheme.text.secondary,
                            fontWeight: '600',
                          }}
                        >
                          {displayWalletName(wallet.name)}
                        </Text>
                        <Text
                          variant="bodyMedium"
                          numberOfLines={1}
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
                          {formatVnd(wallet.balance)}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </GlassCard>

          {/* Income / expense cards use two columns so exact VND amounts fit on 375pt. */}
          <View style={localStyles.summaryGrid}>
            <GlassCard
              radius="lg"
              padding={14}
              style={localStyles.summaryCardItem}
            >
              <View style={localStyles.summaryIconRow}>
                <IconBadge
                  icon="arrow-bottom-left"
                  bg={designTheme.finance.incomeSoft}
                  fg={designTheme.finance.incomeText}
                  size={34}
                  iconSize={18}
                />
                <Pill
                  label={changeLabel(data.incomeChangeBps)}
                  tone="income"
                  size="sm"
                />
              </View>
              <Text
                variant="labelMedium"
                numberOfLines={1}
                style={{ color: designTheme.text.secondary, marginTop: 8 }}
              >
                {vi.transactionIncome}
              </Text>
              <Text
                variant="titleSmall"
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
                style={[
                  styles.number,
                  {
                    color: designTheme.finance.income,
                    fontWeight: '800',
                    marginTop: 2,
                  },
                ]}
              >
                +{formatVnd(data.current.income)}
              </Text>
            </GlassCard>

            <GlassCard
              radius="lg"
              padding={14}
              style={localStyles.summaryCardItem}
            >
              <View style={localStyles.summaryIconRow}>
                <IconBadge
                  icon="arrow-top-right"
                  bg={designTheme.finance.expenseSoft}
                  fg={designTheme.finance.expenseText}
                  size={34}
                  iconSize={18}
                />
                <Pill
                  label={changeLabel(data.expenseChangeBps)}
                  tone="expense"
                  size="sm"
                />
              </View>
              <Text
                variant="labelMedium"
                numberOfLines={1}
                style={{ color: designTheme.text.secondary, marginTop: 8 }}
              >
                {vi.transactionExpense}
              </Text>
              <Text
                variant="titleSmall"
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
                style={[
                  styles.number,
                  {
                    color: designTheme.finance.expense,
                    fontWeight: '800',
                    marginTop: 2,
                  },
                ]}
              >
                {formatVnd(data.current.expense)}
              </Text>
            </GlassCard>

            {/* Net is a full-width, low-height row so it cannot squeeze the two values above. */}
            <GlassCard
              radius="lg"
              padding={14}
              style={[localStyles.summaryCardItem, localStyles.summaryCardWide]}
            >
              <View style={styles.row}>
                <View style={styles.inlineRow}>
                  <IconBadge
                    icon="piggy-bank-outline"
                    bg={designTheme.finance.savingsSoft}
                    fg={designTheme.finance.savingsText}
                    size={34}
                    iconSize={18}
                  />
                  <Text
                    variant="labelLarge"
                    style={{ color: designTheme.text.secondary }}
                  >
                    {vi.overviewNet}
                  </Text>
                </View>
                <Text
                  variant="titleMedium"
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.8}
                  style={[
                    styles.number,
                    {
                      color:
                        data.current.net >= 0
                          ? designTheme.brand.primaryText
                          : designTheme.finance.expense,
                      fontWeight: '800',
                    },
                  ]}
                >
                  {data.current.net > 0 ? '+' : ''}
                  {formatVnd(data.current.net)}
                </Text>
              </View>
            </GlassCard>
          </View>

          {/* AI Assistant Card with Holographic Skia AIOrb */}
          <GlassCard
            variant="elevated"
            radius="xl"
            padding={18}
            onPress={() => router.navigate('/chat')}
            accessibilityLabel={vi.chat}
          >
            <View style={localStyles.aiCardRow}>
              <AIOrb size={62} />
              <View style={{ flex: 1, gap: 4 }}>
                <View style={styles.inlineRow}>
                  <Pill label={vi.appName} tone="primary" size="sm" />
                  <Text
                    variant="titleMedium"
                    style={{
                      color: designTheme.text.primary,
                      fontWeight: '800',
                    }}
                  >
                    {vi.chat}
                  </Text>
                </View>
                <Text
                  variant="bodySmall"
                  numberOfLines={3}
                  style={{
                    color: designTheme.text.secondary,
                    lineHeight: 18,
                  }}
                >
                  {vi.chatEmpty}
                </Text>
              </View>
              <View
                style={[
                  localStyles.aiGoCircle,
                  { backgroundColor: designTheme.brand.primary },
                ]}
              >
                <MaterialCommunityIcons
                  name="arrow-top-right"
                  size={20}
                  color={designTheme.text.onPrimary}
                />
              </View>
            </View>

            <View style={localStyles.aiChipsRow}>
              <Pill
                icon="lightning-bolt-outline"
                label={vi.quickTitle}
                tone="glass"
                size="sm"
                onPress={() => {
                  requestAddTransaction('natural');
                  router.navigate('/transactions');
                }}
              />
              <Pill
                icon="bullseye-arrow"
                label={vi.goals}
                tone="glass"
                size="sm"
                onPress={onGoals}
              />
              <Pill
                icon="chart-pie"
                label={vi.overviewBudgets}
                tone="glass"
                size="sm"
                onPress={() =>
                  router.navigate({
                    pathname: '/budgets',
                    params: { tab: 'budgets' },
                  })
                }
              />
            </View>
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
                                numberOfLines={1}
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
                              numberOfLines={1}
                              adjustsFontSizeToFit
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

          {/* Analytics moved to the Statistics tab; keep one lightweight entry point here. */}
          <GlassCard
            variant="elevated"
            radius="xl"
            padding={18}
            onPress={() => router.navigate('/budgets')}
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
                      fontWeight: '700',
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
          </GlassCard>

          {/* Monthly Budgets Summary Card */}
          <GlassCard radius="xl" padding={20}>
            <View style={styles.row}>
              <Text
                variant="titleMedium"
                accessibilityRole="header"
                style={{ fontWeight: '800', flex: 1 }}
              >
                {vi.overviewBudgets}
              </Text>
              <Pill
                label={vi.overviewOpenBudgets}
                tone="primary"
                size="sm"
                onPress={() =>
                  router.navigate({
                    pathname: '/budgets',
                    params: { tab: 'budgets' },
                  })
                }
              />
            </View>
            <View style={{ marginTop: 12 }}>
              {!data.budgets.length ? (
                <EmptyStateCard
                  icon="chart-arc"
                  message={vi.overviewNoBudgets}
                />
              ) : (
                <View style={{ gap: 12 }}>
                  {data.budgets.map((budget) => {
                    const ratio = Math.min(1, budget.spent / budget.amount);
                    const pct = Math.round(
                      (budget.spent / budget.amount) * 100,
                    );
                    return (
                      <View
                        key={budget.id}
                        style={[
                          styles.subtlePanel,
                          {
                            backgroundColor: designTheme.card.surfaceSubtle,
                            borderColor: designTheme.card.border,
                          },
                        ]}
                      >
                        <View style={styles.row}>
                          <Text
                            variant="titleSmall"
                            style={{ fontWeight: '700', flex: 1 }}
                          >
                            {budget.category_name ? displayCategoryName(budget.category_name) : vi.budgetOverall}
                          </Text>
                          <StatusPill
                            label={`${pct}%`}
                            bg={
                              pct >= 100
                                ? palette.dangerSoft
                                : pct >= 80
                                  ? palette.warningSoft
                                  : palette.primarySoft
                            }
                            fg={
                              pct >= 100
                                ? palette.dangerInk
                                : pct >= 80
                                  ? palette.warningInk
                                  : palette.primaryInk
                            }
                          />
                        </View>
                        <Text
                          variant="bodySmall"
                          style={[styles.number, { color: palette.textMuted }]}
                        >
                          {formatVnd(budget.spent)} / {formatVnd(budget.amount)}
                        </Text>
                        <ProgressBar
                          progress={ratio}
                          color={
                            pct >= 100
                              ? colors.error
                              : pct >= 80
                                ? palette.warning
                                : colors.primary
                          }
                          style={localStyles.progressBar}
                          accessibilityLabel={
                            budget.category_name ? displayCategoryName(budget.category_name) : vi.budgetOverall
                          }
                          accessibilityValue={{
                            min: 0,
                            max: budget.amount,
                            now: Math.min(budget.spent, budget.amount),
                          }}
                        />
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          </GlassCard>

          {/* Current Savings Goals Card */}
          <GlassCard radius="xl" padding={20}>
            <View style={styles.row}>
              <Text
                variant="titleMedium"
                accessibilityRole="header"
                style={{ fontWeight: '800', flex: 1 }}
              >
                {vi.overviewCurrentGoals}
              </Text>
              <Pill
                label={vi.viewAll}
                tone="primary"
                size="sm"
                onPress={onGoals}
              />
            </View>
            <View style={{ marginTop: 12 }}>
              {!data.goals.length ? (
                <EmptyStateCard icon="bullseye-arrow" message={vi.goalEmpty} />
              ) : (
                <View style={{ gap: 12 }}>
                  {data.goals.map((goal) => {
                    const progress = goalProgress(
                      goal.target_amount,
                      goal.progress,
                      date,
                      goal.deadline_on,
                    );
                    const ratio = Math.max(
                      0,
                      Math.min(1, goal.progress / goal.target_amount),
                    );
                    return (
                      <View
                        key={goal.id}
                        style={[
                          styles.subtlePanel,
                          {
                            backgroundColor: designTheme.card.surfaceSubtle,
                            borderColor: designTheme.card.border,
                          },
                        ]}
                      >
                        <View style={styles.row}>
                          <Text
                            variant="titleSmall"
                            style={{ fontWeight: '700', flex: 1 }}
                          >
                            {goal.name}
                          </Text>
                          {progress.achieved && (
                            <StatusPill
                              icon="check-circle"
                              label={vi.goalAchieved}
                              bg={palette.incomeSoft}
                              fg={palette.incomeInk}
                            />
                          )}
                        </View>
                        <Text
                          variant="bodySmall"
                          style={[styles.number, { color: palette.textMuted }]}
                        >
                          {formatVnd(goal.progress)} /{' '}
                          {formatVnd(goal.target_amount)}
                        </Text>
                        <ProgressBar
                          progress={ratio}
                          color={
                            progress.achieved ? palette.income : colors.primary
                          }
                          style={localStyles.progressBar}
                        />
                        {!progress.achieved &&
                          progress.requiredPerMonth !== null && (
                            <Text
                              variant="bodySmall"
                              style={{ color: palette.textMuted }}
                            >
                              {vi.goalMonthly}:{' '}
                              <Text
                                variant="bodySmall"
                                style={[styles.number, { fontWeight: '700' }]}
                              >
                                {formatVnd(progress.requiredPerMonth)}
                              </Text>
                            </Text>
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
  circleHeaderBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  monthNavBtn: {
    margin: 0,
  },
  centerBox: {
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  heroBalanceText: {
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  heroAddCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
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
    width: 170,
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
    minWidth: 0,
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
  aiCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  aiGoCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  progressBar: {
    height: 8,
    borderRadius: 4,
  },
});
