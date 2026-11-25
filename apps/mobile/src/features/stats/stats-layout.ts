export const STATS_WIDE_MIN_WIDTH = 768;
export const STATS_NARROW_MAX_WIDTH = 360;
export const STATS_LARGE_TEXT_SCALE = 1.3;
export const STATS_MIN_TOUCH_TARGET = 44;
export const STATS_MIN_FONT_SIZE = 11;

export interface StatsResponsiveInput {
  width: number;
  fontScale: number;
  reduceTransparency: boolean;
  increaseContrast: boolean;
}

export interface StatsResponsiveProfile {
  isWide: boolean;
  isNarrow: boolean;
  reflowLargeText: boolean;
  minTouchTarget: number;
  minFontSize: number;
  solidGlass: boolean;
  highContrast: boolean;
}

/**
 * Computes deterministic HIG layout and accessibility flags for statistics screens
 * across narrow phones (320-375pt), standard iPhones, iPad split layouts (>= 768pt),
 * and Accessibility Dynamic Type scales.
 */
export function getStatsResponsiveProfile({
  width,
  fontScale,
  reduceTransparency,
  increaseContrast,
}: StatsResponsiveInput): StatsResponsiveProfile {
  const reflowLargeText = fontScale > STATS_LARGE_TEXT_SCALE;
  return {
    isWide: width >= STATS_WIDE_MIN_WIDTH && !reflowLargeText,
    isNarrow: width > 0 && width <= STATS_NARROW_MAX_WIDTH,
    reflowLargeText,
    minTouchTarget: STATS_MIN_TOUCH_TARGET,
    minFontSize: STATS_MIN_FONT_SIZE,
    solidGlass: reduceTransparency || increaseContrast,
    highContrast: increaseContrast,
  };
}

/**
 * Resolves Liquid Glass activation and fallback chrome rules for floating controls.
 */
export function resolveFloatingGlassAppearance({
  liquidGlassAvailable,
  reduceTransparency,
  increaseContrast,
}: {
  liquidGlassAvailable: boolean;
  reduceTransparency: boolean;
  increaseContrast: boolean;
}): {
  useLiquidGlass: boolean;
  solidSurface: boolean;
  fallbackBorderWidth: number;
} {
  const solidSurface = reduceTransparency || increaseContrast;
  const useLiquidGlass = !solidSurface && liquidGlassAvailable;
  return {
    useLiquidGlass,
    solidSurface,
    fallbackBorderWidth: increaseContrast ? 1.5 : 1,
  };
}
