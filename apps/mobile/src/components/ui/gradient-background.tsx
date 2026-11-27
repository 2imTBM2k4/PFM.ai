import { LinearGradient } from 'expo-linear-gradient';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { DesignColors, type ThemeMode } from '@/constants/design-tokens';
import { useAccessibilityPreferences } from '@/hooks/use-accessibility-preferences';

export interface GradientBackgroundProps {
  themeMode?: ThemeMode;
}

/**
 * Renders a quiet, appearance-aware background with a subtle Apple-inspired
 * ambient light wash that respects Reduce Transparency and Increase Contrast.
 */
export const GradientBackground = memo(function GradientBackground({
  themeMode = 'light',
}: GradientBackgroundProps) {
  const { reduceTransparency, increaseContrast } =
    useAccessibilityPreferences();
  const baseColor = DesignColors[themeMode].sky.upperMid;

  if (reduceTransparency || increaseContrast) {
    return (
      <View
        pointerEvents="none"
        accessible={false}
        style={[StyleSheet.absoluteFill, { backgroundColor: baseColor }]}
      />
    );
  }

  const ambientColors: readonly [string, string, string] =
    themeMode === 'dark'
      ? [
          'rgba(124, 92, 255, 0.14)',
          'rgba(66, 153, 225, 0.05)',
          'rgba(0, 0, 0, 0)',
        ]
      : [
          'rgba(124, 92, 255, 0.08)',
          'rgba(92, 225, 255, 0.04)',
          'rgba(242, 242, 247, 0)',
        ];

  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={[StyleSheet.absoluteFill, { backgroundColor: baseColor }]}
    >
      <LinearGradient
        colors={ambientColors}
        locations={[0, 0.42, 1]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 0.72 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
});