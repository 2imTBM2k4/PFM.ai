import { describe, expect, it } from 'vitest';
import {
  getStatsResponsiveProfile,
  resolveFloatingGlassAppearance,
  STATS_MIN_FONT_SIZE,
  STATS_MIN_TOUCH_TARGET,
} from './stats-layout';

describe('stats Apple HIG responsive & material profile', () => {
  it('uses single-column iPhone profile with 44pt targets on compact and standard phones', () => {
    const se = getStatsResponsiveProfile({
      width: 320,
      fontScale: 1,
      reduceTransparency: false,
      increaseContrast: false,
    });
    expect(se).toEqual({
      isWide: false,
      isNarrow: true,
      reflowLargeText: false,
      minTouchTarget: STATS_MIN_TOUCH_TARGET,
      minFontSize: STATS_MIN_FONT_SIZE,
      solidGlass: false,
      highContrast: false,
    });

    const iphone = getStatsResponsiveProfile({
      width: 390,
      fontScale: 1,
      reduceTransparency: false,
      increaseContrast: false,
    });
    expect(iphone.isWide).toBe(false);
    expect(iphone.isNarrow).toBe(false);
    expect(iphone.reflowLargeText).toBe(false);
  });

  it('activates two-column iPad layout on wide viewports and collapses back for large Accessibility text', () => {
    const ipad = getStatsResponsiveProfile({
      width: 820,
      fontScale: 1.15,
      reduceTransparency: false,
      increaseContrast: false,
    });
    expect(ipad.isWide).toBe(true);
    expect(ipad.reflowLargeText).toBe(false);

    const ipadAccessible = getStatsResponsiveProfile({
      width: 820,
      fontScale: 1.6,
      reduceTransparency: false,
      increaseContrast: false,
    });
    expect(ipadAccessible.isWide).toBe(false);
    expect(ipadAccessible.reflowLargeText).toBe(true);
  });

  it('disables Liquid Glass and raises fallback border contrast when Reduce Transparency or Increase Contrast is active', () => {
    expect(
      resolveFloatingGlassAppearance({
        liquidGlassAvailable: true,
        reduceTransparency: false,
        increaseContrast: false,
      }),
    ).toEqual({
      useLiquidGlass: true,
      solidSurface: false,
      fallbackBorderWidth: 1,
    });

    expect(
      resolveFloatingGlassAppearance({
        liquidGlassAvailable: true,
        reduceTransparency: true,
        increaseContrast: false,
      }),
    ).toEqual({
      useLiquidGlass: false,
      solidSurface: true,
      fallbackBorderWidth: 1,
    });

    expect(
      resolveFloatingGlassAppearance({
        liquidGlassAvailable: true,
        reduceTransparency: false,
        increaseContrast: true,
      }),
    ).toEqual({
      useLiquidGlass: false,
      solidSurface: true,
      fallbackBorderWidth: 1.5,
    });

    // iOS < 26 fallback when isLiquidGlassAvailable() returns false
    expect(
      resolveFloatingGlassAppearance({
        liquidGlassAvailable: false,
        reduceTransparency: false,
        increaseContrast: false,
      }),
    ).toEqual({
      useLiquidGlass: false,
      solidSurface: false,
      fallbackBorderWidth: 1,
    });
  });

  it('respects exact breakpoint boundaries and accessibility flags in responsive profile', () => {
    expect(
      getStatsResponsiveProfile({
        width: 360,
        fontScale: 1.3,
        reduceTransparency: true,
        increaseContrast: true,
      }),
    ).toEqual({
      isWide: false,
      isNarrow: true,
      reflowLargeText: false,
      minTouchTarget: STATS_MIN_TOUCH_TARGET,
      minFontSize: STATS_MIN_FONT_SIZE,
      solidGlass: true,
      highContrast: true,
    });

    expect(
      getStatsResponsiveProfile({
        width: 768,
        fontScale: 1.31,
        reduceTransparency: false,
        increaseContrast: false,
      }),
    ).toEqual({
      isWide: false,
      isNarrow: false,
      reflowLargeText: true,
      minTouchTarget: STATS_MIN_TOUCH_TARGET,
      minFontSize: STATS_MIN_FONT_SIZE,
      solidGlass: false,
      highContrast: false,
    });

    expect(
      getStatsResponsiveProfile({
        width: 768,
        fontScale: 1.3,
        reduceTransparency: false,
        increaseContrast: false,
      }).isWide,
    ).toBe(true);
  });
});
