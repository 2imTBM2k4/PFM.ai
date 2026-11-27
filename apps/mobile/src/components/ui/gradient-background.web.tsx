import { memo } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { DesignColors, type ThemeMode } from '@/constants/design-tokens';

export interface GradientBackgroundProps {
  themeMode?: ThemeMode;
}

/**
 * Renders a quiet, appearance-aware web background with subtle ambient radial
 * washes reminiscent of modern macOS/iOS surfaces.
 */
export const GradientBackground = memo(function GradientBackground({
  themeMode = 'light',
}: GradientBackgroundProps) {
  const baseColor = DesignColors[themeMode].sky.upperMid;
  const ambientImage =
    themeMode === 'dark'
      ? 'radial-gradient(60% 45% at 15% 0%, rgba(124, 92, 255, 0.16) 0%, rgba(124, 92, 255, 0) 70%), radial-gradient(50% 40% at 88% 12%, rgba(92, 225, 255, 0.08) 0%, rgba(92, 225, 255, 0) 72%)'
      : 'radial-gradient(62% 48% at 14% 0%, rgba(124, 92, 255, 0.09) 0%, rgba(124, 92, 255, 0) 68%), radial-gradient(52% 42% at 88% 10%, rgba(92, 225, 255, 0.08) 0%, rgba(92, 225, 255, 0) 70%)';

  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: baseColor },
        { backgroundImage: ambientImage } as unknown as ViewStyle,
      ]}
    />
  );
});