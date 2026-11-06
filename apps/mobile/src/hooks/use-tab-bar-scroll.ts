import { useMemo } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { usePreferences } from '@/state/preferences';

export interface UseTabBarScrollOptions {
  enabled?: boolean;
  threshold?: number;
  topClearance?: number;
}

/**
 * Pure handler logic to detect scroll direction and toggle tab bar visibility.
 */
export function createTabBarScrollHandler(
  setTabBarVisible: (visible: boolean) => void,
  options: UseTabBarScrollOptions = {},
) {
  let lastScrollY = 0;
  const { enabled = true, threshold = 10, topClearance = 24 } = options;

  return (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!enabled) return;
    const { contentOffset, layoutMeasurement, contentSize } =
      event.nativeEvent;
    const currentY = contentOffset.y;
    const diff = currentY - lastScrollY;

    // Always show near top or at the very bottom of the scroll container
    if (currentY <= topClearance) {
      setTabBarVisible(true);
    } else if (
      contentSize.height > 0 &&
      currentY + layoutMeasurement.height >= contentSize.height - 24
    ) {
      setTabBarVisible(true);
    } else if (diff > threshold && currentY > 50) {
      // Scrolling down past top clearance -> hide navbar
      setTabBarVisible(false);
    } else if (diff < -threshold) {
      // Scrolling up -> show navbar
      setTabBarVisible(true);
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
