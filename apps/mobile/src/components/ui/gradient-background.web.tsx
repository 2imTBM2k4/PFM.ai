import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { DesignColors, type ThemeMode } from '@/constants/design-tokens';

export interface GradientBackgroundProps {
  themeMode?: ThemeMode;
}

/** Keeps grouped content on a quiet, appearance-aware background. */
export const GradientBackground = memo(function GradientBackground({
  themeMode = 'light',
}: GradientBackgroundProps) {
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: DesignColors[themeMode].sky.upperMid },
      ]}
    />
  );
});
