import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PixelRatio,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { ActivityIndicator, Button, Switch, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import MaterialCommunityIcons from '@/components/platform-icon';
import { Screen } from '@/components/screen';
import { GlassCard, SegmentedOptionPicker } from '@/components/ui';
import { useResponsiveLayout } from '@/constants/responsive-layout';
import {
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import {
  readCashFlowCategoryComparison,
  readCashFlowTrend,
  type CashFlowCategoryComparisonItem,
  type CashFlowPeriodPoint,
  type CashFlowTrendResult,
  type TrendCategoryLevel,
  type TrendGranularity,
  type TrendLabelOptions,
} from '@/data/stats';
import { useAccessibilityPreferences } from '@/hooks/use-accessibility-preferences';
import {
  computeTrendChartScale,
  resolveCategoryVisual,
} from './stats-summary';
import { useCurrentDate } from '@/hooks/use-current-date';
import { useTabBarScroll } from '@/hooks/use-tab-bar-scroll';
import { displayCategoryName } from '@/messages/seed-labels';
import { vi } from '@/messages/vi';
import { useApp } from '@/state/app';
import {
  formatCurrencyAmount,
  usePreferences,
} from '@/state/preferences';
import { FloatingGlassControl } from './floating-glass-control';
import {
  getStatsResponsiveProfile,
  STATS_MIN_FONT_SIZE,
  STATS_MIN_TOUCH_TARGET,
} from './stats-layout';

type MetricTab = 'income' | 'expense' | 'net';

const MASKED_AMOUNT = '••••••';
const PLOT_HEIGHT = 188;
const Y_AXIS_WIDTH = 42;
const CALLOUT_BAND_HEIGHT = 56;

function formatShortDayMonth(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

function getMetricHeadlineLabel(
  metric: MetricTab,
  granularity: TrendGranularity,
  selectedPoint: CashFlowPeriodPoint | null,
): string {
  if (selectedPoint && !selectedPoint.isCurrent) {
    const template =
      metric === 'income'
        ? vi.statsTotalIncomeForPeriod
        : metric === 'expense'
          ? vi.statsTotalExpenseForPeriod
          : vi.statsTotalNetForPeriod;
    return template.replace('{period}', selectedPoint.label);
  }
  if (metric === 'income') {
    if (granularity === 'week') return vi.statsTotalIncomeThisWeek;
    if (granularity === 'month') return vi.statsTotalIncomeThisMonth;
    return vi.statsTotalIncomeThisYear;
  }
  if (metric === 'expense') {
    if (granularity === 'week') return vi.statsTotalExpenseThisWeek;
    if (granularity === 'month') return vi.statsTotalExpenseThisMonth;
    return vi.statsTotalExpenseThisYear;
  }
  if (granularity === 'week') return vi.statsTotalNetThisWeek;
  if (granularity === 'month') return vi.statsTotalNetThisMonth;
  return vi.statsTotalNetThisYear;
}

function getComparisonTargetLabel(
  granularity: TrendGranularity,
  isCurrent: boolean,
): string {
  if (!isCurrent) return vi.statsSamePeriodPrevGeneric;
  if (granularity === 'week') return vi.statsSamePeriodPrevWeek;
  if (granularity === 'month') return vi.statsSamePeriodPrevMonth;
  return vi.statsSamePeriodPrevYear;
}

function getLegendTotalLabel(
  metric: 'income' | 'expense',
  granularity: TrendGranularity,
): string {
  if (metric === 'income') {
    if (granularity === 'week') return vi.statsLegendIncomeWeek;
    if (granularity === 'month') return vi.statsLegendIncomeMonth;
    return vi.statsLegendIncomeYear;
  }
  if (granularity === 'week') return vi.statsLegendExpenseWeek;
  if (granularity === 'month') return vi.statsLegendExpenseMonth;
  return vi.statsLegendExpenseYear;
}

/**
 * Interactive cash flow trends view featuring rolling 6-week, 6-month, and 2-year comparisons,
 * same-period stacked bar overlays, divergent net charts, and parent/child category deltas.
 */
export function CashFlowTrendView({ onClose }: { onClose?(): void } = {}) {
  const theme = useDesignTheme();
  const palette = useFinancePalette();
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
  const currency = usePreferences((state) => state.currency);
  const exchangeRate = usePreferences((state) => state.exchangeRate);
  const language = usePreferences((state) => state.language);
  const recurringVersion = useApp((state) => state.recurringVersion);
  const isAddOpen = usePreferences((state) => state.isAddTransactionOpen);

  const [granularity, setGranularity] = useState<TrendGranularity>('month');
  const [metric, setMetric] = useState<MetricTab>('expense');
  const [compareSamePeriod, setCompareSamePeriod] = useState(true);
  const [categoryLevel, setCategoryLevel] =
    useState<TrendCategoryLevel>('child');
  const [selectedPointKey, setSelectedPointKey] = useState<string | null>(null);
  const [showCompareInfo, setShowCompareInfo] = useState(false);
  const [cardInnerWidth, setCardInnerWidth] = useState(312);

  const [data, setData] = useState<CashFlowTrendResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [categoryItems, setCategoryItems] = useState<
    CashFlowCategoryComparisonItem[]
  >([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);

  const reqRef = useRef(0);
  const catReqRef = useRef(0);
  const wasAddOpen = useRef(isAddOpen);
  const prevRecurring = useRef(recurringVersion);

  const trendLabels = useMemo<TrendLabelOptions>(
    () => ({
      monthPrefix: language === 'en' ? 'M' : 'T',
      thisWeekLabel: vi.statsThisWeek,
      thisMonthLabel: vi.statsThisMonth,
      thisYearLabel: vi.statsThisYear,
      monthBadgeTemplate: vi.statsTrendMonthBadge,
      yearLabelTemplate: vi.statsTrendYearItemLabel,
    }),
    [language],
  );

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading((prev) => (data === null ? true : prev));
    setError('');
    try {
      const next = await withDatabase((db) =>
        readCashFlowTrend(db, granularity, currentDate, trendLabels),
      );
      if (req !== reqRef.current) return;
      setData(next);
      setSelectedPointKey((prev) => {
        if (prev && next.points.some((p) => p.key === prev)) return prev;
        return next.points.at(-1)?.key ?? null;
      });
    } catch {
      if (req === reqRef.current) setError(vi.transactionsLoadError);
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Keep stale chart visible during granularity reloads.
  }, [currentDate, granularity, trendLabels]);

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

  const points = useMemo(() => data?.points ?? [], [data?.points]);

  const selectedIndex = useMemo(() => {
    if (points.length === 0) return -1;
    const hit = points.findIndex((p) => p.key === selectedPointKey);
    return hit >= 0 ? hit : points.length - 1;
  }, [points, selectedPointKey]);

  const selectedPoint = useMemo<CashFlowPeriodPoint | null>(
    () => (selectedIndex >= 0 ? points[selectedIndex] : null),
    [points, selectedIndex],
  );

  const previousPoint = useMemo<CashFlowPeriodPoint | null>(() => {
    if (!data || selectedIndex < 0) return null;
    return selectedIndex === 0
      ? data.baselinePreviousPoint
      : points[selectedIndex - 1];
  }, [data, points, selectedIndex]);

  useEffect(() => {
    if (metric === 'net' || !selectedPoint || !previousPoint) {
      return;
    }
    const req = ++catReqRef.current;
    const currentRange = {
      startDate: selectedPoint.startDate,
      endDate: compareSamePeriod
        ? selectedPoint.samePeriodEndDate
        : selectedPoint.endDate,
    };
    const previousRange = {
      startDate: previousPoint.startDate,
      endDate: compareSamePeriod
        ? previousPoint.samePeriodEndDate
        : previousPoint.endDate,
    };
    const frame = requestAnimationFrame(() => {
      setCategoriesLoading(true);
      void withDatabase((db) =>
        readCashFlowCategoryComparison(
          db,
          metric,
          currentRange,
          previousRange,
          categoryLevel,
        ),
      )
        .then((rows) => {
          if (req === catReqRef.current) setCategoryItems(rows);
        })
        .catch(() => {
          if (req === catReqRef.current) setCategoryItems([]);
        })
        .finally(() => {
          if (req === catReqRef.current) setCategoriesLoading(false);
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [categoryLevel, compareSamePeriod, metric, previousPoint, selectedPoint]);

  const formatAmount = (amountVnd: number) =>
    hideBalance ? MASKED_AMOUNT : formatCurrencyAmount(amountVnd, currency);

  const headlineAmount = useMemo(() => {
    if (!selectedPoint) return 0;
    if (metric === 'net') return selectedPoint.net;
    if (metric === 'income') {
      return compareSamePeriod
        ? selectedPoint.samePeriodIncome
        : selectedPoint.income;
    }
    return compareSamePeriod
      ? selectedPoint.samePeriodExpense
      : selectedPoint.expense;
  }, [compareSamePeriod, metric, selectedPoint]);

  const compareSummary = useMemo(() => {
    if (!selectedPoint || !previousPoint) {
      return { delta: 0, text: '', tone: 'neutral' as const };
    }
    const pickVal = (p: CashFlowPeriodPoint) => {
      if (metric === 'income') {
        return compareSamePeriod ? p.samePeriodIncome : p.income;
      }
      if (metric === 'expense') {
        return compareSamePeriod ? p.samePeriodExpense : p.expense;
      }
      return p.samePeriodNet;
    };
    const currentVal = pickVal(selectedPoint);
    const prevVal = pickVal(previousPoint);
    const delta = currentVal - prevVal;
    const periodTarget = getComparisonTargetLabel(
      granularity,
      selectedPoint.isCurrent,
    );
    if (delta === 0) {
      return {
        delta: 0,
        text: vi.statsTrendCompareEqual.replace('{period}', periodTarget),
        tone: 'neutral' as const,
      };
    }
    const formattedDelta = hideBalance
      ? MASKED_AMOUNT
      : formatCurrencyAmount(Math.abs(delta), currency);
    const text = (
      delta > 0 ? vi.statsTrendCompareUp : vi.statsTrendCompareDown
    )
      .replace('{amount}', formattedDelta)
      .replace('{period}', periodTarget);

    // Increase in income/net or decrease in expense is favorable (green); reverse is negative (coral).
    const isPositiveOutcome =
      metric === 'expense' ? delta < 0 : delta > 0;
    return {
      delta,
      text,
      tone: isPositiveOutcome ? ('good' as const) : ('bad' as const),
    };
  }, [
    compareSamePeriod,
    currency,
    granularity,
    hideBalance,
    metric,
    previousPoint,
    selectedPoint,
  ]);

  const chartScale = useMemo(() => {
    if (metric === 'net') {
      return computeTrendChartScale(
        points.map((p) => p.net),
        true,
        currency,
        exchangeRate ?? 25_000,
      );
    }
    const vals = points.flatMap((p) =>
      metric === 'income'
        ? [p.income, p.samePeriodIncome]
        : [p.expense, p.samePeriodExpense],
    );
    return computeTrendChartScale(vals, false, currency, exchangeRate ?? 25_000);
  }, [currency, exchangeRate, metric, points]);

  const unitLabel = useMemo(() => {
    if (chartScale.unitKind === 'million') return vi.statsTrendUnitMillion;
    if (chartScale.unitKind === 'thousand') return vi.statsTrendUnitThousand;
    return vi.statsTrendUnitCurrency.replace('{unit}', currency);
  }, [chartScale.unitKind, currency]);

  const plotAreaWidth = Math.max(180, cardInnerWidth - Y_AXIS_WIDTH);
  const barWidth = useMemo(() => {
    const count = Math.max(1, points.length);
    if (count <= 2) {
      return Math.min(92, Math.max(52, Math.floor((plotAreaWidth / 2) * 0.68)));
    }
    return Math.min(40, Math.max(22, Math.floor((plotAreaWidth / count) * 0.68)));
  }, [plotAreaWidth, points.length]);

  const isDark = theme.mode === 'dark';
  const activeBlue = isDark ? '#3B82F6' : '#1677FF';
  const midBlue = profile.highContrast
    ? isDark
      ? '#60A5FA'
      : '#3B82F6'
    : isDark
      ? 'rgba(96, 165, 250, 0.72)'
      : '#8BC0FF';
  const backdropBlue = profile.solidGlass
    ? isDark
      ? '#1E3A8A'
      : '#BFDBFE'
    : isDark
      ? 'rgba(59, 130, 246, 0.25)'
      : '#CFE3FF';
  const netPosBlue = profile.solidGlass
    ? isDark
      ? '#1E40AF'
      : '#93C5FD'
    : isDark
      ? 'rgba(96, 165, 250, 0.38)'
      : '#CBE2FF';
  const netPosActiveBlue = isDark ? '#3B82F6' : '#1D4ED8';
  const netNegCoral = profile.solidGlass
    ? isDark
      ? '#7F1D1D'
      : '#FECACA'
    : isDark
      ? 'rgba(248, 113, 113, 0.36)'
      : '#FAD7CE';
  const netNegActiveCoral = isDark ? '#EF4444' : '#DC2626';
  const cardBorderWidth = profile.highContrast ? 1.5 : 1;

  const comparePillStyles = useMemo(() => {
    if (compareSummary.tone === 'good') {
      return {
        bg: isDark ? 'rgba(34, 197, 94, 0.16)' : '#ECFDF3',
        text: isDark ? '#86EFAC' : '#15803D',
        badgeBg: isDark ? 'rgba(34, 197, 94, 0.25)' : '#DCFCE7',
      };
    }
    if (compareSummary.tone === 'bad') {
      return {
        bg: isDark ? 'rgba(249, 115, 22, 0.16)' : '#FFF4ED',
        text: isDark ? '#FDBA74' : '#EA580C',
        badgeBg: isDark ? 'rgba(249, 115, 22, 0.24)' : '#FFEDD5',
      };
    }
    return {
      bg: theme.card.surfaceSubtle,
      text: theme.text.secondary,
      badgeBg: isDark ? 'rgba(148, 163, 184, 0.22)' : '#E5E7EB',
    };
  }, [compareSummary.tone, isDark, theme.card.surfaceSubtle, theme.text.secondary]);

  const reverseOrderedPoints = useMemo(() => [...points].reverse(), [points]);

  const slotCenterX =
    selectedIndex >= 0 && points.length > 0
      ? ((selectedIndex + 0.5) / points.length) * plotAreaWidth
      : 0;

  const calloutWidth = profile.reflowLargeText
    ? Math.min(188, Math.max(124, Math.floor(plotAreaWidth * 0.56)))
    : Math.min(148, Math.max(112, Math.floor(plotAreaWidth * 0.44)));
  const calloutLeft = Math.min(
    Math.max(0, plotAreaWidth - calloutWidth),
    Math.max(0, slotCenterX - calloutWidth / 2),
  );
  const calloutBandMinHeight = profile.reflowLargeText
    ? 68
    : CALLOUT_BAND_HEIGHT;

  const zeroY = chartScale.zeroRatio * PLOT_HEIGHT;
  const zeroTickIndex = chartScale.ticks.findIndex((t) => Math.abs(t) < 1e-9);

  const heroAndChartContent = (
    <View
      onLayout={(e) => {
        const w = Math.floor(e.nativeEvent.layout.width);
        if (w > 180) setCardInnerWidth(w);
      }}
      style={{ gap: 16 }}
    >
      {/* Centered Headline & Hero Figure */}
      <View style={localStyles.heroBlock}>
        <Text
          variant="bodyMedium"
          style={{
            fontWeight: '500',
            color: theme.text.secondary,
            textAlign: 'center',
          }}
        >
          {getMetricHeadlineLabel(metric, granularity, selectedPoint)}
        </Text>
        <Text
          variant="headlineMedium"
          numberOfLines={profile.reflowLargeText ? 2 : 1}
          adjustsFontSizeToFit={!profile.reflowLargeText}
          minimumFontScale={0.85}
          style={[localStyles.heroValue, { color: theme.text.primary }]}
        >
          {formatAmount(headlineAmount)}
        </Text>

        {/* Comparison Pill + Clickable Info Trigger */}
        <View
          style={[
            localStyles.comparePill,
            {
              backgroundColor: comparePillStyles.bg,
              borderColor: profile.highContrast
                ? comparePillStyles.text
                : 'transparent',
              borderWidth: profile.highContrast ? 1.5 : 0,
            },
          ]}
        >
          <View
            style={[
              localStyles.compareIconCircle,
              { backgroundColor: comparePillStyles.badgeBg },
            ]}
          >
            <MaterialCommunityIcons
              name={
                compareSummary.delta > 0
                  ? 'arrow-up'
                  : compareSummary.delta < 0
                    ? 'arrow-down'
                    : 'minus'
              }
              size={12}
              color={comparePillStyles.text}
            />
          </View>
          <Text
            variant="bodySmall"
            style={{
              flexShrink: 1,
              fontWeight: '600',
              color: comparePillStyles.text,
            }}
          >
            {compareSummary.text}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={vi.statsCompareInfoA11y}
            accessibilityState={{ expanded: showCompareInfo }}
            onPress={() => setShowCompareInfo((prev) => !prev)}
            style={localStyles.infoIconBtn}
          >
            <MaterialCommunityIcons
              name="information-outline"
              size={18}
              color={
                showCompareInfo ? comparePillStyles.text : theme.text.secondary
              }
            />
          </Pressable>
        </View>

        {showCompareInfo && selectedPoint && previousPoint && (
          <View
            style={[
              localStyles.infoBanner,
              {
                backgroundColor: theme.card.surfaceSubtle,
                borderColor: theme.card.border,
                borderWidth: cardBorderWidth,
              },
            ]}
          >
            <Text
              variant="bodySmall"
              style={{
                color: theme.text.secondary,
                textAlign: 'center',
              }}
            >
              {vi.statsCompareInfoDetail
                .replace(
                  '{current}',
                  `${formatShortDayMonth(selectedPoint.startDate)}–${formatShortDayMonth(
                    metric !== 'net' && !compareSamePeriod
                      ? selectedPoint.endDate
                      : selectedPoint.samePeriodEndDate,
                  )}`,
                )
                .replace(
                  '{previous}',
                  `${formatShortDayMonth(previousPoint.startDate)}–${formatShortDayMonth(
                    metric !== 'net' && !compareSamePeriod
                      ? previousPoint.endDate
                      : previousPoint.samePeriodEndDate,
                  )}`,
                )}
            </Text>
          </View>
        )}
      </View>

      {/* Chart Header Row */}
      <View
        style={[
          localStyles.chartHeaderRow,
          profile.reflowLargeText && {
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 10,
          },
        ]}
      >
        <Text
          variant="titleMedium"
          style={{
            fontWeight: '700',
            color: theme.text.primary,
          }}
        >
          {vi.statsTrendChartTitle}
        </Text>

        {metric !== 'net' && (
          <View style={localStyles.switchGroup}>
            <Text
              variant="bodySmall"
              style={{
                color: theme.text.secondary,
                flexShrink: 1,
              }}
            >
              {vi.statsCompareSamePeriodLabel}
            </Text>
            <Switch
              accessibilityLabel={vi.statsCompareSamePeriodLabel}
              value={compareSamePeriod}
              onValueChange={setCompareSamePeriod}
              color={isDark ? '#22C55E' : '#16A34A'}
            />
          </View>
        )}
      </View>

      {/* Interactive Bar Chart */}
      <View style={localStyles.chartSection}>
        <Text
          variant="labelSmall"
          style={{
            fontWeight: '500',
            color: theme.text.muted,
            marginBottom: 4,
          }}
        >
          {unitLabel}
        </Text>

        {/* Callout Strip above Plot (Income & Expense) */}
        {metric !== 'net' && selectedPoint && (
          <View
            style={[
              localStyles.calloutBandRow,
              { paddingLeft: Y_AXIS_WIDTH, minHeight: calloutBandMinHeight },
            ]}
          >
            <View
              style={{
                width: plotAreaWidth,
                minHeight: calloutBandMinHeight,
                position: 'relative',
              }}
            >
              <View
                style={{
                  position: 'absolute',
                  left: slotCenterX - 1,
                  bottom: 0,
                  height: 12,
                  borderLeftWidth: 1.5,
                  borderStyle: 'dashed',
                  borderColor: activeBlue,
                }}
              />
              <View
                style={[
                  localStyles.calloutCard,
                  {
                    left: calloutLeft,
                    width: calloutWidth,
                    backgroundColor: theme.card.surface,
                    borderColor: activeBlue,
                    borderWidth: profile.highContrast ? 1.5 : 1,
                  },
                ]}
              >
                <Text
                  variant="labelSmall"
                  numberOfLines={profile.reflowLargeText ? 2 : 1}
                  style={{
                    color: theme.text.secondary,
                    textAlign: 'center',
                  }}
                >
                  {selectedPoint.calloutDateLabel}
                </Text>
                <Text
                  variant="labelLarge"
                  numberOfLines={profile.reflowLargeText ? 2 : 1}
                  style={{
                    fontWeight: '700',
                    color: activeBlue,
                    fontVariant: ['tabular-nums'],
                    textAlign: 'center',
                  }}
                >
                  {formatAmount(headlineAmount)}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Main Plot Matrix: Left Y Ticks + Right Grid & Bars */}
        <View style={localStyles.plotRow}>
          <View
            style={{
              width: Y_AXIS_WIDTH,
              height: PLOT_HEIGHT,
              position: 'relative',
            }}
          >
            {chartScale.tickLabels.map((label, idx) => {
              const ratio =
                idx / Math.max(1, chartScale.tickLabels.length - 1);
              return (
                <Text
                  key={`${label}-${idx}`}
                  style={[
                    localStyles.yTickLabel,
                    {
                      top: ratio * PLOT_HEIGHT - 8,
                      color: theme.text.secondary,
                    },
                  ]}
                >
                  {label}
                </Text>
              );
            })}
          </View>

          <View
            style={{
              flex: 1,
              height: PLOT_HEIGHT,
              position: 'relative',
            }}
          >
            {/* Horizontal Gridlines */}
            {chartScale.ticks.map((_, idx) => {
              const ratio = idx / Math.max(1, chartScale.ticks.length - 1);
              const isZeroLine = idx === zeroTickIndex;
              return (
                <View
                  key={`grid-${idx}`}
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: ratio * PLOT_HEIGHT,
                    height: isZeroLine ? 1 : StyleSheet.hairlineWidth,
                    backgroundColor: isZeroLine
                      ? theme.text.muted
                      : theme.card.border,
                    opacity: isZeroLine ? 0.65 : 0.45,
                  }}
                />
              );
            })}

            {/* Bar Columns */}
            <View style={localStyles.barsRow}>
              {points.map((point, idx) => {
                const isSelected = idx === selectedIndex;

                if (metric === 'net') {
                  const netVal = point.net;
                  const span = chartScale.maxRawValue - chartScale.minRawValue;
                  const rawHeight =
                    netVal !== 0 && span > 0
                      ? Math.max(
                          4,
                          Math.round((Math.abs(netVal) / span) * PLOT_HEIGHT),
                        )
                      : 0;
                  const isPos = netVal >= 0;
                  return (
                    <Pressable
                      key={point.key}
                      accessibilityRole="button"
                      accessibilityLabel={vi.statsTrendSelectBarA11y.replace(
                        '{label}',
                        point.rangeLabel,
                      )}
                      accessibilityState={{ selected: isSelected }}
                      onPress={() => setSelectedPointKey(point.key)}
                      style={localStyles.barSlot}
                    >
                      {rawHeight > 0 && isPos && (
                        <View
                          style={{
                            position: 'absolute',
                            bottom: PLOT_HEIGHT - zeroY,
                            width: barWidth,
                            height: rawHeight,
                            borderTopLeftRadius: 6,
                            borderTopRightRadius: 6,
                            backgroundColor: isSelected
                              ? netPosActiveBlue
                              : netPosBlue,
                            borderWidth:
                              isSelected && profile.highContrast ? 1.5 : 0,
                            borderColor: theme.text.primary,
                          }}
                        />
                      )}
                      {rawHeight > 0 && !isPos && (
                        <View
                          style={{
                            position: 'absolute',
                            top: zeroY,
                            width: barWidth,
                            height: rawHeight,
                            borderBottomLeftRadius: 6,
                            borderBottomRightRadius: 6,
                            backgroundColor: isSelected
                              ? netNegActiveCoral
                              : netNegCoral,
                            borderWidth:
                              isSelected && profile.highContrast ? 1.5 : 0,
                            borderColor: theme.text.primary,
                          }}
                        />
                      )}
                    </Pressable>
                  );
                }

                const fullVal =
                  metric === 'income' ? point.income : point.expense;
                const sameVal =
                  metric === 'income'
                    ? point.samePeriodIncome
                    : point.samePeriodExpense;
                const maxRaw =
                  chartScale.maxRawValue > 0 ? chartScale.maxRawValue : 1;
                const fullHeight =
                  fullVal > 0
                    ? Math.max(4, Math.round((fullVal / maxRaw) * PLOT_HEIGHT))
                    : 0;
                const sameHeight =
                  sameVal > 0
                    ? Math.max(4, Math.round((sameVal / maxRaw) * PLOT_HEIGHT))
                    : 0;
                const frontHeight = compareSamePeriod ? sameHeight : fullHeight;
                const highestHeight = compareSamePeriod
                  ? Math.max(fullHeight, sameHeight)
                  : fullHeight;
                const dashedLineHeight = Math.max(
                  0,
                  PLOT_HEIGHT - highestHeight,
                );

                return (
                  <Pressable
                    key={point.key}
                    accessibilityRole="button"
                    accessibilityLabel={vi.statsTrendSelectBarA11y.replace(
                      '{label}',
                      point.rangeLabel,
                    )}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => setSelectedPointKey(point.key)}
                    style={localStyles.barSlot}
                  >
                    {isSelected && dashedLineHeight > 0 && (
                      <View
                        pointerEvents="none"
                        style={{
                          position: 'absolute',
                          top: 0,
                          height: dashedLineHeight,
                          borderLeftWidth: 1.5,
                          borderStyle: 'dashed',
                          borderColor: activeBlue,
                        }}
                      />
                    )}
                    {compareSamePeriod && fullHeight > 0 && (
                      <View
                        style={{
                          position: 'absolute',
                          bottom: 0,
                          width: barWidth,
                          height: fullHeight,
                          borderTopLeftRadius: 6,
                          borderTopRightRadius: 6,
                          backgroundColor: backdropBlue,
                        }}
                      />
                    )}
                    {frontHeight > 0 && (
                      <View
                        style={{
                          position: 'absolute',
                          bottom: 0,
                          width: barWidth,
                          height: frontHeight,
                          borderTopLeftRadius: 6,
                          borderTopRightRadius: 6,
                          backgroundColor: isSelected ? activeBlue : midBlue,
                          borderWidth:
                            isSelected && profile.highContrast ? 1.5 : 0,
                          borderColor: theme.text.primary,
                        }}
                      />
                    )}
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>

        {/* X-Axis Labels */}
        <View style={[localStyles.xAxisRow, { paddingLeft: Y_AXIS_WIDTH }]}>
          {points.map((point, idx) => {
            const isSelected = idx === selectedIndex;
            return (
              <Pressable
                key={`x-${point.key}`}
                accessibilityRole="button"
                accessibilityLabel={vi.statsTrendSelectBarA11y.replace(
                  '{label}',
                  point.rangeLabel,
                )}
                accessibilityState={{ selected: isSelected }}
                onPress={() => setSelectedPointKey(point.key)}
                style={localStyles.xLabelSlot}
              >
                <Text
                  numberOfLines={profile.reflowLargeText ? 2 : 1}
                  ellipsizeMode="tail"
                  style={[
                    localStyles.xTickLabel,
                    {
                      fontWeight: isSelected ? '700' : '500',
                      color: isSelected ? activeBlue : theme.text.secondary,
                      textDecorationLine: isSelected ? 'underline' : 'none',
                    },
                  ]}
                >
                  {point.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Legend Row (Income & Expense) */}
        {metric !== 'net' && (
          <View style={localStyles.legendRow}>
            {compareSamePeriod && (
              <View style={localStyles.legendItem}>
                <View
                  style={[
                    localStyles.legendSwatch,
                    { backgroundColor: midBlue },
                  ]}
                />
                <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
                  {metric === 'income'
                    ? vi.statsLegendIncomeSamePeriod
                    : vi.statsLegendExpenseSamePeriod}
                </Text>
              </View>
            )}
            <View style={localStyles.legendItem}>
              <View
                style={[
                  localStyles.legendSwatch,
                  {
                    backgroundColor: compareSamePeriod ? backdropBlue : midBlue,
                  },
                ]}
              />
              <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
                {getLegendTotalLabel(metric, granularity)}
              </Text>
            </View>
          </View>
        )}
      </View>
    </View>
  );

  const breakdownContent =
    metric !== 'net' ? (
      <View style={localStyles.breakdownSection}>
        <SegmentedOptionPicker<TrendCategoryLevel>
          value={categoryLevel}
          accessibilityLabel={vi.statsCategoryLevelA11y}
          options={[
            { value: 'child', label: vi.statsSubcategoriesTab },
            { value: 'parent', label: vi.statsParentCategoriesTab },
          ]}
          onSelect={setCategoryLevel}
        />

        {categoriesLoading && categoryItems.length === 0 ? (
          <View style={localStyles.categoriesLoader}>
            <ActivityIndicator size="small" color={palette.primary} />
          </View>
        ) : categoryItems.length === 0 ? (
          <Text
            variant="bodyMedium"
            style={{
              color: theme.text.muted,
              textAlign: 'center',
              paddingVertical: 14,
            }}
          >
            {vi.statsTrendCategoriesEmpty}
          </Text>
        ) : (
          <View style={localStyles.categoryList}>
            {categoryItems.map((cat, idx) => {
              const visual = resolveCategoryVisual(cat, idx, cat.id === null);
              const label = cat.name
                ? displayCategoryName(cat.name, language)
                : vi.transactionUncategorized;
              const deltaUp = cat.delta > 0;
              const deltaFavorable =
                metric === 'expense' ? cat.delta < 0 : cat.delta > 0;
              const deltaColor = deltaFavorable
                ? palette.income
                : isDark
                  ? '#FB7185'
                  : '#E11D48';

              return (
                <View
                  key={`${cat.id ?? 'uncat'}-${idx}`}
                  style={[
                    localStyles.categoryRow,
                    profile.reflowLargeText && { alignItems: 'flex-start' },
                  ]}
                >
                  <View
                    style={[
                      localStyles.categoryAvatar,
                      { backgroundColor: `${visual.color}1F` },
                    ]}
                  >
                    <MaterialCommunityIcons
                      name={visual.icon as never}
                      size={20}
                      color={visual.color}
                    />
                  </View>

                  <View style={{ flex: 1, gap: 4 }}>
                    <Text
                      variant="bodyMedium"
                      numberOfLines={profile.reflowLargeText ? 3 : 2}
                      style={{
                        fontWeight: '500',
                        color: theme.text.primary,
                      }}
                    >
                      {label}
                    </Text>

                    {profile.reflowLargeText && (
                      <View style={localStyles.categoryAmountsInline}>
                        <Text
                          variant="bodyMedium"
                          style={[
                            localStyles.categoryAmountText,
                            { color: theme.text.primary },
                          ]}
                        >
                          {formatAmount(cat.amount)}
                        </Text>
                        {cat.delta !== 0 && (
                          <View style={localStyles.categoryDeltaRow}>
                            <MaterialCommunityIcons
                              name={deltaUp ? 'arrow-up' : 'arrow-down'}
                              size={12}
                              color={deltaColor}
                            />
                            <Text
                              variant="labelMedium"
                              style={{
                                fontWeight: '600',
                                fontVariant: ['tabular-nums'],
                                color: deltaColor,
                              }}
                            >
                              {formatAmount(Math.abs(cat.delta))}
                            </Text>
                          </View>
                        )}
                      </View>
                    )}
                  </View>

                  {!profile.reflowLargeText && (
                    <View style={localStyles.categoryAmountsCol}>
                      <Text
                        variant="bodyMedium"
                        style={[
                          localStyles.categoryAmountText,
                          { color: theme.text.primary },
                        ]}
                      >
                        {formatAmount(cat.amount)}
                      </Text>
                      {cat.delta !== 0 && (
                        <View style={localStyles.categoryDeltaRow}>
                          <MaterialCommunityIcons
                            name={deltaUp ? 'arrow-up' : 'arrow-down'}
                            size={12}
                            color={deltaColor}
                          />
                          <Text
                            variant="labelMedium"
                            style={{
                              fontWeight: '600',
                              fontVariant: ['tabular-nums'],
                              color: deltaColor,
                            }}
                          >
                            {formatAmount(Math.abs(cat.delta))}
                          </Text>
                        </View>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}
      </View>
    ) : (
      <View style={localStyles.netBreakdownList}>
        {reverseOrderedPoints.map((point) => {
          const selected = point.key === selectedPoint?.key;
          const netColor =
            point.net < 0
              ? isDark
                ? '#FB923C'
                : '#EA580C'
              : activeBlue;
          return (
            <Pressable
              key={`net-row-${point.key}`}
              accessibilityRole="button"
              accessibilityLabel={vi.statsTrendSelectBarA11y.replace(
                '{label}',
                point.rangeLabel,
              )}
              accessibilityState={{ selected }}
              onPress={() => setSelectedPointKey(point.key)}
              style={[
                localStyles.netCardRow,
                profile.reflowLargeText && {
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                },
                {
                  borderColor: selected
                    ? theme.brand.primaryBorder
                    : profile.highContrast
                      ? theme.card.border
                      : 'transparent',
                  borderWidth: selected || profile.highContrast ? 1.5 : 1,
                  backgroundColor: selected
                    ? isDark
                      ? 'rgba(59, 130, 246, 0.08)'
                      : '#F8FAFF'
                    : 'transparent',
                },
              ]}
            >
              <View
                style={[
                  localStyles.periodBadgePill,
                  { backgroundColor: theme.card.surfaceSubtle },
                ]}
              >
                <Text
                  variant="labelLarge"
                  numberOfLines={1}
                  style={{
                    fontWeight: '700',
                    color: theme.text.primary,
                    fontVariant: ['tabular-nums'],
                    textAlign: 'center',
                  }}
                >
                  {point.badgePrimary}
                </Text>
                {point.badgeSecondary.length > 0 && (
                  <Text
                    variant="labelSmall"
                    numberOfLines={1}
                    style={{
                      color: theme.text.secondary,
                      textAlign: 'center',
                    }}
                  >
                    {point.badgeSecondary}
                  </Text>
                )}
              </View>

              <View
                style={[
                  localStyles.netMiddleCol,
                  profile.reflowLargeText && { flex: 0, width: '100%' },
                ]}
              >
                <Text
                  variant="bodySmall"
                  numberOfLines={profile.reflowLargeText ? 2 : 1}
                  style={{
                    color: theme.text.secondary,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {`${vi.statsCalendarLegendIncome}  `}
                  <Text
                    style={{
                      fontWeight: '600',
                      color: theme.text.primary,
                    }}
                  >
                    {formatAmount(point.income)}
                  </Text>
                </Text>
                <Text
                  variant="bodySmall"
                  numberOfLines={profile.reflowLargeText ? 2 : 1}
                  style={{
                    color: theme.text.secondary,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {`${vi.statsCalendarLegendExpense}  `}
                  <Text
                    style={{
                      fontWeight: '600',
                      color: theme.text.primary,
                    }}
                  >
                    {formatAmount(point.expense)}
                  </Text>
                </Text>
              </View>

              <View
                style={[
                  localStyles.netRightCol,
                  profile.reflowLargeText && {
                    alignItems: 'flex-start',
                    flexDirection: 'row',
                    alignSelf: 'stretch',
                    justifyContent: 'space-between',
                  },
                ]}
              >
                <View style={localStyles.netLabelBadgeRow}>
                  {selected && (
                    <MaterialCommunityIcons
                      name="check-circle-outline"
                      size={14}
                      color={theme.brand.primaryStrong}
                    />
                  )}
                  <Text
                    variant="bodySmall"
                    style={{
                      color: theme.text.secondary,
                    }}
                  >
                    {vi.statsRemainingLabel}
                  </Text>
                </View>
                <Text
                  variant="titleSmall"
                  numberOfLines={profile.reflowLargeText ? 2 : 1}
                  style={{
                    fontWeight: '700',
                    fontVariant: ['tabular-nums'],
                    color: netColor,
                  }}
                >
                  {formatAmount(point.net)}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    );

  return (
    <Screen
      title={vi.statsTrendTitle}
      onBack={onClose}
      scroll={false}
      maxWidth={1120}
      headerRight={
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
      }
    >
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        onScroll={tabBarScroll.onScroll}
        scrollEventThrottle={tabBarScroll.scrollEventThrottle}
        contentContainerStyle={{
          gap: 14,
          paddingBottom: DesignSpacing.bottomTabClearance + insets.bottom,
        }}
      >
        <SegmentedOptionPicker<TrendGranularity>
          value={granularity}
          accessibilityLabel={vi.statsPeriodGranularityA11y}
          options={[
            { value: 'week', label: vi.statsGranularityWeekLong },
            { value: 'month', label: vi.statsGranularityMonthLong },
            { value: 'year', label: vi.statsGranularityYearLong },
          ]}
          onSelect={(value) => {
            setSelectedPointKey(null);
            setShowCompareInfo(false);
            setGranularity(value);
          }}
        />

        <SegmentedOptionPicker<MetricTab>
          value={metric}
          accessibilityLabel={vi.statsMetricTypeA11y}
          options={[
            { value: 'income', label: vi.transactionIncome },
            { value: 'expense', label: vi.transactionExpense },
            { value: 'net', label: vi.statsDifferenceLabel },
          ]}
          onSelect={(value) => {
            setShowCompareInfo(false);
            setMetric(value);
          }}
        />

        {loading && !data ? (
          <View style={localStyles.loaderBox}>
            <ActivityIndicator size="small" color={palette.primary} />
          </View>
        ) : error ? (
          <GlassCard variant="elevated" radius="lg" padding={DesignSpacing.md}>
            <View style={localStyles.errorBanner}>
              <Text
                accessibilityRole="alert"
                variant="bodyMedium"
                style={{ color: theme.finance.expenseText, flex: 1 }}
              >
                {error}
              </Text>
              <Button mode="outlined" onPress={() => void load()}>
                {vi.retry}
              </Button>
            </View>
          </GlassCard>
        ) : profile.isWide ? (
          <View style={localStyles.wideSplitRow}>
            <View style={localStyles.wideChartCol}>
              <GlassCard
                variant="elevated"
                radius="xl"
                padding={DesignSpacing.md}
              >
                {heroAndChartContent}
              </GlassCard>
            </View>
            <View style={localStyles.wideBreakdownCol}>
              <GlassCard
                variant="elevated"
                radius="xl"
                padding={DesignSpacing.md}
              >
                {breakdownContent}
              </GlassCard>
            </View>
          </View>
        ) : (
          <GlassCard
            variant="elevated"
            radius="xl"
            padding={DesignSpacing.md}
          >
            <View style={{ gap: 16 }}>
              {heroAndChartContent}
              <View
                style={[
                  localStyles.compactDividerSection,
                  { borderTopColor: theme.card.border },
                ]}
              >
                {breakdownContent}
              </View>
            </View>
          </GlassCard>
        )}
      </ScrollView>
    </Screen>
  );
}

const localStyles = StyleSheet.create({
  loaderBox: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
  },
  wideSplitRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
  },
  wideChartCol: {
    flex: 1.15,
  },
  wideBreakdownCol: {
    flex: 0.95,
  },
  compactDividerSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
  },
  heroBlock: {
    alignItems: 'center',
    gap: 6,
  },
  heroValue: {
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  comparePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 4,
    minHeight: STATS_MIN_TOUCH_TARGET,
    borderRadius: 12,
    maxWidth: '100%',
  },
  compareIconCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoIconBtn: {
    minWidth: STATS_MIN_TOUCH_TARGET,
    minHeight: STATS_MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoBanner: {
    marginTop: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    width: '100%',
  },
  chartHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  switchGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  chartSection: {
    gap: 4,
  },
  calloutBandRow: {
    flexDirection: 'row',
  },
  calloutCard: {
    position: 'absolute',
    top: 2,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignItems: 'center',
    gap: 1,
  },
  plotRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  yTickLabel: {
    position: 'absolute',
    right: 6,
    fontSize: STATS_MIN_FONT_SIZE,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  barsRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  barSlot: {
    flex: 1,
    alignItems: 'center',
    position: 'relative',
  },
  xAxisRow: {
    flexDirection: 'row',
    marginTop: 4,
  },
  xLabelSlot: {
    flex: 1,
    minHeight: STATS_MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  xTickLabel: {
    fontSize: STATS_MIN_FONT_SIZE,
    textAlign: 'center',
  },
  legendRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    marginTop: 4,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendSwatch: {
    width: 10,
    height: 10,
    borderRadius: 3,
  },
  breakdownSection: {
    gap: 12,
  },
  categoriesLoader: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  categoryList: {
    gap: 12,
    paddingTop: 4,
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: STATS_MIN_TOUCH_TARGET,
    gap: 12,
  },
  categoryAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryAmountsCol: {
    alignItems: 'flex-end',
    gap: 2,
  },
  categoryAmountsInline: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
  },
  categoryAmountText: {
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  categoryDeltaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  netBreakdownList: {
    gap: 10,
    paddingTop: 4,
  },
  netCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: STATS_MIN_TOUCH_TARGET,
    gap: 12,
    padding: 8,
    borderRadius: 12,
  },
  periodBadgePill: {
    minWidth: 64,
    minHeight: 54,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  netMiddleCol: {
    flex: 1,
    gap: 4,
  },
  netRightCol: {
    alignItems: 'flex-end',
    gap: 3,
  },
  netLabelBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
});
