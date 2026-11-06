import { LinearGradient } from 'expo-linear-gradient';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { DesignColors, type ThemeMode } from '@/constants/design-tokens';

export interface GradientBackgroundProps {
  themeMode?: ThemeMode;
}

export const GradientBackground = memo(function GradientBackground({
  themeMode = 'light',
}: GradientBackgroundProps) {
  const palette = DesignColors[themeMode];

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={[
          palette.sky.top,
          palette.sky.upperMid,
          palette.sky.lowerMid,
          palette.sky.horizon,
        ]}
        locations={[0, 0.35, 0.7, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.2, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          styles.glow,
          styles.topGlow,
          {
            backgroundColor:
              themeMode === 'dark'
                ? 'rgba(124, 92, 255, 0.16)'
                : 'rgba(255, 255, 255, 0.36)',
          },
        ]}
      />
      <View
        style={[
          styles.glow,
          styles.horizonGlow,
          {
            backgroundColor:
              themeMode === 'dark'
                ? 'rgba(167, 139, 250, 0.14)'
                : 'rgba(255, 220, 190, 0.46)',
          },
        ]}
      />
      <View
        style={[
          styles.hill,
          styles.farHill,
          { backgroundColor: palette.hills.far },
        ]}
      />
      <View
        style={[
          styles.hill,
          styles.midHill,
          { backgroundColor: palette.hills.mid },
        ]}
      />
      <View
        style={[
          styles.hill,
          styles.nearHill,
          { backgroundColor: palette.hills.near },
        ]}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  glow: {
    position: 'absolute',
    width: 520,
    height: 520,
    borderRadius: 260,
  },
  topGlow: {
    left: -210,
    top: -190,
  },
  horizonGlow: {
    right: -240,
    bottom: 80,
  },
  hill: {
    position: 'absolute',
    left: '-15%',
    width: '130%',
    borderRadius: 999,
    transform: [{ rotate: '-2deg' }],
  },
  farHill: {
    bottom: -190,
    height: 390,
  },
  midHill: {
    bottom: -245,
    height: 390,
    transform: [{ rotate: '3deg' }],
  },
  nearHill: {
    bottom: -310,
    height: 410,
  },
});
