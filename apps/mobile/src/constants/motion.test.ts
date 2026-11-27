import { describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import {
  createWebGlassStyle,
  createWebTransitionStyle,
  getStaggerDelay,
  MotionDuration,
  MotionSpring,
} from './motion';
import { clampProgress } from '@/components/ui/animated-progress-bar';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
  },
  View: 'View',
}));

vi.mock('@/constants/theme', () => ({
  DesignRadius: { pill: 999 },
  useDesignTheme: () => ({ mode: 'light' }),
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useReducedMotion: () => false,
  useSharedValue: (initial: number) => ({ value: initial, set: vi.fn() }),
  useAnimatedStyle: (fn: () => Record<string, unknown>) => fn(),
  withSpring: (value: number) => value,
}));

describe('motion utilities', () => {
  it('computes capped stagger delays cleanly', () => {
    expect(getStaggerDelay(-1)).toBe(0);
    expect(getStaggerDelay(0)).toBe(0);
    expect(getStaggerDelay(1)).toBe(MotionDuration.staggerStep);
    expect(getStaggerDelay(2)).toBe(MotionDuration.staggerStep * 2);
    expect(getStaggerDelay(20)).toBe(MotionDuration.staggerMax);
    expect(MotionSpring.snappy.stiffness).toBeGreaterThan(
      MotionSpring.gentle.stiffness,
    );
  });

  it('returns empty styles on native and CSS styles on web', () => {
    (Platform as { OS: string }).OS = 'ios';
    expect(createWebTransitionStyle()).toEqual({});
    expect(createWebGlassStyle(16, 170)).toEqual({});

    (Platform as { OS: string }).OS = 'web';
    expect(createWebTransitionStyle()).toHaveProperty('transition');
    expect(createWebGlassStyle(16, 170)).toEqual({
      backdropFilter: 'blur(16px) saturate(170%)',
      WebkitBackdropFilter: 'blur(16px) saturate(170%)',
    });
    expect(createWebGlassStyle(16, 170, true)).toEqual({});
    (Platform as { OS: string }).OS = 'ios';
  });

  it('clamps progress values safely into [0, 1]', () => {
    expect(clampProgress(-0.5)).toBe(0);
    expect(clampProgress(0)).toBe(0);
    expect(clampProgress(0.45)).toBe(0.45);
    expect(clampProgress(1.8)).toBe(1);
    expect(clampProgress(Number.NaN)).toBe(0);
    expect(clampProgress(Number.POSITIVE_INFINITY)).toBe(0);
  });
});