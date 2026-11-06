import type { PropsWithChildren } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import {
  createSoftShadow,
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
} from '@/constants/theme';

export interface GlassCardProps extends PropsWithChildren {
  variant?: 'default' | 'elevated' | 'subtle' | 'accent';
  radius?: 'md' | 'lg' | 'xl';
  padding?: number;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
}

/**
 * Reusable glassmorphic card with large rounded corners (20-28px), translucent white surface,
 * crisp highlight border, and soft ambient shadow.
 */
export function GlassCard({
  children,
  variant = 'default',
  radius = 'lg',
  padding = DesignSpacing.lg,
  style,
  onPress,
  accessibilityLabel,
}: GlassCardProps) {
  const theme = useDesignTheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const borderRadius = DesignRadius[radius];
  const backgroundColor =
    variant === 'elevated'
      ? theme.card.surfaceElevated
      : variant === 'subtle'
        ? theme.card.surfaceSubtle
        : variant === 'accent'
          ? theme.brand.primarySoft
          : theme.card.surface;

  const borderColor =
    variant === 'accent' ? theme.brand.primaryBorder : theme.card.border;

  const cardStyle: StyleProp<ViewStyle> = [
    styles.card,
    createSoftShadow(theme.mode, variant === 'elevated' ? 'lg' : 'md'),
    {
      backgroundColor,
      borderColor,
      borderRadius,
      padding,
    },
    style,
  ];

  if (!onPress) {
    return (
      <View accessibilityLabel={accessibilityLabel} style={cardStyle}>
        {children}
      </View>
    );
  }

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        onPressIn={() => {
          scale.set(withSpring(0.98, { damping: 18, stiffness: 280 }));
        }}
        onPressOut={() => {
          scale.set(withSpring(1, { damping: 18, stiffness: 280 }));
        }}
        style={cardStyle}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    // Shadow and clipping cannot share a layer on iOS. Current card contents
    // have their own padding/radii; keep overflow visible without adding a
    // wrapper that would change callers' flex sizing or gap placement.
    overflow: 'visible',
  },
});
