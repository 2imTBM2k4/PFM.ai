import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { createWebTransitionStyle, MotionSpring } from '@/constants/motion';
import {
  DesignRadius,
  DesignSpacing,
  DesignTypography,
  useDesignTheme,
} from '@/constants/theme';
import { toSfSymbol } from '@/utils/sf-symbols';

export type PillTone =
  | 'expense'
  | 'income'
  | 'savings'
  | 'primary'
  | 'neutral'
  | 'glass';

export interface PillProps {
  label: string;
  tone?: PillTone;
  size?: 'sm' | 'md';
  icon?: string;
  selected?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  compact?: boolean;
}

/**
 * Reusable capsule pill component used for Expense/Income transaction badges,
 * percentage deltas, and AI Intro prompt suggestion chips.
 */
export function Pill({
  label,
  tone = 'neutral',
  size = 'sm',
  icon,
  selected = false,
  onPress,
  style,
  accessibilityLabel,
  compact = false,
}: PillProps) {
  const theme = useDesignTheme();
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const [hovered, setHovered] = useState(false);
  const isWeb = Platform.OS === 'web';

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const colors = (() => {
    if (selected) {
      return {
        bg: theme.brand.primaryStrong,
        fg: theme.text.onPrimary,
        border: theme.brand.primaryStrong,
      };
    }
    switch (tone) {
      case 'expense':
        return {
          bg: theme.finance.expenseSoft,
          fg: theme.finance.expenseText,
          border: 'transparent',
        };
      case 'income':
        return {
          bg: theme.finance.incomeSoft,
          fg: theme.finance.incomeText,
          border: 'transparent',
        };
      case 'savings':
        return {
          bg: theme.finance.savingsSoft,
          fg: theme.finance.savingsText,
          border: 'transparent',
        };
      case 'primary':
        return {
          bg: theme.brand.primarySoft,
          fg: theme.brand.primaryText,
          border: theme.brand.primaryBorder,
        };
      case 'glass':
        return {
          bg: theme.card.surfaceElevated,
          fg: theme.text.primary,
          border: theme.card.border,
        };
      default:
        return {
          bg: theme.card.surfaceSubtle,
          fg: theme.text.secondary,
          border: theme.card.border,
        };
    }
  })();

  const isSmall = size === 'sm';
  const containerStyle: StyleProp<ViewStyle> = [
    styles.pill,
    isSmall ? styles.small : styles.medium,
    {
      backgroundColor: colors.bg,
      borderColor:
        hovered && onPress && !selected
          ? theme.brand.primaryBorder
          : colors.border,
    },
    isWeb && onPress ? createWebTransitionStyle() : undefined,
    isWeb && hovered && onPress && !reduceMotion
      ? ({ transform: [{ translateY: -1 }] } as ViewStyle)
      : undefined,
    style,
    compact && {
      width: 44,
      height: 44,
      minWidth: 44,
      minHeight: 44,
      paddingHorizontal: 0,
      paddingVertical: 0,
      justifyContent: 'center',
    },
  ];

  const content = (
    <>
      {icon ? (
        compact && Platform.OS === 'ios' ? (
          <SymbolView
            name={toSfSymbol(icon)!}
            size={18}
            tintColor={colors.fg}
            style={{ width: 18, height: 18 }}
          />
        ) : (
          <MaterialCommunityIcons
            name={icon as never}
            size={compact ? 18 : isSmall ? 13 : 16}
            color={colors.fg}
          />
        )
      ) : null}
      {!compact && (
        <Text
          style={[
            styles.label,
            {
              color: colors.fg,
              fontSize: isSmall
                ? DesignTypography.size.caption
                : DesignTypography.size.small,
            },
          ]}
        >
          {label}
        </Text>
      )}
    </>
  );

  if (!onPress) {
    return (
      <View
        accessibilityLabel={accessibilityLabel ?? label}
        style={containerStyle}
      >
        {content}
      </View>
    );
  }

  return (
    <Animated.View
      layout={reduceMotion ? undefined : LinearTransition.duration(180)}
      style={animatedStyle}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={accessibilityLabel ?? label}
        hitSlop={10}
        onPress={onPress}
        onHoverIn={isWeb ? () => setHovered(true) : undefined}
        onHoverOut={isWeb ? () => setHovered(false) : undefined}
        onPressIn={() => {
          if (!reduceMotion) scale.set(withSpring(0.95, MotionSpring.snappy));
        }}
        onPressOut={() => {
          if (!reduceMotion) scale.set(withSpring(1, MotionSpring.snappy));
        }}
        style={[
          containerStyle,
          { minWidth: 44, minHeight: 44, justifyContent: 'center' },
        ]}
      >
        {content}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
    gap: 5,
  },
  small: {
    paddingHorizontal: DesignSpacing.xs + 2,
    paddingVertical: 4,
  },
  medium: {
    paddingHorizontal: DesignSpacing.md,
    paddingVertical: 9,
  },
  label: {
    fontWeight: DesignTypography.weight.semibold,
    letterSpacing: 0.1,
  },
});