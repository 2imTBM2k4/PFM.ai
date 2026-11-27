import { Platform, type ViewStyle } from 'react-native';

/**
 * Shared Apple-inspired spring presets for consistent, responsive motion
 * across iOS, Android, and Web.
 */
export const MotionSpring = {
  snappy: { damping: 20, stiffness: 360, mass: 0.8 },
  gentle: { damping: 22, stiffness: 260, mass: 0.9 },
  tactile: { damping: 16, stiffness: 320, mass: 0.75 },
  progress: { damping: 24, stiffness: 180, mass: 0.9 },
} as const;

/**
 * Standard durations (in ms) for subtle, non-blocking UI transitions.
 */
export const MotionDuration = {
  fast: 150,
  normal: 220,
  entrance: 260,
  staggerStep: 42,
  staggerMax: 210,
} as const;

/**
 * Computes a capped stagger delay so long lists feel crisp without lagging.
 */
export function getStaggerDelay(
  index: number,
  maxDelay: number = MotionDuration.staggerMax,
): number {
  if (index <= 0) return 0;
  return Math.min(index * MotionDuration.staggerStep, maxDelay);
}

/**
 * Returns web-only CSS transition and hover-ready style properties.
 * Returns an empty object on native platforms so iOS/Android styles stay clean.
 */
export function createWebTransitionStyle(
  properties: string = 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 180ms cubic-bezier(0.22, 1, 0.36, 1), background-color 160ms ease, border-color 160ms ease, opacity 160ms ease',
): ViewStyle {
  if (Platform.OS !== 'web') return {};
  return {
    transition: properties,
  } as unknown as ViewStyle;
}

/**
 * Returns web-only frosted backdrop blur style when transparency is allowed.
 */
export function createWebGlassStyle(
  blurPx: number = 18,
  saturatePercent: number = 170,
  disabled: boolean = false,
): ViewStyle {
  if (Platform.OS !== 'web' || disabled) return {};
  const filter = `blur(${blurPx}px) saturate(${saturatePercent}%)`;
  return {
    backdropFilter: filter,
    WebkitBackdropFilter: filter,
  } as unknown as ViewStyle;
}