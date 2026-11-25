import type { PropsWithChildren } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityRole,
  type AccessibilityState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { GlassContainer, GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import {
  createSoftShadow,
  useDesignTheme,
} from '@/constants/theme';
import { useAccessibilityPreferences } from '@/hooks/use-accessibility-preferences';
import {
  resolveFloatingGlassAppearance,
  STATS_MIN_TOUCH_TARGET,
} from './stats-layout';

interface FloatingGlassControlProps extends PropsWithChildren {
  onPress(): void;
  accessibilityLabel: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  shape?: 'circle' | 'pill';
  minWidth?: number;
  minHeight?: number;
  paddingHorizontal?: number;
  tintColor?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Floating control chrome using iOS 26+ Liquid Glass (`GlassView`) when available,
 * degrading automatically to opaque elevated materials when Reduce Transparency,
 * Increase Contrast, iOS < 26, Android, or Web is active.
 */
export function FloatingGlassControl({
  children,
  onPress,
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  shape = 'circle',
  minWidth = STATS_MIN_TOUCH_TARGET,
  minHeight = STATS_MIN_TOUCH_TARGET,
  paddingHorizontal,
  tintColor,
  style,
  testID,
}: FloatingGlassControlProps) {
  const theme = useDesignTheme();
  const { reduceTransparency, increaseContrast } =
    useAccessibilityPreferences();
  const appearance = resolveFloatingGlassAppearance({
    liquidGlassAvailable: isLiquidGlassAvailable(),
    reduceTransparency,
    increaseContrast,
  });

  const radius = shape === 'circle' ? Math.max(minWidth, minHeight) / 2 : 999;
  const resolvedPaddingX =
    paddingHorizontal ?? (shape === 'circle' ? 0 : 14);

  const sizeStyle: ViewStyle = {
    minWidth,
    minHeight,
    borderRadius: radius,
    paddingHorizontal: resolvedPaddingX,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  };

  if (appearance.useLiquidGlass) {
    return (
      <GlassView
        glassEffectStyle="regular"
        isInteractive
        colorScheme={theme.mode}
        tintColor={tintColor}
        style={[sizeStyle, styles.glassHost, style]}
      >
        <Pressable
          testID={testID}
          accessibilityRole={accessibilityRole}
          accessibilityLabel={accessibilityLabel}
          accessibilityState={accessibilityState}
          onPress={onPress}
          style={[
            styles.pressableFill,
            {
              minWidth,
              minHeight,
              borderRadius: radius,
              paddingHorizontal: resolvedPaddingX,
            },
          ]}
        >
          {children}
        </Pressable>
      </GlassView>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      onPress={onPress}
      style={({ pressed }) => [
        sizeStyle,
        createSoftShadow(theme.mode, 'sm'),
        {
          backgroundColor: appearance.solidSurface
            ? theme.card.surfaceElevated
            : theme.tabBar.pillBackground,
          borderColor: appearance.solidSurface
            ? theme.text.muted
            : theme.card.border,
          borderWidth: appearance.fallbackBorderWidth,
          opacity: pressed ? 0.8 : 1,
        },
        Platform.OS === 'web' &&
          !appearance.solidSurface &&
          ({
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          } as never),
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

/**
 * Groups nearby floating Liquid Glass controls inside a single `GlassContainer`
 * on iOS 26+ so adjacent pills merge harmoniously per Apple HIG.
 */
export function FloatingGlassGroup({
  children,
  spacing = 8,
  style,
}: PropsWithChildren<{ spacing?: number; style?: StyleProp<ViewStyle> }>) {
  const { reduceTransparency, increaseContrast } =
    useAccessibilityPreferences();
  const { useLiquidGlass } = resolveFloatingGlassAppearance({
    liquidGlassAvailable: isLiquidGlassAvailable(),
    reduceTransparency,
    increaseContrast,
  });

  if (useLiquidGlass) {
    return (
      <GlassContainer spacing={spacing} style={[styles.groupRow, style]}>
        {children}
      </GlassContainer>
    );
  }

  return <View style={[styles.groupRow, { gap: spacing }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  glassHost: {
    overflow: 'hidden',
  },
  pressableFill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
