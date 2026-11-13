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
  it('accumulates slow scrolling and restarts the threshold when direction changes', () => {
    let expanded = true;
    const onScroll = createTabBarScrollHandler(
      (value) => {
        expanded = value;
      },
      { showAtBottom: false },
    );
    for (let y = 0; y <= 200; y += 5) onScroll(makeScrollEvent(y));
    expect(expanded).toBe(false);
    onScroll(makeScrollEvent(195));
    expect(expanded).toBe(false);
    onScroll(makeScrollEvent(190));
    expect(expanded).toBe(false);
    onScroll(makeScrollEvent(185));
    expect(expanded).toBe(true);
  });
  it('restores search when filtering shrinks a collapsed list so it cannot scroll', () => {
    let expanded = true;
    const onScroll = createTabBarScrollHandler(
      (value) => {
        expanded = value;
      },
      { showAtBottom: false },
    );
    onScroll(makeScrollEvent(150));
    expect(expanded).toBe(false);
    onScroll(makeScrollEvent(0, 100, 600));
    expect(expanded).toBe(true);
  });
  it('does not expand compact controls when their own animation resizes the list', () => {
    let expanded = true;
    const onScroll = createTabBarScrollHandler(
      (value) => {
        expanded = value;
      },
      { showAtBottom: false },
    );
    onScroll(makeScrollEvent(300, 1000, 600));
    expect(expanded).toBe(false);
    onScroll(makeScrollEvent(280, 1000, 650));
    expect(expanded).toBe(false);
    onScroll(makeScrollEvent(250, 1000, 650));
    expect(expanded).toBe(true);
  });
  it('keeps controls collapsed at the bottom until scrolling up', () => {
    let expanded = true;
    const onScroll = createTabBarScrollHandler(
      (value) => {
        expanded = value;
      },
      { showAtBottom: false },
    );
    onScroll(makeScrollEvent(100));
    expect(expanded).toBe(false);
    onScroll(makeScrollEvent(400));
    expect(expanded).toBe(false);
    onScroll(makeScrollEvent(420));
    onScroll(makeScrollEvent(400));
    expect(expanded).toBe(false);
    onScroll(makeScrollEvent(370));
    expect(expanded).toBe(true);
    onScroll(makeScrollEvent(200));
    onScroll(makeScrollEvent(230));
    expect(expanded).toBe(false);
    onScroll(makeScrollEvent(0));
    expect(expanded).toBe(true);
  });
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
