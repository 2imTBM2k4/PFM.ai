import { useEffect, useState } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { MotionSpring } from '@/constants/motion';
import { DesignRadius, useDesignTheme } from '@/constants/theme';

export interface AnimatedProgressBarProps {
  progress: number;
  color: string;
  trackColor?: string;
  height?: number;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityValue?: { min?: number; max?: number; now?: number };
}

/** Clamps a numeric progress value into the [0, 1] range. */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Smooth spring-animated progress bar with rounded capsule geometry and
 * reduced-motion accessibility support across iOS, Android, and Web.
 */
export function AnimatedProgressBar({
  progress,
  color,
  trackColor,
  height = 8,
  style,
  accessibilityLabel,
  accessibilityValue,
}: AnimatedProgressBarProps) {
  const theme = useDesignTheme();
  const reduceMotion = useReducedMotion();
  const clamped = clampProgress(progress);
  const [trackWidth, setTrackWidth] = useState(0);
  const animatedProgress = useSharedValue(reduceMotion ? clamped : 0);

  useEffect(() => {
    if (reduceMotion) {
      animatedProgress.set(clamped);
    } else {
      animatedProgress.set(withSpring(clamped, MotionSpring.progress));
    }
  }, [animatedProgress, clamped, reduceMotion]);

  const fillStyle = useAnimatedStyle(() => {
    if (trackWidth > 0) {
      return {
        width: Math.max(
          animatedProgress.value > 0 ? height : 0,
          trackWidth * animatedProgress.value,
        ),
      };
    }
    return {
      width: `${Math.round(animatedProgress.value * 100)}%`,
    };
  }, [trackWidth, height]);

  const resolvedTrack =
    trackColor ??
    (theme.mode === 'dark'
      ? 'rgba(255, 255, 255, 0.12)'
      : 'rgba(17, 24, 39, 0.08)');

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={
        accessibilityValue ?? {
          min: 0,
          max: 100,
          now: Math.round(clamped * 100),
        }
      }
      onLayout={(event) => {
        const nextWidth = event.nativeEvent.layout.width;
        if (nextWidth > 0 && nextWidth !== trackWidth) {
          setTrackWidth(nextWidth);
        }
      }}
      style={[
        styles.track,
        {
          height,
          borderRadius: DesignRadius.pill,
          backgroundColor: resolvedTrack,
        },
        style,
      ]}
    >
      <Animated.View
        style={[
          styles.fill,
          {
            height,
            borderRadius: DesignRadius.pill,
            backgroundColor: color,
          },
          Platform.OS === 'web' &&
            ({
              boxShadow: `0 0 10px ${color}40`,
            } as unknown as ViewStyle),
          fillStyle,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    overflow: 'hidden',
  },
  fill: {
    minWidth: 0,
  },
});