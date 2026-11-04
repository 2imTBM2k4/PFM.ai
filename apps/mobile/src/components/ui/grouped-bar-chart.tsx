import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { formatCompactMoney as formatCompactVnd, formatMoney as formatVnd } from '@/utils/display-money';
import { DesignSpacing, useDesignTheme } from '@/constants/theme';

export interface GroupedBarPoint {
  label: string;
  income: number;
  expense: number;
}

export interface GroupedBarChartProps {
  data: readonly GroupedBarPoint[];
  height?: number;
  incomeColor?: string;
  expenseColor?: string;
  incomeLabel?: string;
  expenseLabel?: string;
  formatValue?: (value: number) => string;
  accessibilityLabel?: string;
}

/**
 * Responsive income/expense bar chart built from plain Views.
 * It keeps every month label on screen and uses rounded Vietnamese ticks,
 * unlike the default chart library which clipped the last label at 375pt.
 */
export function GroupedBarChart({
  data,
  height = 170,
  incomeColor,
  expenseColor,
  incomeLabel = 'Thu nhập',
  expenseLabel = 'Chi tiêu',
  formatValue = formatCompactVnd,
  accessibilityLabel,
}: GroupedBarChartProps) {
  const theme = useDesignTheme();
  const resolvedIncome = incomeColor ?? theme.finance.income;
  const resolvedExpense = expenseColor ?? theme.finance.expense;
  const scale = useMemo(() => buildScale(data), [data]);
  const summary =
    accessibilityLabel ??
    data
      .map(
        (point) =>
          `${point.label}: ${incomeLabel} ${formatVnd(point.income)}, ${expenseLabel} ${formatVnd(point.expense)}`,
      )
      .join('. ');

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary}
      style={styles.container}
    >
      <View style={styles.legendRow}>
        <LegendDot color={resolvedIncome} label={incomeLabel} />
        <LegendDot color={resolvedExpense} label={expenseLabel} />
      </View>

      <View style={styles.chartRow}>
        <View style={[styles.yAxis, { height }]}>
          {scale.ticks.map((tick) => (
            <Text
              key={tick}
              variant="labelSmall"
              numberOfLines={1}
              style={[styles.yLabel, { color: theme.text.muted }]}
            >
              {formatValue(tick)}
            </Text>
          ))}
        </View>

        <View style={styles.plotColumn}>
          <View style={[styles.plot, { height }]}>
            {scale.ticks.map((tick, index) => (
              <View
                key={`grid-${tick}`}
                style={[
                  styles.gridLine,
                  {
                    bottom: (index / (scale.ticks.length - 1)) * height,
                    backgroundColor: theme.card.border,
                  },
                ]}
              />
            ))}

            <View style={styles.barsRow}>
              {data.map((point) => {
                const incomeHeight = Math.max(
                  0,
                  (point.income / scale.max) * height,
                );
                const expenseHeight = Math.max(
                  0,
                  (point.expense / scale.max) * height,
                );
                return (
                  <View key={point.label} style={styles.group}>
                    <View
                      style={[
                        styles.bar,
                        {
                          height: incomeHeight,
                          backgroundColor: resolvedIncome,
                        },
                      ]}
                    />
                    <View
                      style={[
                        styles.bar,
                        {
                          height: expenseHeight,
                          backgroundColor: resolvedExpense,
                        },
                      ]}
                    />
                  </View>
                );
              })}
            </View>
          </View>

          <View style={styles.xAxis}>
            {data.map((point) => (
              <Text
                key={`label-${point.label}`}
                variant="labelSmall"
                numberOfLines={1}
                style={[styles.xLabel, { color: theme.text.secondary }]}
              >
                {point.label}
              </Text>
            ))}
          </View>
        </View>
      </View>
    </View>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  const theme = useDesignTheme();
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text
        variant="labelSmall"
        style={[styles.legendLabel, { color: theme.text.secondary }]}
      >
        {label}
      </Text>
    </View>
  );
}

function buildScale(data: readonly GroupedBarPoint[]) {
  const highest = Math.max(
    1,
    ...data.flatMap((point) => [point.income, point.expense]),
  );
  const rough = highest / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const rawStep =
    (normalized <= 1
      ? 1
      : normalized <= 2
        ? 2
        : normalized <= 2.5
          ? 2.5
          : normalized <= 5
            ? 5
            : 10) * magnitude;
  // VND ticks must stay whole numbers, including when the month has no data.
  const step = Math.max(1, Math.round(rawStep));
  const max = step * 4;
  return {
    max,
    ticks: [4, 3, 2, 1, 0].map((value) => value * step),
  };
}

const styles = StyleSheet.create({
  container: {
    gap: DesignSpacing.sm,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  legendDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  legendLabel: {},
  chartRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  yAxis: {
    width: 58,
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingRight: 2,
  },
  yLabel: {
    fontSize: 10,
    lineHeight: 12,
    textAlign: 'right',
  },
  plotColumn: {
    flex: 1,
    minWidth: 0,
  },
  plot: {
    position: 'relative',
    width: '100%',
  },
  gridLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  barsRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  group: {
    flex: 1,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 3,
  },
  bar: {
    width: 10,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
  },
  xAxis: {
    flexDirection: 'row',
    paddingTop: 6,
  },
  xLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 10,
  },
});
