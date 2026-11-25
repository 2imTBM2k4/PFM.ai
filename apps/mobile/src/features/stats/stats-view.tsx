import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PixelRatio,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { ActivityIndicator, Button, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import MaterialCommunityIcons from '@/components/platform-icon';
import { EmptyStateCard, Screen, styles } from '@/components/screen';
import { GlassCard } from '@/components/ui';
import { useResponsiveLayout } from '@/constants/responsive-layout';
import {
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import {
  readIncomeExpenseSituation,
  type IncomeExpenseSituation,
} from '@/data/stats';
import { useAccessibilityPreferences } from '@/hooks/use-accessibility-preferences';
import { useCurrentDate } from '@/hooks/use-current-date';
import { useTabBarScroll } from '@/hooks/use-tab-bar-scroll';
import { displayCategoryName } from '@/messages/seed-labels';
import { vi } from '@/messages/vi';
import { useApp } from '@/state/app';
import {
  formatCurrencyAmount,
  usePreferences,
} from '@/state/preferences';
import { shiftMonthKey } from '@/utils/calendar';
import { AllocationDonutChart } from './allocation-donut-chart';
import { FloatingGlassControl } from './floating-glass-control';
import {
  getStatsResponsiveProfile,
  STATS_MIN_TOUCH_TARGET,
} from './stats-layout';
import { buildDonutBreakdown } from './stats-summary';

const MASKED_AMOUNT = '••••••';

interface StatsViewProps {
  onOpenTrend?(): void;
  onOpenBudgets?(): void;
  onOpenCalendar?(): void;
  onOpenGoals?(): void;
  onSwitchToBudgets?(): void;
  onSwitchTab?(tab: 'budgets' | 'goals' | 'stats'): void;
}

/**
 * Primary Statistics screen featuring quick Financial Utilities (Trends, Budgets, Calendar, Goals)
 * and an interactive monthly Income & Expense Situation card with Donut breakdown and AI prompt bar.
 */
export function StatsView({
  onOpenTrend,
  onOpenBudgets,
  onOpenCalendar,
  onOpenGoals,
  onSwitchToBudgets,
  onSwitchTab,
}: StatsViewProps) {
  const theme = useDesignTheme();
  const palette = useFinancePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarScroll = useTabBarScroll();
  const currentDate = useCurrentDate();
  const previousDate = useRef(currentDate);
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
  const openChat = usePreferences((state) => state.openChat);
  const openChatWithPrompt = usePreferences(
    (state) => state.openChatWithPrompt,
  );
  const currency = usePreferences((state) => state.currency);
  const language = usePreferences((state) => state.language);
  const recurringVersion = useApp((state) => state.recurringVersion);
  const isAddOpen = usePreferences((state) => state.isAddTransactionOpen);

  const [month, setMonth] = useState(() => currentDate.slice(0, 7));
  const [selectedKind, setSelectedKind] = useState<'expense' | 'income'>(
    'expense',
  );
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  );
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  const [data, setData] = useState<IncomeExpenseSituation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [containerWidth, setContainerWidth] = useState(343);

  const reqRef = useRef(0);
  const wasAddOpen = useRef(isAddOpen);
  const prevRecurring = useRef(recurringVersion);

  useEffect(() => {
    const prevMonth = previousDate.current.slice(0, 7);
    setMonth((curr) => (curr === prevMonth ? currentDate.slice(0, 7) : curr));
    previousDate.current = currentDate;
  }, [currentDate]);

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading((prev) => (data === null ? true : prev));
    setError('');
    try {
      const next = await withDatabase((db) =>
        readIncomeExpenseSituation(db, month, currentDate),
      );
      if (req !== reqRef.current) return;
      setData(next);
    } catch {
      if (req === reqRef.current) setError(vi.transactionsLoadError);
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve loaded UI across month transitions.
  }, [currentDate, month]);

  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(() => {
        void load();
      });
      return () => cancelAnimationFrame(frame);
    }, [load]),
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const addClosed = wasAddOpen.current && !isAddOpen;
      const recurringChanged = prevRecurring.current !== recurringVersion;
      wasAddOpen.current = isAddOpen;
      prevRecurring.current = recurringVersion;
      if (addClosed || recurringChanged) {
        void load();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [isAddOpen, load, recurringVersion]);

  const openTrendScreen = () => {
    if (onOpenTrend) {
      onOpenTrend();
      return;
    }
    router.push({ pathname: '/detail', params: { screen: 'stats-trend' } });
  };

  const openBudgetsScreen = () => {
    if (onOpenBudgets) {
      onOpenBudgets();
      return;
    }
    if (onSwitchToBudgets) {
      onSwitchToBudgets();
      return;
    }
    if (onSwitchTab) {
      onSwitchTab('budgets');
      return;
    }
    router.push({ pathname: '/detail', params: { screen: 'budgets' } });
  };

  const openCalendarScreen = () => {
    if (onOpenCalendar) {
      onOpenCalendar();
      return;
    }
    router.push({ pathname: '/detail', params: { screen: 'stats-calendar' } });
  };

  const openGoalsScreen = () => {
    if (onOpenGoals) {
      onOpenGoals();
      return;
    }
    router.push({
      pathname: '/detail',
      params: { screen: 'goals', from: 'budgets' },
    });
  };

  const formatAmount = (amountVnd: number) =>
    hideBalance ? MASKED_AMOUNT : formatCurrencyAmount(amountVnd, currency);

  const rawCategories = useMemo(() => {
    if (!data) return [];
    const list =
      selectedKind === 'expense'
        ? data.expenseCategories
        : data.incomeCategories;
    return list.map((row) => ({
      ...row,
      name: row.name ? displayCategoryName(row.name, language) : null,
    }));
  }, [data, language, selectedKind]);

  const breakdown = useMemo(
    () =>
      buildDonutBreakdown(
        rawCategories,
        vi.transactionUncategorized,
        vi.statsOtherCategories,
      ),
    [rawCategories],
  );

  const monthShort = `${Number(month.slice(5, 7))}/${month.slice(0, 4)}`;
  const monthBanner = vi.statsMonthBanner.replace('{value}', monthShort);

  const comparison = useMemo(() => {
    if (!data) {
      return {
        text: vi.statsCompareNoPrev,
        color: theme.text.secondary,
        prefix: '',
        amountPart: '',
        suffix: '',
      };
    }
    const prev =
      selectedKind === 'expense'
        ? data.previousPeriodExpense
        : data.previousPeriodIncome;
    const delta =
      selectedKind === 'expense' ? data.expenseDelta : data.incomeDelta;

    if (prev <= 0) {
      return {
        text: vi.statsCompareNoPrev,
        color: theme.text.secondary,
        prefix: vi.statsCompareNoPrev,
        amountPart: '',
        suffix: '',
      };
    }
    if (delta === 0) {
      return {
        text: vi.statsCompareFlat,
        color: theme.text.secondary,
        prefix: vi.statsCompareFlat,
        amountPart: '',
        suffix: '',
      };
    }

    const isPositiveDelta = delta > 0;
    const template = isPositiveDelta ? vi.statsCompareUp : vi.statsCompareDown;
    const formattedDelta = formatAmount(Math.abs(delta));
    const [prefix, suffix = ''] = template.split('{amount}');

    // Lower expense or higher income is favorable (green); inverse is coral.
    const isFavorable =
      selectedKind === 'expense' ? delta < 0 : delta > 0;
    const highlightColor = isFavorable
      ? theme.finance.incomeText
      : theme.finance.expenseText;

    return {
      text: `${prefix}${formattedDelta}${suffix}`,
      color: highlightColor,
      prefix,
      amountPart: formattedDelta,
      suffix,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatAmount depends on hideBalance & currency already listed.
  }, [
    data,
    hideBalance,
    currency,
    selectedKind,
    theme.finance.expenseText,
    theme.finance.incomeText,
    theme.text.secondary,
  ]);

  const wrapUtilitiesGrid = profile.reflowLargeText || containerWidth < 310;

  const utilities = [
    {
      key: 'trend',
      label: vi.statsUtilTrend,
      icon: 'trending-up' as const,
      bg: palette.primarySoft,
      fg: theme.brand.primaryStrong,
      onPress: openTrendScreen,
    },
    {
      key: 'budgets',
      label: vi.statsUtilBudgets,
      icon: 'cash-multiple' as const,
      bg: palette.incomeSoft,
      fg: theme.finance.incomeText,
      onPress: openBudgetsScreen,
    },
    {
      key: 'calendar',
      label: vi.statsUtilCalendar,
      icon: 'calendar-month-outline' as const,
      bg: palette.expenseSoft,
      fg: theme.finance.expenseText,
      onPress: openCalendarScreen,
    },
    {
      key: 'goals',
      label: vi.statsUtilGoals,
      icon: 'bullseye-arrow' as const,
      bg: palette.purpleSoft,
      fg: palette.purple,
      onPress: openGoalsScreen,
    },
  ];

  const handleSelectKind = (kind: 'expense' | 'income') => {
    setSelectedKind(kind);
    setSelectedCategoryId(null);
  };

  const handleSelectSlice = (id: string) => {
    setSelectedCategoryId((prev) => (prev === id ? null : id));
    setDetailsExpanded(true);
  };

  const promptChipShort =
    selectedKind === 'expense'
      ? vi.statsAiPromptExpense.replace('{month}', monthShort)
      : vi.statsAiPromptIncome.replace('{month}', monthShort);
  const promptChipFull =
    selectedKind === 'expense'
      ? vi.statsAiPromptExpenseFull.replace('{month}', monthShort)
      : vi.statsAiPromptIncomeFull.replace('{month}', monthShort);

  const renderTrendArrowBadge = (
    delta: number,
    prevAmount: number,
    kind: 'expense' | 'income',
  ) => {
    if (prevAmount <= 0 || delta === 0) return null;
    const isUp = delta > 0;
    const isFavorable = kind === 'expense' ? !isUp : isUp;
    const bg = isFavorable ? palette.incomeSoft : palette.expenseSoft;
    const fg = isFavorable
      ? theme.finance.incomeText
      : theme.finance.expenseText;

    return (
      <View style={[localStyles.deltaBadge, { backgroundColor: bg }]}>
        <MaterialCommunityIcons
          name={isUp ? 'arrow-up' : 'arrow-down'}
          size={11}
          color={fg}
        />
      </View>
    );
  };

  const cardBorderWidth = profile.highContrast ? 1.5 : 1;

  const utilitiesCard = (
    <GlassCard variant="elevated" radius="xl" padding={DesignSpacing.md}>
      <Text
        variant="labelLarge"
        style={{
          color: theme.text.secondary,
          fontWeight: '700',
          marginBottom: 10,
          paddingHorizontal: 4,
        }}
      >
        {vi.statsUtilitiesTitle}
      </Text>
      <View
        style={[
          localStyles.utilitiesRow,
          wrapUtilitiesGrid && localStyles.utilitiesWrap,
        ]}
      >
        {utilities.map((item) => (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityLabel={item.label.replace(/\n/g, ' ')}
            onPress={item.onPress}
            style={({ pressed }) => [
              localStyles.utilityTile,
              wrapUtilitiesGrid && localStyles.utilityTileWrapped,
              pressed && { opacity: 0.78 },
            ]}
          >
            <View
              style={[
                localStyles.utilityIconWrap,
                { backgroundColor: item.bg },
              ]}
            >
              <MaterialCommunityIcons
                name={item.icon}
                size={22}
                color={item.fg}
              />
            </View>
            <Text
              variant="labelSmall"
              style={[
                localStyles.utilityLabel,
                { color: theme.text.primary },
              ]}
              numberOfLines={2}
            >
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </GlassCard>
  );

  const situationHeader = (
    <View style={localStyles.sectionHeader}>
      <Text
        variant="titleMedium"
        style={{ color: theme.text.primary, fontWeight: '800', flexShrink: 1 }}
      >
        {vi.statsSituationTitle}
      </Text>
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
          color={theme.brand.primaryStrong}
        />
      </FloatingGlassControl>
    </View>
  );

  const monthNavigator = (
    <View style={localStyles.monthNavRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={vi.statsPreviousMonthA11y}
        onPress={() => {
          setSelectedCategoryId(null);
          setMonth((m) => shiftMonthKey(m, -1, currentDate.slice(0, 7)));
        }}
        style={localStyles.monthArrowBtn}
      >
        <MaterialCommunityIcons
          name="chevron-left"
          size={22}
          color={theme.text.primary}
        />
      </Pressable>

      <View style={localStyles.monthCenterLabel}>
        <MaterialCommunityIcons
          name="calendar-month-outline"
          size={16}
          color={theme.text.primary}
        />
        <Text
          variant="titleSmall"
          style={{ color: theme.text.primary, fontWeight: '700' }}
        >
          {monthBanner}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={vi.statsNextMonthA11y}
        onPress={() => {
          setSelectedCategoryId(null);
          setMonth((m) => shiftMonthKey(m, 1, currentDate.slice(0, 7)));
        }}
        style={localStyles.monthArrowBtn}
      >
        <MaterialCommunityIcons
          name="chevron-right"
          size={22}
          color={theme.text.primary}
        />
      </Pressable>
    </View>
  );

  const errorBlock = (
    <View style={localStyles.errorBox}>
      <Text
        accessibilityRole="alert"
        variant="bodyMedium"
        style={{ color: palette.danger, textAlign: 'center' }}
      >
        {error}
      </Text>
      <Button mode="outlined" onPress={() => void load()}>
        {vi.retry}
      </Button>
    </View>
  );

  const kindCardsBlock = (
    <View
      style={[
        localStyles.kindCardsRow,
        profile.reflowLargeText && { flexDirection: 'column' },
      ]}
    >
      {/* Expense Card */}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: selectedKind === 'expense' }}
        accessibilityLabel={`${vi.transactionExpense}: ${formatAmount(data?.expenseTotal ?? 0)}`}
        onPress={() => handleSelectKind('expense')}
        style={[
          localStyles.kindCard,
          {
            backgroundColor:
              selectedKind === 'expense'
                ? theme.card.surfaceElevated
                : theme.card.surfaceSubtle,
            borderColor:
              selectedKind === 'expense'
                ? theme.brand.primary
                : theme.card.border,
            borderWidth: selectedKind === 'expense' ? 2 : cardBorderWidth,
          },
        ]}
      >
        <View style={localStyles.kindLabelRow}>
          <View
            style={[
              localStyles.kindIconCircle,
              { backgroundColor: theme.brand.primarySoft },
            ]}
          >
            <MaterialCommunityIcons
              name="arrow-top-right"
              size={12}
              color={theme.brand.primaryStrong}
            />
          </View>
          <Text
            variant="labelLarge"
            style={{
              color: theme.text.secondary,
              fontWeight: '600',
              flexShrink: 1,
            }}
            numberOfLines={profile.reflowLargeText ? 2 : 1}
          >
            {vi.transactionExpense}
          </Text>
          {data &&
            renderTrendArrowBadge(
              data.expenseDelta,
              data.previousPeriodExpense,
              'expense',
            )}
          {selectedKind === 'expense' && (
            <MaterialCommunityIcons
              name="check-circle-outline"
              size={15}
              color={theme.brand.primaryStrong}
            />
          )}
        </View>
        <Text
          variant="titleMedium"
          style={[
            styles.number,
            { color: theme.text.primary, fontWeight: '800' },
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.75}
        >
          {formatAmount(data?.expenseTotal ?? 0)}
        </Text>
      </Pressable>

      {/* Income Card */}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: selectedKind === 'income' }}
        accessibilityLabel={`${vi.transactionIncome}: ${formatAmount(data?.incomeTotal ?? 0)}`}
        onPress={() => handleSelectKind('income')}
        style={[
          localStyles.kindCard,
          {
            backgroundColor:
              selectedKind === 'income'
                ? theme.card.surfaceElevated
                : theme.card.surfaceSubtle,
            borderColor:
              selectedKind === 'income'
                ? theme.brand.primary
                : theme.card.border,
            borderWidth: selectedKind === 'income' ? 2 : cardBorderWidth,
          },
        ]}
      >
        <View style={localStyles.kindLabelRow}>
          <View
            style={[
              localStyles.kindIconCircle,
              { backgroundColor: palette.incomeSoft },
            ]}
          >
            <MaterialCommunityIcons
              name="arrow-bottom-left"
              size={12}
              color={theme.finance.incomeText}
            />
          </View>
          <Text
            variant="labelLarge"
            style={{
              color: theme.text.secondary,
              fontWeight: '600',
              flexShrink: 1,
            }}
            numberOfLines={profile.reflowLargeText ? 2 : 1}
          >
            {vi.transactionIncome}
          </Text>
          {data &&
            renderTrendArrowBadge(
              data.incomeDelta,
              data.previousPeriodIncome,
              'income',
            )}
          {selectedKind === 'income' && (
            <MaterialCommunityIcons
              name="check-circle-outline"
              size={15}
              color={theme.brand.primaryStrong}
            />
          )}
        </View>
        <Text
          variant="titleMedium"
          style={[
            styles.number,
            { color: theme.text.primary, fontWeight: '800' },
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.75}
        >
          {formatAmount(data?.incomeTotal ?? 0)}
        </Text>
      </Pressable>
    </View>
  );

  const comparisonStripBlock = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={comparison.text}
      onPress={openTrendScreen}
      style={({ pressed }) => [
        localStyles.compareStrip,
        {
          backgroundColor: theme.card.surfaceSubtle,
          borderColor: theme.card.border,
          borderWidth: cardBorderWidth,
        },
        pressed && { opacity: 0.78 },
      ]}
    >
      <MaterialCommunityIcons
        name="chart-bar"
        size={18}
        color={theme.brand.primaryStrong}
      />
      <Text
        variant="bodySmall"
        style={{ flex: 1, color: theme.text.secondary, lineHeight: 18 }}
        numberOfLines={profile.reflowLargeText ? 3 : 2}
      >
        <Text style={{ color: comparison.color, fontWeight: '700' }}>
          {comparison.prefix}
          {comparison.amountPart}
        </Text>
        <Text style={{ color: theme.text.secondary }}>{comparison.suffix}</Text>
      </Text>
      <MaterialCommunityIcons
        name="chevron-right"
        size={18}
        color={theme.text.muted}
      />
    </Pressable>
  );

  const donutAndDetailsBlock = (
    <>
      {breakdown.slices.length === 0 ? (
        <View style={{ paddingVertical: 8 }}>
          <EmptyStateCard
            icon="chart-donut"
            message={
              selectedKind === 'expense'
                ? vi.statsNoExpenseData
                : vi.statsNoIncomeData
            }
          />
        </View>
      ) : (
        <AllocationDonutChart
          slices={breakdown.slices}
          selectedId={selectedCategoryId}
          onSelectSlice={handleSelectSlice}
          chartAccessibilityLabel={
            selectedKind === 'expense'
              ? vi.statsCategoryAllocation
              : vi.statsSituationTitle
          }
        />
      )}

      {breakdown.items.length > 0 && (
        <View style={{ gap: 10 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: detailsExpanded }}
            accessibilityLabel={vi.statsDetailsTitle.replace(
              '{count}',
              String(breakdown.items.length),
            )}
            onPress={() => setDetailsExpanded((prev) => !prev)}
            style={localStyles.detailsToggleBtn}
          >
            <Text
              variant="labelLarge"
              style={{
                color: theme.brand.primaryText,
                fontWeight: '700',
              }}
            >
              {vi.statsDetailsTitle.replace(
                '{count}',
                String(breakdown.items.length),
              )}
            </Text>
            <MaterialCommunityIcons
              name={detailsExpanded ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={theme.brand.primaryText}
            />
          </Pressable>

          {detailsExpanded && (
            <View style={{ gap: 12, paddingTop: 4 }}>
              {breakdown.items.map((item) => {
                const isSelected = selectedCategoryId === item.id;
                const fillWidth = Math.max(
                  4,
                  Math.min(100, Math.round(item.exactPercent)),
                );
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={`${item.name}: ${item.percentLabel}, ${formatAmount(item.amount)}`}
                    onPress={() =>
                      setSelectedCategoryId((prev) =>
                        prev === item.id ? null : item.id,
                      )
                    }
                    style={[
                      localStyles.detailRowCard,
                      {
                        backgroundColor: isSelected
                          ? theme.brand.primarySoft
                          : theme.card.surfaceSubtle,
                        borderColor: isSelected
                          ? theme.brand.primary
                          : theme.card.border,
                        borderWidth: isSelected ? 1.5 : cardBorderWidth,
                      },
                    ]}
                  >
                    <View
                      style={[
                        localStyles.detailRowTop,
                        profile.reflowLargeText && {
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                        },
                      ]}
                    >
                      <View style={localStyles.detailRowLeft}>
                        <View
                          style={[
                            localStyles.detailIconWrap,
                            { backgroundColor: `${item.color}1E` },
                          ]}
                        >
                          <MaterialCommunityIcons
                            name={item.icon as never}
                            size={16}
                            color={item.color}
                          />
                        </View>
                        <Text
                          variant="bodyMedium"
                          style={{
                            color: theme.text.primary,
                            fontWeight: '600',
                            flexShrink: 1,
                          }}
                          numberOfLines={profile.reflowLargeText ? 2 : 1}
                        >
                          {item.name}
                        </Text>
                      </View>
                      <View
                        style={[
                          localStyles.detailRowRight,
                          profile.reflowLargeText && {
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 8,
                          },
                        ]}
                      >
                        {isSelected && (
                          <MaterialCommunityIcons
                            name="check"
                            size={15}
                            color={theme.brand.primaryStrong}
                          />
                        )}
                        <Text
                          variant="labelMedium"
                          style={[
                            styles.number,
                            { color: item.color, fontWeight: '700' },
                          ]}
                        >
                          {item.percentLabel}
                        </Text>
                        <Text
                          variant="bodyMedium"
                          style={[
                            styles.number,
                            {
                              color: theme.text.primary,
                              fontWeight: '700',
                            },
                          ]}
                        >
                          {formatAmount(item.amount)}
                        </Text>
                      </View>
                    </View>
                    <View
                      style={[
                        localStyles.detailTrack,
                        { backgroundColor: theme.card.border },
                      ]}
                    >
                      <View
                        style={[
                          localStyles.detailFill,
                          {
                            width: `${fillWidth}%`,
                            backgroundColor: item.color,
                          },
                        ]}
                      />
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      )}
    </>
  );

  const aiStripBlock = (
    <View
      style={[
        localStyles.aiStripContainer,
        profile.reflowLargeText && {
          flexDirection: 'column',
          alignItems: 'stretch',
        },
        {
          backgroundColor: theme.card.surfaceSubtle,
          borderColor: theme.card.border,
          borderWidth: cardBorderWidth,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={vi.statsAskAiButton}
        onPress={() => openChat()}
        style={[
          localStyles.askAiBtn,
          {
            backgroundColor: theme.card.surfaceElevated,
            borderColor: theme.brand.primary,
            borderWidth: cardBorderWidth,
          },
        ]}
      >
        <MaterialCommunityIcons
          name="creation"
          size={15}
          color={theme.brand.primaryStrong}
        />
        <Text
          variant="labelMedium"
          style={{
            color: theme.brand.primaryText,
            fontWeight: '700',
          }}
        >
          {vi.statsAskAiButton}
        </Text>
        <MaterialCommunityIcons
          name="chevron-right"
          size={15}
          color={theme.brand.primaryText}
        />
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={promptChipFull}
        onPress={() => openChatWithPrompt(promptChipFull)}
        style={[
          localStyles.aiPromptChip,
          profile.reflowLargeText && { flex: 0 },
          {
            backgroundColor: theme.card.surfaceElevated,
            borderColor: theme.card.border,
            borderWidth: cardBorderWidth,
          },
        ]}
      >
        <MaterialCommunityIcons
          name="lightbulb-outline"
          size={15}
          color={palette.warning}
        />
        <Text
          variant="bodySmall"
          style={{
            color: theme.text.primary,
            fontWeight: '500',
            flexShrink: 1,
          }}
          numberOfLines={profile.reflowLargeText ? 2 : 1}
          ellipsizeMode="tail"
        >
          {promptChipShort}
        </Text>
      </Pressable>
    </View>
  );

  return (
    <Screen title={vi.statsTabTitle} scroll={false} maxWidth={1120}>
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        onScroll={tabBarScroll.onScroll}
        scrollEventThrottle={tabBarScroll.scrollEventThrottle}
        onLayout={(e) => {
          const w = Math.floor(e.nativeEvent.layout.width);
          if (w > 0 && Math.abs(w - containerWidth) > 2) {
            setContainerWidth(w);
          }
        }}
        contentContainerStyle={{
          gap: 16,
          paddingBottom: DesignSpacing.bottomTabClearance + insets.bottom,
        }}
      >
        {profile.isWide ? (
          <View style={localStyles.wideSplitRow}>
            <View style={localStyles.widePrimaryCol}>
              {utilitiesCard}
              {situationHeader}
              <GlassCard
                variant="elevated"
                radius="xl"
                padding={DesignSpacing.md}
              >
                {monthNavigator}
                {loading && !data ? (
                  <View style={{ paddingVertical: 36, alignItems: 'center' }}>
                    <ActivityIndicator
                      size="large"
                      accessibilityLabel={vi.loading}
                    />
                  </View>
                ) : error ? (
                  errorBlock
                ) : (
                  <View style={{ gap: 12 }}>
                    {kindCardsBlock}
                    {comparisonStripBlock}
                    {aiStripBlock}
                  </View>
                )}
              </GlassCard>
            </View>

            <View style={localStyles.wideSecondaryCol}>
              <GlassCard
                variant="elevated"
                radius="xl"
                padding={DesignSpacing.md}
              >
                {loading && !data ? (
                  <View style={{ paddingVertical: 48, alignItems: 'center' }}>
                    <ActivityIndicator
                      size="large"
                      accessibilityLabel={vi.loading}
                    />
                  </View>
                ) : error ? (
                  errorBlock
                ) : (
                  <View style={{ gap: 12 }}>{donutAndDetailsBlock}</View>
                )}
              </GlassCard>
            </View>
          </View>
        ) : (
          <>
            {utilitiesCard}
            {situationHeader}
            <GlassCard
              variant="elevated"
              radius="xl"
              padding={DesignSpacing.md}
            >
              {monthNavigator}
              {loading && !data ? (
                <View style={{ paddingVertical: 36, alignItems: 'center' }}>
                  <ActivityIndicator
                    size="large"
                    accessibilityLabel={vi.loading}
                  />
                </View>
              ) : error ? (
                errorBlock
              ) : (
                <View style={{ gap: 12 }}>
                  {kindCardsBlock}
                  {comparisonStripBlock}
                  {donutAndDetailsBlock}
                  {aiStripBlock}
                </View>
              )}
            </GlassCard>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const localStyles = StyleSheet.create({
  utilitiesRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 6,
  },
  utilitiesWrap: {
    flexWrap: 'wrap',
  },
  utilityTile: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  utilityTileWrapped: {
    flexBasis: '47%',
    flexGrow: 0,
  },
  utilityIconWrap: {
    width: 46,
    height: 46,
    borderRadius: DesignRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  utilityLabel: {
    textAlign: 'center',
    fontWeight: '600',
    lineHeight: 15,
  },
  sectionHeader: {
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
  widePrimaryCol: {
    flex: 1,
    gap: 16,
  },
  wideSecondaryCol: {
    flex: 1.1,
    gap: 16,
  },
  errorBox: {
    paddingVertical: 16,
    gap: 12,
    alignItems: 'center',
  },
  monthNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  monthArrowBtn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthCenterLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  kindCardsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  kindCard: {
    flex: 1,
    borderRadius: DesignRadius.lg,
    padding: 12,
    gap: 6,
    minHeight: 72,
    justifyContent: 'center',
  },
  kindLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  kindIconCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deltaBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compareStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: DesignRadius.md,
    borderWidth: 1,
    minHeight: 44,
  },
  detailsToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minHeight: 44,
  },
  detailRowCard: {
    borderRadius: DesignRadius.md,
    borderWidth: 1,
    minHeight: STATS_MIN_TOUCH_TARGET,
    padding: 10,
    gap: 8,
  },
  detailRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  detailRowLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  detailIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailRowRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  detailTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  detailFill: {
    height: '100%',
    borderRadius: 3,
  },
  aiStripContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    borderRadius: DesignRadius.lg,
    borderWidth: 1,
  },
  askAiBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 12,
    minHeight: STATS_MIN_TOUCH_TARGET,
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
  },
  aiPromptChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    minHeight: STATS_MIN_TOUCH_TARGET,
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
  },
});
