import { describe, expect, it, vi } from 'vitest';
import {
  getCameraClearance,
  getFloatingTabBarLayout,
  isDuoClosedPortraitViewport,
} from './responsive-layout';

vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

describe('responsive layout', () => {
  it.each([280, 320, 360, 390, 430, 540, 900])(
    'keeps tabs and the separate action inside a %ipt row',
    (width) => {
      for (const inset of [0, 12]) {
        const layout = getFloatingTabBarLayout(width, inset, inset);
        expect(layout.rowWidth).toBeLessThanOrEqual(width - inset * 2);
        expect(
          layout.pillWidth + layout.controlGap + layout.addButtonSize,
        ).toBe(layout.rowWidth);
        expect(
          layout.activeTabWidth + layout.inactiveTabWidth * 3 + 14,
        ).toBeCloseTo(layout.pillWidth);
        expect(layout.inactiveTabWidth).toBeGreaterThanOrEqual(44);
        expect(layout.addButtonSize).toBe(48);
        expect(layout.controlGap).toBeGreaterThanOrEqual(8);
      }
    },
  );

  it('shrinks the pill before the action button and keeps the Duo action below its rail', () => {
    const narrow = getFloatingTabBarLayout(320);
    const wide = getFloatingTabBarLayout(430);
    expect(narrow.pillWidth).toBeLessThan(wide.pillWidth);
    expect(narrow.addButtonSize).toBe(wide.addButtonSize);
    const duo = getFloatingTabBarLayout(540, 0, 0, 4, true);
    expect(duo.rowWidth).toBe(58);
    expect(duo.rowHeight).toBe(
      duo.pillHeight + duo.controlGap + duo.addButtonSize,
    );
    expect(duo.showActiveLabel).toBe(false);
    expect(duo.tabHeight).toBe(48);
    expect(duo.inactiveTabWidth).toBe(48);
  });
  it('detects a closed Duo in portrait', () => {
    expect(isDuoClosedPortraitViewport(540, 720)).toBe(true);
    expect(isDuoClosedPortraitViewport(720, 1280)).toBe(true);
  });

  it('keeps the bottom navigation when a closed Duo rotates', () => {
    expect(isDuoClosedPortraitViewport(720, 540)).toBe(false);
    expect(isDuoClosedPortraitViewport(844, 390)).toBe(false);
  });

  it('keeps the bottom navigation on iPhones and when the Duo opens wider', () => {
    expect(isDuoClosedPortraitViewport(402, 874)).toBe(false);
    expect(isDuoClosedPortraitViewport(430, 932)).toBe(false);
    expect(isDuoClosedPortraitViewport(1114, 720)).toBe(false);
    expect(isDuoClosedPortraitViewport(780, 844)).toBe(false);
  });

  it('adds camera clearance only when a modern portrait preview has no native inset', () => {
    expect(getCameraClearance(402, 874, 0)).toBe(52);
    expect(getCameraClearance(430, 932, 0)).toBe(52);
    expect(getCameraClearance(540, 720, 0)).toBe(52);
    expect(getCameraClearance(402, 874, 59)).toBe(0);
    expect(getCameraClearance(874, 402, 0)).toBe(0);
    expect(getCameraClearance(768, 1024, 0)).toBe(0);
  });
});
