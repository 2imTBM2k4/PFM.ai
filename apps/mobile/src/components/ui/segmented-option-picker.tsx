import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { createWebTransitionStyle, MotionSpring } from '@/constants/motion';
import {
  createSoftShadow,
  DesignRadius,
  useDesignTheme,
} from '@/constants/theme';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SegmentedOptionPickerProps<T extends string> {
  label?: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onSelect(value: T): void;
  disabled?: boolean;
  accessibilityLabel?: string;
}

const TRACK_PADDING = 3;

/**
 * Cross-platform iOS-inspired segmented control with a spring-animated sliding
 * thumb for Android and Web. iOS uses the native SwiftUI Picker variant.
 */
export function SegmentedOptionPicker<T extends string>({
  label,
  value,
  options,
  onSelect,
  disabled = false,
  accessibilityLabel,
}: SegmentedOptionPickerProps<T>) {
  const theme = useDesignTheme();
  const reduceMotion = useReducedMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const [hoveredValue, setHoveredValue] = useState<string | null>(null);
  const isWeb = Platform.OS === 'web';

  const count = Math.max(1, options.length);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const innerWidth = Math.max(0, trackWidth - TRACK_PADDING * 2);
  const segmentWidth = innerWidth / count;

  const thumbX = useSharedValue(activeIndex * segmentWidth);

  useEffect(() => {
    const target = activeIndex * segmentWidth;
    if (reduceMotion || segmentWidth === 0) {
      thumbX.set(target);
    } else {
      thumbX.set(withSpring(target, MotionSpring.snappy));
    }
  }, [activeIndex, reduceMotion, segmentWidth, thumbX]);

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: thumbX.value }],
  }));

  return (
    <View style={styles.container}>
      {!!label && (
        <Text
          variant="labelMedium"
          style={[styles.label, { color: theme.text.secondary }]}
        >
          {label}
        </Text>
      )}
      <View
        accessibilityRole="tablist"
        accessibilityLabel={accessibilityLabel ?? label}
        onLayout={(event) => {
          const nextWidth = event.nativeEvent.layout.width;
          if (nextWidth > 0 && nextWidth !== trackWidth) {
            setTrackWidth(nextWidth);
          }
        }}
        style={[
          styles.track,
          {
            backgroundColor: theme.card.surfaceSubtle,
            borderColor: theme.card.border,
          },
        ]}
      >
        {segmentWidth > 0 && (
          <Animated.View
            testID="segmented-active-thumb"
            pointerEvents="none"
            style={[
              styles.thumb,
              createSoftShadow(theme.mode, 'sm'),
              {
                width: segmentWidth,
                backgroundColor: theme.card.surfaceElevated,
                borderColor:
                  theme.mode === 'dark'
                    ? 'rgba(255, 255, 255, 0.12)'
                    : 'rgba(17, 24, 39, 0.06)',
              },
              thumbStyle,
            ]}
          />
        )}
        {options.map((option) => {
          const selected = option.value === value;
          const isDisabled = disabled || Boolean(option.disabled);
          const isHovered = isWeb && hoveredValue === option.value && !selected;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="tab"
              accessibilityLabel={option.label}
              accessibilityState={{ selected, disabled: isDisabled }}
              disabled={isDisabled}
              onHoverIn={
                isWeb && !isDisabled
                  ? () => setHoveredValue(option.value)
                  : undefined
              }
              onHoverOut={isWeb ? () => setHoveredValue(null) : undefined}
              onPress={() => {
                if (!isDisabled && option.value !== value) {
                  onSelect(option.value);
                }
              }}
              style={[
                styles.segment,
                createWebTransitionStyle(),
                selected &&
                  segmentWidth === 0 && {
                    backgroundColor: theme.card.surfaceElevated,
                  },
                isHovered && {
                  backgroundColor:
                    theme.mode === 'dark'
                      ? 'rgba(255, 255, 255, 0.06)'
                      : 'rgba(17, 24, 39, 0.04)',
                },
                isDisabled && styles.disabledSegment,
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.segmentLabel,
                  {
                    color: selected
                      ? theme.text.primary
                      : theme.text.secondary,
                    fontWeight: selected ? '700' : '500',
                  },
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 6,
    width: '100%',
  },
  label: {
    fontWeight: '600',
  },
  track: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: TRACK_PADDING,
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
    position: 'relative',
    minHeight: 40,
  },
  thumb: {
    position: 'absolute',
    top: TRACK_PADDING,
    bottom: TRACK_PADDING,
    left: TRACK_PADDING,
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
  },
  segment: {
    flex: 1,
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: DesignRadius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabledSegment: {
    opacity: 0.45,
  },
  segmentLabel: {
    fontSize: 12,
    textAlign: 'center',
  },
});