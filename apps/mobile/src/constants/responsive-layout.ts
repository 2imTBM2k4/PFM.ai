import { useWindowDimensions } from 'react-native';

export const DUO_SIDE_RAIL_WIDTH = 72;

export interface ResponsiveLayout {
  width: number;
  height: number;
  isDuoClosedPortrait: boolean;
}

/**
 * Make does not expose the selected device profile to the app. Its closed Duo
 * viewport is wider than a phone but narrower than a tablet, so the rail is
 * limited to that portrait-only range. Opening or rotating the device exits
 * this range, as do regular iPhones such as the 18 Pro.
 */
export function isDuoClosedPortraitViewport(
  width: number,
  height: number,
): boolean {
  if (height <= width) return false;

  const portraitRatio = height / width;
  return (
    width > 430 && width < 768 && portraitRatio >= 1.2 && portraitRatio < 2
  );
}

/**
 * Device frames in the web preview visually overlay a camera/Dynamic Island
 * but can still report a zero safe-area inset. Native insets always win; this
 * fallback only covers tall modern iPhones and the closed Duo portrait panel.
 */
export function getCameraClearance(
  width: number,
  height: number,
  topInset: number,
): number {
  if (topInset > 0 || height <= width || width >= 768) return 0;

  const modernPhone = width >= 375 && height >= 780;
  const closedDuo = width > 430;
  return modernPhone || closedDuo ? 52 : 0;
}

export function useResponsiveLayout(): ResponsiveLayout {
  const { width, height } = useWindowDimensions();

  return {
    width,
    height,
    isDuoClosedPortrait: isDuoClosedPortraitViewport(width, height),
  };
}
