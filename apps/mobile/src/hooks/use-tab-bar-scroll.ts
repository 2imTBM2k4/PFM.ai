import { useMemo } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { usePreferences } from '@/state/preferences';

export interface UseTabBarScrollOptions {
  enabled?: boolean;
  threshold?: number;
  topClearance?: number;
  showAtBottom?: boolean;
}

/**
 * Pure handler logic to detect scroll direction and toggle tab bar visibility.
 */
export function createTabBarScrollHandler(
  setTabBarVisible: (visible: boolean) => void,
  options: UseTabBarScrollOptions = {},
) {
  let lastScrollY = 0;
  let scrollDistance = 0;
  let lastViewportHeight: number | undefined;
  let lastContentHeight: number | undefined;
  const {
    enabled = true,
    threshold = 10,
    topClearance = 24,
    showAtBottom = true,
  } = options;

  return (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!enabled) return;
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    const currentY = Math.max(
      0,
      Math.min(
        contentOffset.y,
        Math.max(0, contentSize.height - layoutMeasurement.height),
      ),
    );
    const diff = currentY - lastScrollY;
    const resized =
      lastViewportHeight !== undefined &&
      (lastViewportHeight !== layoutMeasurement.height ||
        lastContentHeight !== contentSize.height);
    lastViewportHeight = layoutMeasurement.height;
    lastContentHeight = contentSize.height;
    if (resized) {
      if (currentY <= topClearance) setTabBarVisible(true);
      lastScrollY = currentY;
      scrollDistance = 0;
      return;
    }
    if (diff !== 0) {
      scrollDistance =
        Math.sign(diff) === Math.sign(scrollDistance)
          ? scrollDistance + diff
          : diff;
    }

    // Always show near top or at the very bottom of the scroll container
    if (currentY <= topClearance) {
      setTabBarVisible(true);
      scrollDistance = 0;
    } else if (
      showAtBottom &&
      contentSize.height > 0 &&
      currentY + layoutMeasurement.height >= contentSize.height - 24
    ) {
      setTabBarVisible(true);
      scrollDistance = 0;
    } else if (scrollDistance > threshold && currentY > 50) {
      // Scrolling down past top clearance -> hide navbar
      setTabBarVisible(false);
      scrollDistance = 0;
    } else if (scrollDistance < -threshold) {
      // Scrolling up -> show navbar
      setTabBarVisible(true);
      scrollDistance = 0;
    }

    lastScrollY = currentY;
  };
}

/**
 * Automatically hides the floating bottom navigation dock when scrolling down
 * and restores it when scrolling up or near the top of the content.
 */
export function useTabBarScroll(options: UseTabBarScrollOptions = {}) {
  const setTabBarVisible = usePreferences((state) => state.setTabBarVisible);
  const { enabled = true, threshold = 10, topClearance = 24 } = options;

  const handleScroll = useMemo(
    () =>
      createTabBarScrollHandler(setTabBarVisible, {
        enabled,
        threshold,
        topClearance,
      }),
    [enabled, setTabBarVisible, threshold, topClearance],
  );

  return {
    onScroll: handleScroll,
    scrollEventThrottle: 16,
  };
}
