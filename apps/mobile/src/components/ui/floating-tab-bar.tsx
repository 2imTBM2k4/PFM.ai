import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { GlassView } from 'expo-glass-effect';
import { memo, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createSoftShadow,
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
} from '@/constants/theme';
import { useResponsiveLayout } from '@/constants/responsive-layout';
import { vi } from '@/messages/vi';

export interface TabBarItem {
  key: string;
  label: string;
  icon: string;
  activeIcon?: string;
}

export interface FloatingTabBarProps {
  items: readonly TabBarItem[];
  activeKey: string;
  onSelect(key: string): void;
  onActionSelect(action: QuickActionKey): void;
  addAccessibilityLabel?: string;
  bottomInset?: number;
  visible?: boolean;
}

export type QuickActionKey = 'manual' | 'camera' | 'chat';

export interface FloatingTabBarLayout {
  rowWidth: number;
  pillWidth: number;
  inactiveTabWidth: number;
  activeTabWidth: number;
  tabHeight: number;
  addButtonSize: number;
  controlGap: number;
  showActiveLabel: boolean;
  compact: boolean;
}

/**
 * Keeps the four tabs and center action control usable from a 320pt iPhone up to an unfolded or
 * landscape viewport. Wider layouts remain centered in an Apple Liquid Glass dock.
 */
export function getFloatingTabBarLayout(
  windowWidth: number,
  leftInset = 0,
  rightInset = 0,
  itemCount = 4,
): FloatingTabBarLayout {
  const safeWidth = Math.max(280, windowWidth - leftInset - rightInset);
  const outerPadding = safeWidth < 360 ? 10 : safeWidth < 430 ? 16 : 20;
  const rowWidth = Math.min(468, safeWidth - outerPadding * 2);
  const compact = rowWidth < 344;
  const addButtonSize = compact ? 44 : 48;
  const controlGap = compact ? 2 : 4;
  const pillWidth = rowWidth;
  const showActiveLabel = rowWidth >= 358;
  const activeWeight = showActiveLabel ? 1.35 : 1;
  const itemSpace = rowWidth - addButtonSize - (compact ? 12 : 20);
  const inactiveTabWidth = Math.max(
    44,
    itemSpace / (Math.max(1, itemCount - 1) + activeWeight),
  );

  return {
    rowWidth,
    pillWidth,
    inactiveTabWidth,
    activeTabWidth: inactiveTabWidth * activeWeight,
    tabHeight: compact ? 48 : 52,
    addButtonSize,
    controlGap,
    showActiveLabel,
    compact,
  };
}

/**
 * Renders an individual circular icon button inside the floating Apple liquid glass tab bar.
 */
export function TabIconButton({
  item,
  active,
  onPress,
  width = 44,
  height = 44,
  showLabel = true,
}: {
  item: TabBarItem;
  active: boolean;
  onPress(): void;
  width?: number;
  height?: number;
  showLabel?: boolean;
}) {
  const theme = useDesignTheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const iconName = active && item.activeIcon ? item.activeIcon : item.icon;

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        accessibilityLabel={item.label}
        hitSlop={4}
        onPress={onPress}
        onPressIn={() => {
          scale.set(withSpring(0.9, { damping: 15, stiffness: 320 }));
        }}
        onPressOut={() => {
          scale.set(withSpring(1, { damping: 15, stiffness: 320 }));
        }}
        style={[
          styles.tabCircle,
          { width, height },
          active && {
            backgroundColor: theme.tabBar.activeTab,
          },
        ]}
      >
        <MaterialCommunityIcons
          name={iconName as never}
          size={active && showLabel ? 19 : 22}
          color={active ? theme.tabBar.activeIcon : theme.tabBar.inactiveIcon}
        />
        {active && showLabel && (
          <Text
            numberOfLines={1}
            style={[styles.activeLabel, { color: theme.tabBar.activeIcon }]}
          >
            {item.label}
          </Text>
        )}
      </Pressable>
    </Animated.View>
  );
}

/**
 * Adaptive Apple Liquid Glass navigation:
 * A single continuous floating glass pill with tabs and the center "+" button.
 */
