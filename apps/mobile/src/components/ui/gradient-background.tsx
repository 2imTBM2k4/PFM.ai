import {
  BlurMask,
  Canvas,
  Circle,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  vec,
} from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { DesignColors, type ThemeMode } from '@/constants/design-tokens';

/**
 * Builds SVG path strings for the three soft rolling landscape hills at the bottom of the screen.
 */
function buildLandscapeHillPaths(width: number, height: number) {
  const w = Math.max(width, 320);
  const h = Math.max(height, 640);

  const farY = h * 0.72;
  const farHill = `M -40 ${farY} C ${w * 0.25} ${farY - 46}, ${w * 0.62} ${farY + 28}, ${w + 40} ${farY - 20} L ${w + 40} ${h + 40} L -40 ${h + 40} Z`;

  const midY = h * 0.79;
  const midHill = `M -40 ${midY + 10} C ${w * 0.34} ${midY + 42}, ${w * 0.68} ${midY - 48}, ${w + 40} ${midY - 8} L ${w + 40} ${h + 40} L -40 ${h + 40} Z`;

  const nearY = h * 0.86;
  const nearHill = `M -40 ${nearY - 8} C ${w * 0.3} ${nearY - 42}, ${w * 0.72} ${nearY + 30}, ${w + 40} ${nearY - 12} L ${w + 40} ${h + 40} L -40 ${h + 40} Z`;

  return { farHill, midHill, nearHill };
}

export interface GradientBackgroundProps {
  themeMode?: ThemeMode;
}

/**
 * Renders the pastel sunset sky and soft layered hills using @shopify/react-native-skia.
 * Uses static GPU-accelerated Skia primitives to guarantee zero frame-drop during native tab transitions.
 */
export const GradientBackground = memo(function GradientBackground({
  themeMode = 'light',
}: GradientBackgroundProps) {
  const { width, height } = useWindowDimensions();
  const safeWidth = Math.max(width, 360);
  const safeHeight = Math.max(height, 720);
  const palette = DesignColors[themeMode];

  const hills = useMemo(
    () => buildLandscapeHillPaths(safeWidth, safeHeight),
    [safeWidth, safeHeight],
  );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Canvas style={StyleSheet.absoluteFill}>
        {/* Pastel Sunset / Midnight Aurora Sky Gradient */}
        <Rect x={0} y={0} width={safeWidth} height={safeHeight}>
          <LinearGradient
            start={vec(0, 0)}
            end={vec(safeWidth * 0.2, safeHeight)}
            colors={[
              palette.sky.top,
              palette.sky.upperMid,
              palette.sky.lowerMid,
              palette.sky.horizon,
            ]}
            positions={[0, 0.35, 0.7, 1]}
          />
        </Rect>

        {/* Top-Left Soft Lavender Ambient Glow */}
        <Circle
          cx={safeWidth * 0.18}
          cy={safeHeight * 0.16}
          r={safeWidth * 0.48}
        >
          <RadialGradient
            c={vec(safeWidth * 0.18, safeHeight * 0.16)}
            r={safeWidth * 0.48}
            colors={
              themeMode === 'dark'
                ? ['rgba(124, 92, 255, 0.22)', 'rgba(124, 92, 255, 0.0)']
                : ['rgba(255, 255, 255, 0.55)', 'rgba(255, 255, 255, 0.0)']
            }
          />
        </Circle>

        {/* Warm Sunset Horizon Glow */}
        <Circle
          cx={safeWidth * 0.78}
          cy={safeHeight * 0.6}
          r={safeWidth * 0.52}
        >
          <RadialGradient
            c={vec(safeWidth * 0.78, safeHeight * 0.6)}
            r={safeWidth * 0.52}
            colors={
              themeMode === 'dark'
                ? ['rgba(167, 139, 250, 0.18)', 'rgba(167, 139, 250, 0.0)']
                : ['rgba(255, 220, 190, 0.62)', 'rgba(255, 220, 190, 0.0)']
            }
          />
        </Circle>

        {/* Soft Rolling Landscape Hills at Bottom */}
        <Path path={hills.farHill} color={palette.hills.far}>
          <BlurMask blur={10} style="normal" />
        </Path>
        <Path path={hills.midHill} color={palette.hills.mid}>
          <BlurMask blur={6} style="normal" />
        </Path>
        <Path path={hills.nearHill} color={palette.hills.near}>
          <BlurMask blur={4} style="normal" />
        </Path>
      </Canvas>
    </View>
  );
});
