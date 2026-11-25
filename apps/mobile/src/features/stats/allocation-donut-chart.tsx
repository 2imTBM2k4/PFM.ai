import { useMemo, useState } from 'react';
import {
  PixelRatio,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from 'react-native-paper';
import Svg, { Circle, Path } from 'react-native-svg';
import MaterialCommunityIcons from '@/components/platform-icon';
import { DesignRadius, useDesignTheme } from '@/constants/theme';
import { useAccessibilityPreferences } from '@/hooks/use-accessibility-preferences';
import { getStatsResponsiveProfile, STATS_MIN_TOUCH_TARGET } from './stats-layout';
import {
  computeDonutCallouts,
  type DonutCalloutPoint,
  type DonutCategoryItem,
} from './stats-summary';

function polarPoint(cx: number, cy: number, radius: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

function describeDonutSector(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startDeg: number,
  endDeg: number,
): string {
  const sweep = endDeg - startDeg;
  const largeArc = sweep > 180 ? 1 : 0;
  const outerStart = polarPoint(cx, cy, outerRadius, startDeg);
  const outerEnd = polarPoint(cx, cy, outerRadius, endDeg);
  const innerEnd = polarPoint(cx, cy, innerRadius, endDeg);
  const innerStart = polarPoint(cx, cy, innerRadius, startDeg);

  return [
    `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
    `A ${outerRadius.toFixed(2)} ${outerRadius.toFixed(2)} 0 ${largeArc} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
    `L ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
    `A ${innerRadius.toFixed(2)} ${innerRadius.toFixed(2)} 0 ${largeArc} 0 ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

interface AllocationDonutChartProps {
  slices: readonly DonutCategoryItem[];
  selectedId?: string | null;
  onSelectSlice?(id: string): void;
  chartAccessibilityLabel: string;
}

/**
 * Renders a Donut allocation chart with external category callout badges and dashed leader lines.
 * Falls back to a centered donut plus wrapped legend when fontScale > 1.3 or container width is narrow.
 */
export function AllocationDonutChart({
  slices,
  selectedId,
  onSelectSlice,
  chartAccessibilityLabel,
}: AllocationDonutChartProps) {
  const theme = useDesignTheme();
  const fontScale = PixelRatio.getFontScale();
  const { reduceTransparency, increaseContrast } =
    useAccessibilityPreferences();
  const [containerWidth, setContainerWidth] = useState(312);

  const profile = getStatsResponsiveProfile({
    width: containerWidth,
    fontScale,
    reduceTransparency,
    increaseContrast,
  });
  const compactFallback = profile.reflowLargeText || containerWidth < 280;
  const outerRadius = useMemo(
    () =>
      compactFallback
        ? 64
        : Math.max(48, Math.min(64, Math.floor(containerWidth * 0.2))),
    [compactFallback, containerWidth],
  );
  const innerRadius = Math.round(outerRadius * 0.54);
  const chartHeight = compactFallback ? 154 : 228;
  const centerX = containerWidth / 2;
  const centerY = chartHeight / 2;

  const callouts = useMemo(() => {
    const gap = Math.max(38, Math.round(chartHeight / Math.max(4, slices.length)));
    return computeDonutCallouts(
      slices,
      centerX,
      centerY,
      outerRadius,
      24,
      chartHeight - 24,
      Math.min(44, gap),
    );
  }, [centerX, centerY, chartHeight, outerRadius, slices]);

  const sideColumnWidth = Math.max(
    68,
    Math.floor(centerX - outerRadius - 18),
  );
  const leftColumnRightEdge = sideColumnWidth;
  const rightColumnLeftEdge = containerWidth - sideColumnWidth;

  const renderCalloutChip = (point: DonutCalloutPoint) => {
    const { item, side, labelY } = point;
    const isSelected = selectedId === item.id;
    const isLeft = side === 'left';

    return (
      <Pressable
        key={item.id}
        accessibilityRole="button"
        accessibilityLabel={`${item.name} ${item.percentLabel}`}
        accessibilityState={{ selected: isSelected }}
        onPress={() => onSelectSlice?.(item.id)}
        style={[
          localStyles.calloutBox,
          {
            top: labelY - 22,
            left: isLeft ? 0 : rightColumnLeftEdge,
            width: sideColumnWidth,
            alignItems: isLeft ? 'flex-start' : 'flex-end',
          },
        ]}
      >
        <View
          style={[
            localStyles.calloutPill,
            {
              backgroundColor: profile.solidGlass
                ? theme.card.surfaceElevated
                : isSelected
                  ? `${item.color}28`
                  : `${item.color}18`,
              borderColor: isSelected
                ? item.color
                : profile.highContrast
                  ? theme.card.border
                  : 'transparent',
              borderWidth: profile.highContrast || isSelected ? 1.5 : 1,
            },
          ]}
        >
          <MaterialCommunityIcons
            name={item.icon as never}
            size={12}
            color={item.color}
          />
          <Text
            variant="labelSmall"
            style={[
              localStyles.calloutPercent,
              { color: item.color },
            ]}
            numberOfLines={1}
          >
            {item.percentLabel}
          </Text>
          {isSelected && (
            <MaterialCommunityIcons
              name="check"
              size={11}
              color={item.color}
            />
          )}
        </View>
        <Text
          variant="labelSmall"
          style={[
            localStyles.calloutName,
            {
              color: isSelected || profile.highContrast ? theme.text.primary : theme.text.secondary,
              fontWeight: isSelected ? '700' : '500',
              textAlign: isLeft ? 'left' : 'right',
            },
          ]}
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {item.name}
        </Text>
      </Pressable>
    );
  };

  return (
    <View
      onLayout={(e) => {
        const nextWidth = Math.floor(e.nativeEvent.layout.width);
        if (nextWidth > 0 && Math.abs(nextWidth - containerWidth) > 2) {
          setContainerWidth(nextWidth);
        }
      }}
      style={localStyles.container}
    >
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={chartAccessibilityLabel}
        style={[localStyles.svgStage, { height: chartHeight }]}
      >
        <Svg width={containerWidth} height={chartHeight}>
          {/* Subtle outer halo matching the layered ring finish */}
          <Circle
            cx={centerX}
            cy={centerY}
            r={outerRadius + 3}
            stroke={theme.card.border}
            strokeOpacity={0.35}
            strokeWidth={1.5}
            fill="none"
          />

          {/* Donut slices */}
          {callouts.length === 1 ? (
            <Circle
              cx={centerX}
              cy={centerY}
              r={(outerRadius + innerRadius) / 2}
              stroke={callouts[0].item.color}
              strokeWidth={outerRadius - innerRadius}
              fill="none"
              onPress={() => onSelectSlice?.(callouts[0].item.id)}
            />
          ) : (
            callouts.map((point) => {
              const sweep = point.endAngleDeg - point.startAngleDeg;
              const pad = Math.min(1.6, sweep * 0.14);
              const sDeg = point.startAngleDeg + pad;
              const eDeg = point.endAngleDeg - pad;
              if (eDeg <= sDeg) return null;
              const isSelected = selectedId === point.item.id;
              return (
                <Path
                  key={point.item.id}
                  d={describeDonutSector(
                    centerX,
                    centerY,
                    isSelected ? outerRadius + 3 : outerRadius,
                    innerRadius,
                    sDeg,
                    eDeg,
                  )}
                  fill={point.item.color}
                  onPress={() => onSelectSlice?.(point.item.id)}
                />
              );
            })
          )}

          {/* Inner circle fill to keep donut center crisp */}
          <Circle
            cx={centerX}
            cy={centerY}
            r={innerRadius}
            fill={theme.card.surfaceElevated}
          />

          {/* Dashed leader lines for normal-scale layout */}
          {!compactFallback &&
            callouts.map((point) => {
              const isLeft = point.side === 'left';
              const targetX = isLeft
                ? leftColumnRightEdge + 4
                : rightColumnLeftEdge - 4;
              const midX = isLeft
                ? Math.min(point.elbowX, targetX + 10)
                : Math.max(point.elbowX, targetX - 10);

              return (
                <Path
                  key={`leader-${point.item.id}`}
                  d={`M ${point.anchorX.toFixed(2)} ${point.anchorY.toFixed(2)} L ${midX.toFixed(2)} ${point.labelY.toFixed(2)} L ${targetX.toFixed(2)} ${point.labelY.toFixed(2)}`}
                  stroke={
                    selectedId === point.item.id
                      ? point.item.color
                      : profile.highContrast
                        ? theme.text.secondary
                        : theme.text.muted
                  }
                  strokeOpacity={
                    selectedId === point.item.id || profile.highContrast
                      ? 1
                      : 0.75
                  }
                  strokeWidth={selectedId === point.item.id || profile.highContrast ? 1.5 : 1}
                  strokeDasharray="3 3"
                  fill="none"
                />
              );
            })}
        </Svg>

        {!compactFallback && callouts.map(renderCalloutChip)}
      </View>

      {/* Accessible stacked legend for large system fontScale or ultra-narrow screens */}
      {compactFallback && (
        <View style={localStyles.fallbackLegend}>
          {slices.map((item) => {
            const isSelected = selectedId === item.id;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={`${item.name} ${item.percentLabel}`}
                accessibilityState={{ selected: isSelected }}
                onPress={() => onSelectSlice?.(item.id)}
                style={[
                  localStyles.fallbackLegendChip,
                  {
                    backgroundColor: profile.solidGlass
                      ? theme.card.surfaceElevated
                      : `${item.color}18`,
                    borderColor: isSelected
                      ? item.color
                      : profile.highContrast
                        ? theme.card.border
                        : 'transparent',
                    borderWidth: profile.highContrast || isSelected ? 1.5 : 1,
                  },
                ]}
              >
                <MaterialCommunityIcons
                  name={item.icon as never}
                  size={15}
                  color={item.color}
                />
                <Text
                  variant="labelMedium"
                  style={[
                    localStyles.fallbackLegendText,
                    { color: item.color },
                  ]}
                >
                  {item.percentLabel}
                </Text>
                <Text
                  variant="bodyMedium"
                  style={{ color: theme.text.primary, flexShrink: 1 }}
                  numberOfLines={profile.reflowLargeText ? 3 : 2}
                >
                  {item.name}
                </Text>
                {isSelected && (
                  <MaterialCommunityIcons
                    name="check"
                    size={14}
                    color={item.color}
                  />
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const localStyles = StyleSheet.create({
  container: {
    width: '100%',
  },
  svgStage: {
    width: '100%',
    position: 'relative',
  },
  calloutBox: {
    position: 'absolute',
    minHeight: STATS_MIN_TOUCH_TARGET,
    justifyContent: 'center',
    gap: 2,
  },
  calloutPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: DesignRadius.xs,
    borderWidth: 1,
  },
  calloutPercent: {
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  calloutName: {
    lineHeight: 15,
  },
  fallbackLegend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
    justifyContent: 'center',
  },
  fallbackLegendChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: STATS_MIN_TOUCH_TARGET,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: DesignRadius.sm,
    borderWidth: 1,
    maxWidth: '100%',
  },
  fallbackLegendText: {
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});
