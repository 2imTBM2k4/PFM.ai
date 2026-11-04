import { MaterialCommunityIcons } from '@expo/vector-icons';
import { monthKey, today } from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Text } from 'react-native-paper';
import { EmptyStateCard, IconBadge, Screen, styles } from '@/components/screen';
import { GlassCard, Pill } from '@/components/ui';
import {
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import { readDashboard } from '@/data/dashboard';
import {
  requestBudgetNotifications,
  testBudgetNotification,
  useBudgetNotifications,
} from '@/features/budgets/mobile';
import { vi } from '@/messages/vi';
import { displayCategoryName } from '@/messages/seed-labels';
import { usePreferences } from '@/state/preferences';

interface NotificationAlertItem {
  id: string;
  title: string;
  description: string;
  tone: 'expense' | 'income' | 'savings' | 'primary';
  icon: string;
  badgeText: string;
}

/**
 * Basic Notifications screen (Stage 6) displaying real-time budget threshold alerts,
 * savings goal updates, and local notification controls.
 */
export function NotificationsView({ onClose }: { onClose(): void }) {
  const [items, setItems] = useState<NotificationAlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const theme = useDesignTheme();
  const palette = useFinancePalette();
  const permissionStatus = useBudgetNotifications((state) => state.status);
  const language = usePreferences((state) => state.language);

  const fetchNotifications = useCallback(async () => {
    const currentMonth = monthKey(
      today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' }),
    );
    const dashboard = await withDatabase((db) =>
      readDashboard(db, currentMonth),
    );
    const nextItems: NotificationAlertItem[] = [];

    // 1. Budget threshold notifications
    for (const budget of dashboard.budgets) {
      const name = budget.category_name ? displayCategoryName(budget.category_name) : vi.budgetOverall;
      const percent =
        budget.amount > 0
          ? Math.round((budget.spent * 100) / budget.amount)
          : 0;
      if (percent >= 100) {
        nextItems.push({
          id: `budget-over-${budget.id}`,
          title: `${name}: ${vi.budgetReached}`,
          description: `${language === 'en' ? 'Spent' : 'Đã chi'} ${formatVnd(budget.spent)} / ${formatVnd(budget.amount)} (${percent}%).`,
          tone: 'expense',
          icon: 'alert-octagon-outline',
          badgeText: `${percent}%`,
        });
      } else if (percent >= budget.warn_percent) {
        nextItems.push({
          id: `budget-warn-${budget.id}`,
          title: `${name}: ${vi.budgetWarning.replace('{percent}', String(budget.warn_percent))}`,
          description: language === 'en' ? `Used ${percent}% of the monthly limit (${formatVnd(budget.spent)} / ${formatVnd(budget.amount)}).` : `Đã sử dụng ${percent}% hạn mức tháng (${formatVnd(budget.spent)} / ${formatVnd(budget.amount)}).`,
          tone: 'primary',
          icon: 'bell-ring-outline',
          badgeText: `${percent}%`,
        });
      }
    }

    // 2. Monthly cash-flow insight notification
    nextItems.push({
      id: 'monthly-net-summary',
      title: `${vi.overviewMonthSummary} (${currentMonth})`,
      description: `${vi.transactionIncome}: ${formatVnd(dashboard.current.income)} · ${vi.transactionExpense}: ${formatVnd(dashboard.current.expense)} · ${vi.overviewNet}: ${formatVnd(dashboard.current.net)}.`,
      tone: dashboard.current.net >= 0 ? 'income' : 'expense',
      icon: dashboard.current.net >= 0 ? 'trending-up' : 'trending-down',
      badgeText:
        dashboard.current.net >= 0
          ? vi.transactionIncome
          : vi.transactionExpense,
    });

    // 3. Active savings goals notification
    if (dashboard.goals.length > 0) {
      const firstGoal = dashboard.goals[0];
      nextItems.push({
        id: `goal-${firstGoal.id}`,
        title: `${vi.goals}: ${firstGoal.name}`,
        description: language === 'en' ? `Target: ${formatVnd(firstGoal.target_amount)}. Keep saving regularly each month.` : `Mục tiêu: ${formatVnd(firstGoal.target_amount)}. Hãy duy trì tích lũy đều đặn mỗi tháng.`,
        tone: 'savings',
        icon: 'bullseye-arrow',
        badgeText: vi.goals,
      });
    }

    return nextItems;
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    fetchNotifications()
      .then((nextItems) => {
        if (!cancelled) {
          setItems(nextItems);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fetchNotifications]);

  return (
    <Screen title={vi.notificationsTitle} onBack={onClose}>
      {/* Permission & Test Notification Card */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.md}
        style={{ gap: 10 }}
      >
        <View style={styles.inlineRow}>
          <IconBadge
            icon="bell-check-outline"
            bg={theme.brand.primarySoft}
            fg={theme.brand.primary}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              variant="titleMedium"
              style={{ fontWeight: '700', color: theme.text.primary }}
            >
              {vi.notificationsTitle}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
              {vi.notificationsSubtitle}
            </Text>
          </View>
        </View>

        <View style={localStyles.actionsRow}>
          <Button
            mode="contained"
            compact
            buttonColor={theme.brand.primaryStrong}
            textColor="#FFFFFF"
            disabled={busy || permissionStatus === 'granted'}
            onPress={async () => {
              setBusy(true);
              try {
                await requestBudgetNotifications();
              } finally {
                setBusy(false);
              }
            }}
          >
            {permissionStatus === 'granted'
              ? vi.budgetNotificationGranted
              : vi.budgetNotificationEnable}
          </Button>
          <Button
            mode="outlined"
            compact
            disabled={busy}
            onPress={async () => {
              setBusy(true);
              setNotice('');
              try {
                const ok = await testBudgetNotification();
                setNotice(
                  ok
                    ? vi.budgetNotificationTestScheduled
                    : vi.budgetNotificationDenied,
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {vi.budgetNotificationTest}
          </Button>
        </View>

        {!!notice && (
          <Text
            variant="bodySmall"
            style={{ color: palette.incomeInk, fontWeight: '600' }}
          >
            {notice}
          </Text>
        )}
      </GlassCard>

      {loading ? (
        <View style={{ paddingVertical: 28, alignItems: 'center' }}>
          <ActivityIndicator size="large" accessibilityLabel={vi.loading} />
        </View>
      ) : items.length === 0 ? (
        <EmptyStateCard
          icon="bell-sleep-outline"
          message={vi.notificationsEmpty}
        />
      ) : (
        <View style={{ gap: 12 }}>
          {items.map((item) => (
            <GlassCard
              key={item.id}
              variant="elevated"
              radius="lg"
              padding={DesignSpacing.md}
              style={{ gap: 8 }}
            >
              <View style={styles.row}>
                <View style={[styles.inlineRow, { flex: 1 }]}>
                  <MaterialCommunityIcons
                    name={item.icon as never}
                    size={22}
                    color={theme.brand.primary}
                  />
                  <Text
                    variant="titleSmall"
                    style={{
                      fontWeight: '700',
                      color: theme.text.primary,
                      flex: 1,
                    }}
                  >
                    {item.title}
                  </Text>
                </View>
                <Pill label={item.badgeText} tone={item.tone} size="sm" />
              </View>
              <Text
                variant="bodyMedium"
                style={{ color: theme.text.secondary, lineHeight: 20 }}
              >
                {item.description}
              </Text>
            </GlassCard>
          ))}
        </View>
      )}
    </Screen>
  );
}

const localStyles = StyleSheet.create({
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
});
