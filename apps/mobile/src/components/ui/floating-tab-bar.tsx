import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { GlassView } from 'expo-glass-effect';
import { memo } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
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
  onAddPress(): void;
  addAccessibilityLabel?: string;
  bottomInset?: number;
}

/**
 * Renders an individual circular icon button inside the floating black pill tab bar.
 */
export function TabIconButton({
  item,
  active,
  onPress,
}: {
  item: TabBarItem;
  active: boolean;
  onPress(): void;
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
          active && styles.tabCircleActive,
          active && {
            backgroundColor: theme.tabBar.activeTab,
          },
        ]}
      >
        <MaterialCommunityIcons
          name={iconName as never}
          size={active ? 19 : 22}
          color={active ? theme.tabBar.activeIcon : theme.tabBar.inactiveIcon}
        />
        {active && (
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
 * Floating black pill tab bar with circular tab icons (purple active background)
 * and a separate circular purple "+" button on the right to add a transaction.
 */
export function FloatingTabBarView({
  items,
  activeKey,
  onSelect,
  onAddPress,
  addAccessibilityLabel = vi.addTransaction,
  bottomInset,
}: FloatingTabBarProps) {
  const theme = useDesignTheme();
  const safeAreaInsets = useSafeAreaInsets();
  const addScale = useSharedValue(1);

  const addAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: addScale.value }],
  }));

  const resolvedBottomInset = bottomInset ?? safeAreaInsets.bottom;
  const bottomOffset = Math.max(resolvedBottomInset, DesignSpacing.sm) + 4;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrapper, { bottom: bottomOffset }]}
    >
      <View style={styles.row}>
        {/* Floating Liquid Glass Pill Container */}
        <GlassView
          glassEffectStyle="regular"
          colorScheme={theme.mode}
          accessibilityRole="tablist"
          style={[
            styles.pillBar,
            createSoftShadow(theme.mode, 'lg'),
            {
              backgroundColor: theme.tabBar.pillBackground,
              borderColor: theme.tabBar.pillBorder,
            },
            Platform.OS === 'web' &&
              ({
                backdropFilter: 'blur(24px) saturate(190%)',
                WebkitBackdropFilter: 'blur(24px) saturate(190%)',
              } as never),
          ]}
        >
          {items.map((item) => (
            <TabIconButton
              key={item.key}
              item={item}
              active={item.key === activeKey}
              onPress={() => onSelect(item.key)}
            />
          ))}
        </GlassView>

        {/* Separate Circular "+" Button on the Right */}
        <Animated.View style={addAnimatedStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={addAccessibilityLabel}
            onPress={onAddPress}
            onPressIn={() => {
              addScale.set(withSpring(0.9, { damping: 15, stiffness: 320 }));
            }}
            onPressOut={() => {
              addScale.set(withSpring(1, { damping: 15, stiffness: 320 }));
            }}
            style={[
              styles.addButton,
              createSoftShadow(theme.mode, 'lg'),
              {
                backgroundColor: theme.tabBar.addButton,
                shadowColor: theme.brand.primary,
                shadowOpacity: 0.4,
              },
            ]}
          >
            <MaterialCommunityIcons
              name="plus"
              size={28}
              color={theme.text.onPrimary}
            />
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

export const FloatingTabBar = memo(FloatingTabBarView);

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: DesignSpacing.screenPadding,
    right: DesignSpacing.screenPadding,
    alignItems: 'center',
    zIndex: 50,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  pillBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
    paddingHorizontal: 4,
    paddingVertical: 6,
    gap: 2,
  },
  tabCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabCircleActive: {
    width: 62,
    gap: 1,
  },
  activeLabel: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '700',
  },
  addButton: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
