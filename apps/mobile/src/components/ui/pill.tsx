import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SymbolView } from 'expo-symbols';
import { toSfSymbol } from '@/utils/sf-symbols';
import {
  Pressable,
  Platform,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  useReducedMotion,
  LinearTransition,
} from 'react-native-reanimated';
import {
  DesignRadius,
  DesignSpacing,
  DesignTypography,
  useDesignTheme,
} from '@/constants/theme';

export type PillTone =
  'expense' | 'income' | 'savings' | 'primary' | 'neutral' | 'glass';

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
      borderColor: colors.border,
    },
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
        style={[containerStyle, { minHeight: 44, minWidth: 44 }]}
      >
        {content}
      </View>
    );
  }

  return (
    <Animated.View
      layout={reduceMotion ? undefined : LinearTransition.duration(180)}
      style={[animatedStyle, compact && { padding: 6 }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={accessibilityLabel ?? label}
        hitSlop={10}
        onPress={onPress}
        onPressIn={() => {
          if (!reduceMotion)
            scale.set(withSpring(0.95, { damping: 16, stiffness: 300 }));
        }}
        onPressOut={() => {
          if (!reduceMotion)
            scale.set(withSpring(1, { damping: 16, stiffness: 300 }));
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
