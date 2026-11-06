import { useFocusEffect } from 'expo-router';
import { addMonths, monthKey, today } from '@pfm/domain';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { PieChart } from 'react-native-gifted-charts';
import {
  ActivityIndicator,
  Button,
  IconButton,
  ProgressBar,
  SegmentedButtons,
  Text,
} from 'react-native-paper';
import { Screen, styles } from '@/components/screen';
import { GlassCard, Pill } from '@/components/ui';
import { GroupedBarChart } from '@/components/ui/grouped-bar-chart';
import {
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import {
  readDashboard,
  readDailyTotals,
  type Dashboard,
  type DailyTotals,
} from '@/data/dashboard';
import { vi } from '@/messages/vi';
import { displayCategoryName } from '@/messages/seed-labels';
import { formatCurrencyAmount, usePreferences } from '@/state/preferences';
import { calendarDays, calendarMonth } from '@/utils/calendar';
import {
  formatCompactVndShort,
  formatDisplayDate,
  formatDisplayMonth,
  formatDisplayMonthShort,
} from '@/utils/display';
import {
  aggregatePeriodSummary,
  computeCategoryAllocation,
  shouldShowDailyTotals,
} from './stats-summary';

export type StatsRange = 1 | 3 | 6;

const localToday = () =>
  today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' });

/**
 * Stage 5: Statistics & Analytics screen with time range selector (1M / 3M / 6M),
 * Income vs Expense bar chart, and Category Allocation donut + breakdown list.
 */
export function StatsView({
  onSwitchToBudgets,
  onSwitchTab,
}: {
  onSwitchToBudgets?(): void;
  onSwitchTab?(tab: 'budgets' | 'goals' | 'stats'): void;
}) {
  const [anchorMonth, setAnchorMonth] = useState(() => monthKey(localToday()));
  const [rangeMonths, setRangeMonths] = useState<StatsRange>(6);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [dailyTotals, setDailyTotals] = useState<DailyTotals[]>([]);
  const [selectedDay, setSelectedDay] = useState(localToday);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const hasLoadedOnce = useRef(false);
  const request = useRef(0);

  const theme = useDesignTheme();
  const palette = useFinancePalette();
  const currency = usePreferences((state) => state.currency);
  const language = usePreferences((state) => state.language);
  usePreferences((state) => state.exchangeRate);
  const compactAmount = useCallback(
    (value: number) => formatCompactVndShort(value),
    [],
  );

  const load = useCallback(async () => {
    const currentId = ++request.current;
    if (!hasLoadedOnce.current) {
      setLoading(true);
    }
    setError(false);
    try {
      const next = await withDatabase(async (db) => ({
        dashboard: await readDashboard(db, anchorMonth),
        dailyTotals: await readDailyTotals(db, anchorMonth),
      }));
      if (currentId !== request.current) return;
      hasLoadedOnce.current = true;
      setDashboard(next.dashboard);
      setDailyTotals(next.dailyTotals);
    } catch {
      if (currentId === request.current) setError(true);
    } finally {
      if (currentId === request.current) setLoading(false);
    }
  }, [anchorMonth]);

  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(() => {
        void load();
      });
      return () => {
        cancelAnimationFrame(frame);
        request.current++;
      };
    }, [load]),
  );

  const visibleSeries = useMemo(() => {
    if (!dashboard) return [];
    return dashboard.months.slice(6 - rangeMonths);
  }, [dashboard, rangeMonths]);

  const periodSummary = useMemo(
    () => aggregatePeriodSummary(visibleSeries),
    [visibleSeries],
  );

  const categoryAllocation = computeCategoryAllocation(
    dashboard?.categories ?? [],
    vi.transactionUncategorized,
  );
  const calendar = useMemo(
    () => calendarDays(calendarMonth(`${anchorMonth}-01`)),
    [anchorMonth],
  );
  const dailyByDate = useMemo(
    () => new Map(dailyTotals.map((row) => [row.date, row])),
    [dailyTotals],
  );
  const selectedDate = selectedDay.startsWith(anchorMonth)
    ? selectedDay
    : `${anchorMonth}-01`;
  const selectedTotals = dailyByDate.get(selectedDate) ?? {
    income: 0,
    expense: 0,
  };
  const currentDate = localToday();

  return (
    <Screen title={vi.statsTabTitle}>
      <SegmentedButtons
        value="stats"
        density="small"
        onValueChange={(value) => {
          if (onSwitchTab) {
            onSwitchTab(value as 'budgets' | 'goals' | 'stats');
          } else if (value === 'budgets') {
            onSwitchToBudgets?.();
          }
        }}
        buttons={[
          {
            value: 'stats',
            label: vi.statsTabTitle,
            showSelectedCheck: false,
            labelStyle: localStyles.segmentLabel,
          },
          {
            value: 'budgets',
            label: vi.budgetsTabTitle,
            showSelectedCheck: false,
            labelStyle: localStyles.segmentLabel,
          },
          {
            value: 'goals',
            label: vi.goals,
            showSelectedCheck: false,
            labelStyle: localStyles.segmentLabel,
          },
        ]}
      />
      {/* Time Range Selector + Anchor Month Navigator */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.sm}
        style={localStyles.controlsCard}
      >
        <View style={styles.row}>
          <View style={styles.inlineRow}>
            <IconButton
              icon="chevron-left"
              size={20}
              style={{ margin: 0 }}
              accessibilityLabel={vi.budgetPreviousMonth}
              disabled={anchorMonth <= '0001-06'}
              onPress={() =>
                setAnchorMonth(monthKey(addMonths(`${anchorMonth}-01`, -1)))
              }
            />
            <Text
              variant="titleMedium"
              style={[
                styles.number,
                { fontWeight: '800', color: theme.text.primary },
              ]}
            >
              {formatDisplayMonth(anchorMonth)}
            </Text>
            <IconButton
              icon="chevron-right"
              size={20}
              style={{ margin: 0 }}
              accessibilityLabel={vi.budgetNextMonth}
              disabled={anchorMonth >= '9999-12'}
              onPress={() =>
                setAnchorMonth(monthKey(addMonths(`${anchorMonth}-01`, 1)))
              }
            />
          </View>

          <View style={localStyles.rangePills}>
            {(
              [
                [1, vi.statsRange1M],
                [3, vi.statsRange3M],
                [6, vi.statsRange6M],
              ] as const
            ).map(([months, label]) => (
              <Pill
                key={months}
                label={label}
                tone="primary"
                selected={rangeMonths === months}
                size="sm"
                onPress={() => setRangeMonths(months)}
              />
            ))}
          </View>
        </View>
      </GlassCard>

      {loading && !dashboard && (
        <View style={{ paddingVertical: 32, alignItems: 'center' }}>
          <ActivityIndicator size="large" accessibilityLabel={vi.loading} />
        </View>
      )}

      {error && (
        <GlassCard variant="default" radius="lg" padding={DesignSpacing.md}>
          <Text accessibilityRole="alert" style={{ color: palette.danger }}>
            {vi.overviewLoadError}
          </Text>
          <Button onPress={() => void load()}>{vi.retry}</Button>
        </GlassCard>
      )}

      {dashboard && (
        <>
          <GlassCard
            variant="elevated"
            radius="xl"
            padding={DesignSpacing.sm}
            style={{ gap: 10 }}
          >
            <Text
              variant="titleMedium"
              style={{ fontWeight: '800', color: theme.text.primary }}
            >
              {language === 'en'
                ? 'Daily income and expenses'
                : 'Thu chi theo ngày'}
            </Text>
            <View style={localStyles.calendarGrid}>
              {(language === 'en'
                ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                : ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']
              ).map((label) => (
                <Text key={label} style={localStyles.calendarWeekday}>
                  {label}
                </Text>
              ))}
              {calendar.map((day, index) =>
                day ? (
                  <Pressable
                    key={day.date}
                    accessibilityRole="button"
                    accessibilityState={{
                      selected:
                        selectedDate === day.date &&
                        shouldShowDailyTotals(day.date, currentDate),
                    }}
                    accessibilityLabel={
                      shouldShowDailyTotals(day.date, currentDate)
                        ? `${formatDisplayDate(day.date)}. ${language === 'en' ? 'Income' : 'Thu nhập'} ${formatCurrencyAmount(dailyByDate.get(day.date)?.income ?? 0, currency)}. ${language === 'en' ? 'Expense' : 'Chi tiêu'} ${formatCurrencyAmount(dailyByDate.get(day.date)?.expense ?? 0, currency)}`
                        : formatDisplayDate(day.date)
                    }
                    disabled={!shouldShowDailyTotals(day.date, currentDate)}
                    onPress={() => setSelectedDay(day.date)}
                    style={[
                      localStyles.calendarCell,
                      selectedDate === day.date &&
                        shouldShowDailyTotals(day.date, currentDate) && {
                          backgroundColor: theme.brand.primarySoft,
                        },
                    ]}
                  >
                    <Text
                      style={{
                        fontWeight:
                          selectedDate === day.date &&
                          shouldShowDailyTotals(day.date, currentDate)
                            ? '800'
                            : '600',
                        color: theme.text.primary,
                      }}
                    >
                      {day.day}
                    </Text>
                    {shouldShowDailyTotals(day.date, currentDate) && (
                      <>
                        <Text
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          style={{
                            fontSize: 10,
                            color: theme.finance.incomeText,
                          }}
                        >
                          +
                          {compactAmount(
                            dailyByDate.get(day.date)?.income ?? 0,
                          )}
                        </Text>
                        <Text
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          style={{
                            fontSize: 10,
                            color: theme.finance.expenseText,
                          }}
                        >
                          −
                          {compactAmount(
                            dailyByDate.get(day.date)?.expense ?? 0,
                          )}
                        </Text>
                      </>
                    )}
                  </Pressable>
                ) : (
                  <View
                    key={`empty-${index}`}
                    style={localStyles.calendarCell}
                  />
                ),
              )}
            </View>
            {shouldShowDailyTotals(selectedDate, currentDate) && (
              <Text
                variant="bodyMedium"
                style={{ color: theme.text.secondary }}
              >
                {formatDisplayDate(selectedDate)} · +
                {formatCurrencyAmount(selectedTotals.income, currency)} · −
                {formatCurrencyAmount(selectedTotals.expense, currency)}
              </Text>
            )}
          </GlassCard>
          {/* 3 Period Summary Cards: Income, Expenses, Net Savings */}
          <View style={localStyles.summaryGrid}>
            <GlassCard
              variant="elevated"
              radius="lg"
              padding={14}
              style={localStyles.summaryCard}
            >
              <Pill label={vi.transactionIncome} tone="income" size="sm" />
              <Text
                variant="titleMedium"
                numberOfLines={1}
                adjustsFontSizeToFit
                style={[
                  styles.number,
                  { fontWeight: '800', color: theme.finance.incomeText },
                ]}
              >
                {compactAmount(periodSummary.totalIncome)}
              </Text>
            </GlassCard>

            <GlassCard
              variant="elevated"
              radius="lg"
              padding={14}
              style={localStyles.summaryCard}
            >
              <Pill label={vi.transactionExpense} tone="expense" size="sm" />
              <Text
                variant="titleMedium"
                numberOfLines={1}
                adjustsFontSizeToFit
                style={[
                  styles.number,
                  { fontWeight: '800', color: theme.finance.expenseText },
                ]}
              >
                {compactAmount(periodSummary.totalExpense)}
              </Text>
            </GlassCard>

            <GlassCard
              variant="elevated"
              radius="lg"
              padding={14}
              style={localStyles.summaryCard}
            >
              <Pill
                label={`${periodSummary.savingsRatePercent}%`}
                tone="savings"
                size="sm"
              />
              <Text
                variant="titleMedium"
                numberOfLines={1}
                adjustsFontSizeToFit
                style={[
                  styles.number,
                  { fontWeight: '800', color: theme.text.primary },
                ]}
              >
                {periodSummary.netSavings > 0 ? '+' : ''}
                {compactAmount(periodSummary.netSavings)}
              </Text>
              <Text
                variant="labelSmall"
                style={{ color: theme.text.secondary }}
              >
                {vi.statsNetLabel}
              </Text>
            </GlassCard>
          </View>

          {/* Income vs Expense Grouped Bar Chart */}
          <GlassCard
            variant="elevated"
            radius="xl"
            padding={DesignSpacing.lg}
            style={{ gap: 14 }}
          >
            <Text
              variant="titleMedium"
              style={{ fontWeight: '800', color: theme.text.primary }}
            >
              {vi.statsIncomeVsExpense}
            </Text>
            <GroupedBarChart
              data={visibleSeries.map((point) => ({
                label: formatDisplayMonthShort(point.month),
                income: point.income,
                expense: point.expense,
              }))}
              height={180}
              incomeColor={theme.finance.income}
              expenseColor={theme.finance.expense}
              incomeLabel={vi.transactionIncome}
              expenseLabel={vi.transactionExpense}
              formatValue={compactAmount}
            />
          </GlassCard>

          {/* Category Allocation Donut Chart + Breakdown List */}
          <GlassCard
            variant="elevated"
            radius="xl"
            padding={DesignSpacing.lg}
            style={{ gap: 16 }}
          >
            <View style={styles.row}>
              <Text
                variant="titleMedium"
                style={{ fontWeight: '800', color: theme.text.primary }}
              >
                {vi.statsCategoryAllocation}
              </Text>
              <Pill
                label={formatDisplayMonth(anchorMonth)}
                tone="glass"
                size="sm"
              />
            </View>

            {categoryAllocation.items.length === 0 ? (
              <Text
                variant="bodyMedium"
                style={{ color: theme.text.secondary, textAlign: 'center' }}
              >
                {vi.statsNoExpenseData}
              </Text>
            ) : (
              <>
                <View style={{ alignItems: 'center', paddingVertical: 6 }}>
                  <PieChart
                    donut
                    radius={78}
                    innerRadius={50}
                    innerCircleColor={theme.card.surfaceElevated}
                    data={categoryAllocation.items.map((item) => ({
                      value: item.amount,
                      color: item.color,
                    }))}
                    centerLabelComponent={() => (
                      <View style={{ alignItems: 'center' }}>
                        <Text
                          variant="labelSmall"
                          style={{ color: theme.text.muted }}
                        >
                          {vi.transactionExpense}
                        </Text>
                        <Text
                          variant="labelLarge"
                          style={[
                            styles.number,
                            { fontWeight: '800', color: theme.text.primary },
                          ]}
                        >
                          {formatCompactVndShort(
                            categoryAllocation.totalExpense,
                          )}
                        </Text>
                      </View>
                    )}
                  />
                </View>

                <View style={{ gap: 12 }}>
                  {categoryAllocation.items.map((item) => (
                    <View key={item.id} style={{ gap: 6 }}>
                      <View style={styles.row}>
                        <View style={localStyles.catLeft}>
                          <View
                            style={[
                              localStyles.legendDot,
                              { backgroundColor: item.color },
                            ]}
                          />
                          <Text
                            variant="bodyMedium"
                            style={{
                              fontWeight: '700',
                              color: theme.text.primary,
                              flexShrink: 1,
                            }}
                          >
                            {displayCategoryName(item.name)}
                          </Text>
                          <Pill
                            label={`${item.percentage}%`}
                            tone="neutral"
                            size="sm"
                          />
                        </View>
                        <Text
                          variant="bodyMedium"
                          style={[
                            styles.number,
                            {
                              fontWeight: '700',
                              color: theme.text.primary,
                            },
                          ]}
                        >
                          {formatCurrencyAmount(item.amount, currency)}
                        </Text>
                      </View>
                      <ProgressBar
                        progress={Math.min(1, item.percentage / 100)}
                        color={item.color}
                        style={{
                          height: 7,
                          borderRadius: 4,
                          backgroundColor: theme.brand.primarySoft,
                        }}
                      />
                    </View>
                  ))}
                </View>
              </>
            )}
          </GlassCard>
        </>
      )}
    </Screen>
  );
}

const localStyles = StyleSheet.create({
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarWeekday: {
    width: '14.2857%',
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '700',
  },
  calendarCell: {
    width: '14.2857%',
    minHeight: 58,
    paddingHorizontal: 1,
    paddingVertical: 3,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  modeSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  controlsCard: {
    gap: 8,
  },
  rangePills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  summaryGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  summaryCard: {
    flex: 1,
    gap: 8,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  catLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  segmentLabel: {
    fontSize: 13,
    fontWeight: '700',
  },
});
