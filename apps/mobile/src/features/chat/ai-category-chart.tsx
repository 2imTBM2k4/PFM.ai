import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { formatMoney as formatVnd } from '@/utils/display-money';
import { styles as screenStyles } from '@/components/screen';
import { DesignRadius, DesignSpacing, useDesignTheme } from '@/constants/theme';
import { vi } from '@/messages/vi';
import type { AIChartItem } from '@/services/ai-service';

export interface AICategoryBarChartProps {
  title?: string;
  items: readonly AIChartItem[];
}

/**
 * Compact horizontal allocation list used inside an AI reply.
 * Full category names stay visible at phone width instead of being truncated
 * by a three-column chart.
 */
export const AICategoryBarChart = memo(function AICategoryBarChart({
  title = vi.aiChartTitle,
  items,
}: AICategoryBarChartProps) {
  const theme = useDesignTheme();
  if (!items.length) return null;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={items
        .map(
          (item) =>
            `${item.category}: ${item.percentage}%, ${formatVnd(item.amount)}`,
        )
        .join('. ')}
      style={[
        styles.container,
        {
          backgroundColor: theme.card.surfaceElevated,
          borderColor: theme.card.border,
        },
      ]}
    >
      <Text
        variant="labelLarge"
        style={{ color: theme.text.primary, fontWeight: '700' }}
      >
        {title}
      </Text>

      <View style={styles.list}>
        {items.map((item, index) => (
          <View key={`${item.category}-${index}`} style={styles.item}>
            <View style={styles.itemHeader}>
              <View style={styles.category}>
                <View
                  style={[styles.colorDot, { backgroundColor: item.color }]}
                />
                <Text
                  variant="bodySmall"
                  style={[styles.categoryLabel, { color: theme.text.primary }]}
                >
                  {item.category}
                </Text>
              </View>
              <Text
                variant="labelSmall"
                style={[screenStyles.number, { color: theme.text.secondary }]}
              >
                {item.percentage}% · {formatVnd(item.amount)}
              </Text>
            </View>
            <View
              style={[
                styles.track,
                { backgroundColor: theme.brand.primarySoft },
              ]}
            >
              <View
                style={[
                  styles.fill,
                  {
                    width: `${Math.min(100, Math.max(2, item.percentage))}%`,
                    backgroundColor: item.color,
                  },
                ]}
              />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    marginTop: 8,
    padding: DesignSpacing.md,
    borderRadius: DesignRadius.md,
    borderWidth: 1,
    gap: 12,
  },
  list: {
    gap: 10,
  },
  item: {
    gap: 6,
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  category: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flex: 1,
    minWidth: 0,
  },
  colorDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    flexShrink: 0,
  },
  categoryLabel: {
    flexShrink: 1,
    fontWeight: '600',
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: {
    height: 6,
    borderRadius: 3,
  },
});
