import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useFocusEffect, useRouter } from 'expo-router';
import { monthKey, today } from '@pfm/domain';
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
  ProgressBar,
  Text,
} from 'react-native-paper';
import {
  EmptyStateCard,
  IconBadge,
  Screen,
  styles,
} from '@/components/screen';
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
import { readDashboard, type Dashboard } from '@/data/dashboard';
import { DEBT_KIND_LABELS } from '@/features/debts/labels';
import { NotificationsView } from '@/features/notifications/notifications-view';
import { vi } from '@/messages/vi';
import { displayCategoryName, displayWalletName } from '@/messages/seed-labels';
import { useApp } from '@/state/app';
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
  onGoals: _onGoals,
}: {
  onWallets(): void;
  onGoals?(): void;
}) {
  const [date, setDate] = useState(localToday);
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const request = useRef(0);
  const hasLoadedOnce = useRef(false);
  const recurringVersion = useApp((state) => state.recurringVersion);
  const palette = useFinancePalette();
  const designTheme = useDesignTheme();
  const { isDuoClosedPortrait } = useResponsiveLayout();
  const router = useRouter();

  const load = useCallback(async (showSpinner = false) => {
    const id = ++request.current;
    if (showSpinner || !hasLoadedOnce.current) {
      setLoading(true);
    }
    setError(false);
    try {
      const currentMonth = monthKey(localToday());
      const next = await withDatabase((db) => readDashboard(db, currentMonth));
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
  }, []);

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
        onPress={() => setShowNotifications(true)}
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
      hideHeader
      rightRail={isDuoClosedPortrait ? headerActions : undefined}
    >
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

        {!isDuoClosedPortrait && headerActions}
      </View>

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
                            numberOfLines={1}
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
  categoryProgressBar: {
    height: 6,
    borderRadius: 3,
  },
});
