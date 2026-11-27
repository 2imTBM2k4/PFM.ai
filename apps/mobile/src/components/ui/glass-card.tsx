import { useState, type PropsWithChildren } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import {
  createWebGlassStyle,
  createWebTransitionStyle,
  getStaggerDelay,
  MotionDuration,
  MotionSpring,
} from '@/constants/motion';
import { useResponsiveLayout } from '@/constants/responsive-layout';
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
  enterIndex?: number;
}

/**
 * Reusable glassmorphic card with large rounded corners (20-28px), subtle web frosted depth,
 * crisp highlight border, optional staggered entrance, and tactile hover/press feedback.
 */
export function GlassCard({
  children,
  variant = 'default',
  radius = 'lg',
  padding,
  style,
  onPress,
  accessibilityLabel,
  enterIndex,
}: GlassCardProps) {
  const theme = useDesignTheme();
  const { isCompactPhone } = useResponsiveLayout();
  const resolvedPadding =
    padding ?? (isCompactPhone ? 14 : DesignSpacing.lg);
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const [hovered, setHovered] = useState(false);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const borderRadius = DesignRadius[radius];
  const isWeb = Platform.OS === 'web';
  const webGlassSurface =
    variant === 'elevated'
      ? theme.mode === 'dark'
        ? 'rgba(28, 28, 30, 0.84)'
        : 'rgba(255, 255, 255, 0.88)'
      : variant === 'subtle'
        ? theme.mode === 'dark'
          ? 'rgba(44, 44, 46, 0.72)'
          : 'rgba(242, 242, 247, 0.78)'
        : variant === 'accent'
          ? theme.brand.primarySoft
          : theme.mode === 'dark'
            ? 'rgba(28, 28, 30, 0.78)'
            : 'rgba(255, 255, 255, 0.82)';

  const backgroundColor = isWeb
    ? webGlassSurface
    : variant === 'elevated'
      ? theme.card.surfaceElevated
      : variant === 'subtle'
        ? theme.card.surfaceSubtle
        : variant === 'accent'
          ? theme.brand.primarySoft
          : theme.card.surface;

  const borderColor =
    hovered && onPress
      ? theme.brand.primaryBorder
      : variant === 'accent'
        ? theme.brand.primaryBorder
        : theme.card.border;

  const entering =
    enterIndex !== undefined && !reduceMotion
      ? FadeInDown.duration(MotionDuration.entrance)
          .delay(getStaggerDelay(enterIndex))
          .springify()
          .damping(MotionSpring.gentle.damping)
          .stiffness(MotionSpring.gentle.stiffness)
      : undefined;

  const webCardPolish: ViewStyle = isWeb
    ? {
        ...createWebGlassStyle(16, 165),
        ...createWebTransitionStyle(),
        ...(hovered && onPress && !reduceMotion
          ? {
              transform: [{ translateY: -2 }],
              boxShadow:
                theme.mode === 'dark'
                  ? '0 14px 32px rgba(0, 0, 0, 0.36)'
                  : '0 12px 28px rgba(67, 56, 114, 0.12)',
            }
          : {}),
      }
    : {};

  const cardStyle: StyleProp<ViewStyle> = [
    styles.card,
    createSoftShadow(theme.mode, variant === 'elevated' ? 'lg' : 'md'),
    {
      backgroundColor,
      borderColor,
      borderRadius:
        isCompactPhone && radius === 'xl' ? DesignRadius.lg : borderRadius,
      padding: resolvedPadding,
    },
    webCardPolish,
    style,
  ];

  if (!onPress) {
    if (entering) {
      return (
        <Animated.View
          entering={entering}
          accessibilityLabel={accessibilityLabel}
          style={cardStyle}
        >
          {children}
        </Animated.View>
      );
    }
    return (
      <View accessibilityLabel={accessibilityLabel} style={cardStyle}>
        {children}
      </View>
    );
  }

  const pressableCard = (
    <Animated.View style={animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        onHoverIn={isWeb ? () => setHovered(true) : undefined}
        onHoverOut={isWeb ? () => setHovered(false) : undefined}
        onPressIn={() => {
          if (!reduceMotion)
            scale.set(withSpring(0.985, MotionSpring.gentle));
        }}
        onPressOut={() => {
          if (!reduceMotion) scale.set(withSpring(1, MotionSpring.gentle));
        }}
        style={cardStyle}
      >
        {children}
      </Pressable>
    </Animated.View>
  );

  if (entering) {
    return <Animated.View entering={entering}>{pressableCard}</Animated.View>;
  }

  return pressableCard;
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