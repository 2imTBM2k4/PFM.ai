import { describe, expect, it, vi } from 'vitest';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { createTabBarScrollHandler } from './use-tab-bar-scroll';

vi.mock('@/state/preferences', () => ({
  usePreferences: vi.fn(),
}));

function makeScrollEvent(
  offsetY: number,
  contentHeight = 1000,
  layoutHeight = 600,
): NativeSyntheticEvent<NativeScrollEvent> {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y: offsetY },
      contentSize: { width: 390, height: contentHeight },
      layoutMeasurement: { width: 390, height: layoutHeight },
    },
  } as unknown as NativeSyntheticEvent<NativeScrollEvent>;
}

describe('createTabBarScrollHandler', () => {
  it('hides tab bar when scrolling down and restores it when scrolling up or near top', () => {
    let isVisible = true;
    const setTabBarVisible = (val: boolean) => {
      isVisible = val;
    };
    const onScroll = createTabBarScrollHandler(setTabBarVisible, {
      enabled: true,
    });

    // Initial position
    onScroll(makeScrollEvent(0));
    expect(isVisible).toBe(true);

    // Scroll down to 100
    onScroll(makeScrollEvent(100));
    expect(isVisible).toBe(false);

    // Scroll further down
    onScroll(makeScrollEvent(150));
    expect(isVisible).toBe(false);

    // Scroll up from 150 to 120
    onScroll(makeScrollEvent(120));
    expect(isVisible).toBe(true);

    // Scroll back down
    onScroll(makeScrollEvent(200));
    expect(isVisible).toBe(false);

    // Return to top
    onScroll(makeScrollEvent(10));
    expect(isVisible).toBe(true);
  });

  it('does nothing when disabled', () => {
    let isVisible = true;
    const setTabBarVisible = (val: boolean) => {
      isVisible = val;
    };
    const onScroll = createTabBarScrollHandler(setTabBarVisible, {
      enabled: false,
    });

    onScroll(makeScrollEvent(200));
    expect(isVisible).toBe(true);
  });
});