export function FloatingTabBarView({
  items,
  activeKey,
  onSelect,
  onActionSelect,
  addAccessibilityLabel = vi.addTransaction,
  bottomInset,
  visible = true,
}: FloatingTabBarProps) {
  const theme = useDesignTheme();
  const safeAreaInsets = useSafeAreaInsets();
  const { width: windowWidth, isDuoClosedPortrait } = useResponsiveLayout();
  const addScale = useSharedValue(1);
  const menuProgress = useSharedValue(0);
  const tabVisibility = useSharedValue(1);
  const reduceMotion = useReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  const isTabBarVisible = visible;

  const addAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: addScale.value },
      { rotate: `${menuProgress.value * 45}deg` },
    ],
  }));

  const menuAnimatedStyle = useAnimatedStyle(() => {
    const progress = menuProgress.value;
    return {
      opacity: progress,
      transform: [
        isDuoClosedPortrait
          ? { translateX: interpolate(progress, [0, 1], [12, 0]) }
          : { translateY: interpolate(progress, [0, 1], [10, 0]) },
        {
          scale: interpolate(progress, [0, 1], [0.92, 1], Extrapolation.CLAMP),
        },
      ],
    };
  }, [isDuoClosedPortrait]);

  const effectiveMenuOpen = isTabBarVisible && menuOpen;

  useEffect(() => {
    menuProgress.set(
      reduceMotion
        ? effectiveMenuOpen
          ? 1
          : 0
        : withSpring(effectiveMenuOpen ? 1 : 0, {
            damping: 20,
            stiffness: 260,
          }),
    );
  }, [effectiveMenuOpen, menuProgress, reduceMotion]);

  useEffect(() => {
    if (reduceMotion) {
      tabVisibility.set(isTabBarVisible ? 1 : 0);
    } else {
      tabVisibility.set(
        withSpring(isTabBarVisible ? 1 : 0, {
          damping: 24,
          stiffness: 280,
          mass: 0.8,
        }),
      );
    }
  }, [isTabBarVisible, reduceMotion, tabVisibility]);

  const resolvedBottomInset = bottomInset ?? safeAreaInsets.bottom;
  const layout = getFloatingTabBarLayout(
    windowWidth,
    safeAreaInsets.left,
    safeAreaInsets.right,
    items.length,
  );
  const bottomOffset =
    Math.max(
      resolvedBottomInset,
      layout.compact ? DesignSpacing.xs : DesignSpacing.sm,
    ) + 6;

  const barContainerAnimatedStyle = useAnimatedStyle(() => {
    const hiddenTranslateY = layout.tabHeight + bottomOffset + 24;
    const translateY = interpolate(
      tabVisibility.value,
      [0, 1],
      [isDuoClosedPortrait ? 0 : hiddenTranslateY, 0],
      Extrapolation.CLAMP,
    );
    const translateX = interpolate(
      tabVisibility.value,
      [0, 1],
      [isDuoClosedPortrait ? 120 : 0, 0],
      Extrapolation.CLAMP,
    );
    const opacity = interpolate(
      tabVisibility.value,
      [0, 0.35, 1],
      [0, 0.45, 1],
      Extrapolation.CLAMP,
    );
    return {
      opacity,
      transform: [
        { translateY },
        ...(isDuoClosedPortrait ? [{ translateX }] : []),
      ],
    };
  }, [bottomOffset, isDuoClosedPortrait, layout.tabHeight]);

  // Split tabs around the center "+" button: 2 on the left, 2 on the right
  const leftItems = items.slice(0, 2);
  const rightItems = items.slice(2);

  const renderTab = (item: TabBarItem) => (
    <TabIconButton
      key={item.key}
      item={item}
      active={item.key === activeKey}
      onPress={() => {
        setMenuOpen(false);
        onSelect(item.key);
      }}
      width={
        isDuoClosedPortrait
          ? 48
          : item.key === activeKey
            ? layout.activeTabWidth
            : layout.inactiveTabWidth
      }
      height={isDuoClosedPortrait ? 48 : layout.tabHeight}
      showLabel={!isDuoClosedPortrait && layout.showActiveLabel}
    />
  );

  const renderCenterAddButton = () => (
    <Animated.View key="center-add-button" style={addAnimatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={addAccessibilityLabel}
        accessibilityState={{ expanded: effectiveMenuOpen }}
        onPress={() => setMenuOpen((open) => !open)}
        onPressIn={() => {
          addScale.set(withSpring(0.9, { damping: 15, stiffness: 320 }));
        }}
        onPressOut={() => {
          addScale.set(withSpring(1, { damping: 15, stiffness: 320 }));
        }}
        style={[
          styles.addButton,
          createSoftShadow(theme.mode, 'md'),
          {
            width: layout.addButtonSize,
            height: layout.addButtonSize,
            borderRadius: layout.addButtonSize / 2,
            backgroundColor: theme.tabBar.addButton,
            shadowColor: theme.brand.primary,
            shadowOpacity: 0.35,
          },
        ]}
      >
        <MaterialCommunityIcons
          name="plus"
          size={layout.compact ? 24 : 26}
          color={theme.text.onPrimary}
        />
      </Pressable>
    </Animated.View>
  );

  return (
    <Animated.View
      pointerEvents={isTabBarVisible ? 'box-none' : 'none'}
      style={[
        styles.wrapper,
        isDuoClosedPortrait
          ? {
              bottom: bottomOffset,
              right: Math.max(safeAreaInsets.right, DesignSpacing.sm),
            }
          : {
              bottom: bottomOffset,
              left: safeAreaInsets.left,
              right: safeAreaInsets.right,
            },
        barContainerAnimatedStyle,
      ]}
    >
      <View
        style={[
          styles.row,
          isDuoClosedPortrait
            ? styles.verticalRow
            : { width: layout.rowWidth, justifyContent: 'center' },
        ]}
      >
        {/* Apple Liquid Glass Floating Bar with Center "+" Button */}
        <GlassView
          glassEffectStyle="regular"
          colorScheme={theme.mode}
          accessibilityRole="tablist"
          style={[
            styles.liquidGlassBar,
            createSoftShadow(theme.mode, 'lg'),
            {
              width: isDuoClosedPortrait ? 58 : layout.pillWidth,
              backgroundColor: theme.tabBar.pillBackground,
              borderColor: theme.tabBar.pillBorder,
            },
            isDuoClosedPortrait && styles.verticalLiquidGlassBar,
            Platform.OS === 'web' &&
              ({
                backdropFilter: 'blur(28px) saturate(190%)',
                WebkitBackdropFilter: 'blur(28px) saturate(190%)',
              } as never),
          ]}
        >
          {leftItems.map(renderTab)}
          {renderCenterAddButton()}
          {rightItems.map(renderTab)}
        </GlassView>

        {/* Quick-action Popover Menu centered right above the "+" button */}
        <Animated.View
          pointerEvents={effectiveMenuOpen ? 'auto' : 'none'}
          accessibilityElementsHidden={!effectiveMenuOpen}
          style={[
            styles.actionMenuPosition,
            isDuoClosedPortrait
              ? {
                  right: layout.addButtonSize + DesignSpacing.sm,
                  bottom: 0,
                }
              : {
                  bottom: layout.tabHeight + DesignSpacing.md,
                  alignSelf: 'center',
                },
            menuAnimatedStyle,
          ]}
        >
          <GlassView
            glassEffectStyle="regular"
            colorScheme={theme.mode}
            style={[
              styles.actionMenu,
              createSoftShadow(theme.mode, 'lg'),
              {
                backgroundColor: theme.tabBar.pillBackground,
                borderColor: theme.tabBar.pillBorder,
              },
              Platform.OS === 'web' &&
                ({
                  backdropFilter: 'blur(28px) saturate(190%)',
                  WebkitBackdropFilter: 'blur(28px) saturate(190%)',
                } as never),
            ]}
          >
            {(
              [
                {
                  key: 'manual',
                  label: vi.quickAddManual,
                  icon: 'pencil-outline',
                },
                {
                  key: 'camera',
                  label: vi.quickAddCamera,
                  icon: 'camera-outline',
                },
                {
                  key: 'chat',
                  label: vi.quickAddAI,
                  icon: 'creation',
                },
              ] as const
            ).map((action) => (
              <Pressable
                key={action.key}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                onPress={() => {
                  setMenuOpen(false);
                  onActionSelect(action.key);
                }}
                style={({ pressed }) => [
                  styles.actionMenuItem,
                  {
                    backgroundColor: pressed
                      ? theme.brand.primarySoft
                      : 'transparent',
                  },
                ]}
              >
                <View
                  style={[
                    styles.actionMenuIcon,
                    { backgroundColor: theme.brand.primarySoft },
                  ]}
                >
                  <MaterialCommunityIcons
                    name={action.icon}
                    size={20}
                    color={theme.brand.primaryText}
                  />
                </View>
                <Text
                  numberOfLines={1}
                  style={[
                    styles.actionMenuLabel,
                    { color: theme.text.primary },
                  ]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </GlassView>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

export const FloatingTabBar = memo(FloatingTabBarView);

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    alignItems: 'center',
    zIndex: 50,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  verticalRow: {
    flexDirection: 'column',
    width: 58,
    gap: DesignSpacing.xs,
  },
  liquidGlassBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 5,
    overflow: 'hidden',
  },
  verticalLiquidGlassBar: {
    flexDirection: 'column',
    paddingHorizontal: 4,
    paddingVertical: 8,
    gap: 4,
  },
  actionMenuPosition: {
    position: 'absolute',
    width: 236,
    zIndex: 60,
  },
  actionMenu: {
    padding: 8,
    gap: 3,
    borderWidth: 1,
    borderRadius: DesignRadius.xl,
    overflow: 'hidden',
  },
  actionMenuItem: {
    minHeight: 46,
    paddingHorizontal: 10,
    borderRadius: DesignRadius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  actionMenuIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionMenuLabel: {
    flex: 1,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700',
  },
  tabCircle: {
    width: 44,
    height: 44,
    borderRadius: DesignRadius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 6,
  },
  activeLabel: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
  },
  addButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 2,
  },
});
