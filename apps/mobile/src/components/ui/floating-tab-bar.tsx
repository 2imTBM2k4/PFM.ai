import { useAccessibilityPreferences } from '@/hooks/use-accessibility-preferences';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { memo, useEffect } from 'react';
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
import {
  getFloatingTabBarLayout,
  useResponsiveLayout,
} from '@/constants/responsive-layout';
import { QuickActionMenu } from './quick-action-menu';
import { vi } from '@/messages/vi';

export {
  getFloatingTabBarLayout,
  type FloatingTabBarLayout,
} from '@/constants/responsive-layout';

export interface TabBarItem {
  key: string;
  label: string;
  icon: string;
  activeIcon?: string;
  iosIcon: SFSymbol;
  iosActiveIcon: SFSymbol;
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
  const reduceMotion = useReducedMotion();

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
          if (!reduceMotion)
            scale.set(withSpring(0.9, { damping: 15, stiffness: 320 }));
        }}
        onPressOut={() => {
          if (!reduceMotion)
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
        {Platform.OS === 'ios' ? (
          <SymbolView
            name={active ? item.iosActiveIcon : item.iosIcon}
            size={active && showLabel ? 19 : 22}
            tintColor={
              active ? theme.tabBar.activeIcon : theme.tabBar.inactiveIcon
            }
            style={{
              width: active && showLabel ? 19 : 22,
              height: active && showLabel ? 19 : 22,
            }}
          />
        ) : (
          <MaterialCommunityIcons
            name={iconName as never}
            size={active && showLabel ? 19 : 22}
            color={active ? theme.tabBar.activeIcon : theme.tabBar.inactiveIcon}
          />
        )}
        {showLabel && (
          <Text
            maxFontSizeMultiplier={1.2}
            style={[
              styles.activeLabel,
              {
                color: active
                  ? theme.tabBar.activeIcon
                  : theme.tabBar.inactiveIcon,
              },
            ]}
          >
            {item.label}
          </Text>
        )}
      </Pressable>
    </Animated.View>
  );
}

/** Renders independently positioned navigation and a persistent action menu. */
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
  const insets = useSafeAreaInsets();
  const { width, isDuoClosedPortrait } = useResponsiveLayout();
  const layout = getFloatingTabBarLayout(
    width,
    insets.left,
    insets.right,
    items.length,
    isDuoClosedPortrait,
  );
  const { reduceTransparency, increaseContrast } =
    useAccessibilityPreferences();
  const solid = reduceTransparency || increaseContrast;
  const Surface = solid ? View : GlassView;
  const liquidGlassAvailable = !solid && isLiquidGlassAvailable();
  const tabVisibility = useSharedValue(visible ? 1 : 0);
  const reduceMotion = useReducedMotion();
  const bottomOffset =
    Math.max(
      bottomInset ?? insets.bottom,
      layout.compact ? DesignSpacing.xs : DesignSpacing.sm,
    ) + 6;

  useEffect(() => {
    tabVisibility.set(
      reduceMotion
        ? visible
          ? 1
          : 0
        : withSpring(visible ? 1 : 0, {
            damping: 24,
            stiffness: 280,
            mass: 0.8,
          }),
    );
  }, [visible, reduceMotion, tabVisibility]);

  const barContainerAnimatedStyle = useAnimatedStyle(
    () => ({
      transform: [
        {
          translateY: interpolate(
            tabVisibility.value,
            [0, 1],
            [layout.rowHeight + bottomOffset + 24, 0],
            Extrapolation.CLAMP,
          ),
        },
      ],
    }),
    [layout.rowHeight, bottomOffset],
  );

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.wrapper,
        isDuoClosedPortrait
          ? {
              bottom: bottomOffset,
              right: Math.max(insets.right, DesignSpacing.sm),
            }
          : { bottom: bottomOffset, left: insets.left, right: insets.right },
      ]}
    >
      <View
        pointerEvents="box-none"
        style={[
          styles.row,
          {
            width: layout.rowWidth,
            flexDirection: isDuoClosedPortrait ? 'column' : 'row',
            gap: layout.controlGap,
          },
        ]}
      >
        <View
          pointerEvents="box-none"
          style={[
            { width: layout.pillWidth, height: layout.pillHeight },
            // Clip the sliding Duo rail before it crosses the persistent action button.
            isDuoClosedPortrait && { overflow: 'hidden' },
          ]}
        >
          <Animated.View
            testID="floating-tab-pill"
            pointerEvents={visible ? 'auto' : 'none'}
            accessibilityElementsHidden={!visible}
            importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
            style={barContainerAnimatedStyle}
          >
            <Surface
              glassEffectStyle="regular"
              isInteractive
              colorScheme={theme.mode}
              accessibilityRole="tablist"
              style={[
                styles.liquidGlassBar,
                { width: layout.pillWidth },
                !liquidGlassAvailable && createSoftShadow(theme.mode, 'lg'),
                !liquidGlassAvailable && {
                  backgroundColor: solid
                    ? theme.card.surfaceElevated
                    : theme.tabBar.pillBackground,
                  borderColor: theme.tabBar.pillBorder,
                  borderWidth: 1,
                },
                isDuoClosedPortrait && styles.verticalLiquidGlassBar,
                Platform.OS === 'web' &&
                  ({
                    backdropFilter: 'blur(28px) saturate(190%)',
                    WebkitBackdropFilter: 'blur(28px) saturate(190%)',
                  } as never),
              ]}
            >
              {items.map((item) => (
                <TabIconButton
                  key={item.key}
                  item={item}
                  active={item.key === activeKey}
                  onPress={() => onSelect(item.key)}
                  width={
                    item.key === activeKey
                      ? layout.activeTabWidth
                      : layout.inactiveTabWidth
                  }
                  height={layout.tabHeight}
                  showLabel={layout.showActiveLabel}
                />
              ))}
            </Surface>
          </Animated.View>
        </View>
        <View
          testID="floating-tab-action"
          style={{ width: layout.addButtonSize, height: layout.addButtonSize }}
        >
          <Surface
            pointerEvents="none"
            glassEffectStyle="regular"
            colorScheme={theme.mode}
            style={[
              StyleSheet.absoluteFill,
              { borderRadius: layout.addButtonSize / 2 },
              !liquidGlassAvailable && {
                backgroundColor: solid
                  ? theme.card.surfaceElevated
                  : theme.tabBar.pillBackground,
                borderColor: theme.tabBar.pillBorder,
                borderWidth: 1,
              },
              Platform.OS === 'web' &&
                ({
                  backdropFilter: 'blur(28px) saturate(190%)',
                  WebkitBackdropFilter: 'blur(28px) saturate(190%)',
                } as never),
            ]}
          />
          <QuickActionMenu
            key={activeKey}
            size={layout.addButtonSize}
            label={addAccessibilityLabel}
            onActionSelect={onActionSelect}
          />
        </View>
      </View>
    </View>
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
  liquidGlassBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    borderRadius: DesignRadius.pill,
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
  tabCircle: {
    width: 44,
    height: 44,
    borderRadius: DesignRadius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    flexDirection: 'column',
    gap: 2,
    paddingHorizontal: 2,
  },
  activeLabel: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    flexShrink: 1,
    textAlign: 'center',
  },
});
