import { useWindowDimensions } from 'react-native';

export const DUO_SIDE_RAIL_WIDTH = 72;

export interface FloatingTabBarLayout {
  rowWidth: number;
  rowHeight: number;
  pillWidth: number;
  pillHeight: number;
  inactiveTabWidth: number;
  activeTabWidth: number;
  tabHeight: number;
  addButtonSize: number;
  controlGap: number;
  showActiveLabel: boolean;
  compact: boolean;
}

/** Reserves a separate action button before allocating the remaining width to tabs. */
export function getFloatingTabBarLayout(
  windowWidth: number,
  leftInset = 0,
  rightInset = 0,
  itemCount = 4,
  vertical = false,
): FloatingTabBarLayout {
  const safeWidth = Math.max(0, windowWidth - leftInset - rightInset);
  const outerPadding = Math.min(
    safeWidth < 360 ? 10 : safeWidth < 430 ? 16 : 20,
    Math.max(0, (safeWidth - (itemCount * 44 + 14 + 48 + 8)) / 2),
  );
  const rowWidth = Math.min(468, Math.max(0, safeWidth - outerPadding * 2));
  const compact = rowWidth < 344;
  const addButtonSize = 48;
  const controlGap = compact ? 8 : 12;
  const pillWidth = Math.max(0, rowWidth - addButtonSize - controlGap);
  const showActiveLabel = !vertical;
  const activeWeight = 1;
  const inactiveTabWidth =
    Math.max(0, pillWidth - 14) / (Math.max(1, itemCount - 1) + activeWeight);
  const tabHeight = vertical ? 48 : 64;
  const pillHeight = vertical
    ? itemCount * tabHeight + Math.max(0, itemCount - 1) * 4 + 18
    : tabHeight + 12;
  return {
    rowWidth: vertical ? 58 : rowWidth,
    rowHeight: vertical ? pillHeight + controlGap + addButtonSize : pillHeight,
    pillWidth: vertical ? 58 : pillWidth,
    pillHeight,
    inactiveTabWidth: vertical ? 48 : inactiveTabWidth,
    activeTabWidth: vertical ? 48 : inactiveTabWidth * activeWeight,
    tabHeight,
    addButtonSize,
    controlGap,
    showActiveLabel,
    compact,
  };
}

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
