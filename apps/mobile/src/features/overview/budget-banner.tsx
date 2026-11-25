import MaterialCommunityIcons from '@/components/platform-icon';
import type { BudgetBannerItem } from '@pfm/domain';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import {
  DesignRadius,
  DesignSpacing,
  useFinancePalette,
} from '@/constants/theme';
import { displayCategoryName } from '@/messages/seed-labels';
import { vi } from '@/messages/vi';
import { formatMoney as formatVnd } from '@/utils/display-money';

/**
 * Formats the single-line summary text shown inside the Overview budget alert banner.
 */
export function formatBudgetBannerMessage(
  items: readonly BudgetBannerItem[],
): string {
  if (items.length === 0) return '';
  if (items.length > 1) {
    return vi.budgetBannerMultiple.replace('{count}', String(items.length));
  }
  const item = items[0];
  const name = item.categoryName
    ? displayCategoryName(item.categoryName)
    : vi.budgetOverall;
  if (item.level === 'over') {
    if (item.overBy > 0) {
      return vi.budgetBannerSingleOver
        .replace('{name}', name)
        .replace('{amount}', formatVnd(item.overBy));
    }
    return vi.budgetBannerSingleReached.replace('{name}', name);
  }
  return vi.budgetBannerSingleWarn
    .replace('{name}', name)
    .replace('{percent}', String(item.percent));
}

export interface BudgetBannerProps {
  items: readonly BudgetBannerItem[];
  onPress(): void;
  onDismiss(): void;
}

/**
 * Compact one-line banner displayed on the Overview screen when one or more
 * active budgets in the current month reach their warning threshold or limit.
 */
export function BudgetBanner({ items, onPress, onDismiss }: BudgetBannerProps) {
  const palette = useFinancePalette();
  if (items.length === 0) return null;

  const hasOver = items.some((item) => item.level === 'over');
  const bg = hasOver ? palette.dangerSoft : palette.warningSoft;
  const border = hasOver ? palette.danger : palette.warning;
  const fg = hasOver ? palette.dangerInk : palette.warningInk;
  const iconName = hasOver ? 'alert-octagon-outline' : 'alert-outline';
  const message = formatBudgetBannerMessage(items);

  return (
    <View
      style={[
        localStyles.container,
        {
          backgroundColor: bg,
          borderColor: border,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={message}
        onPress={onPress}
        style={({ pressed }) => [
          localStyles.mainTouchArea,
          { opacity: pressed ? 0.78 : 1 },
        ]}
      >
        <MaterialCommunityIcons name={iconName} size={20} color={fg} />
        <Text
          variant="bodyMedium"

          style={[localStyles.messageText, { color: fg }]}
        >
          {message}
        </Text>
        <MaterialCommunityIcons name="chevron-right" size={18} color={fg} />
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={vi.budgetBannerDismiss}
        hitSlop={4}
        onPress={onDismiss}
        style={({ pressed }) => [
          localStyles.dismissButton,
          { opacity: pressed ? 0.65 : 1 },
        ]}
      >
        <MaterialCommunityIcons name="close" size={18} color={fg} />
      </Pressable>
    </View>
  );
}

const localStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: DesignRadius.lg,
    minHeight: 48,
    paddingLeft: DesignSpacing.md,
    paddingRight: 4,
  },
  mainTouchArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: DesignSpacing.xs,
    minHeight: 44,
    paddingVertical: 8,
  },
  messageText: {
    flex: 1,
    fontWeight: '700',
  },
  dismissButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
});
