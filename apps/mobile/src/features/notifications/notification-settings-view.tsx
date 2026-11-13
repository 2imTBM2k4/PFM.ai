import { useTransientState } from '@/hooks/use-transient-state';
import * as Notifications from 'expo-notifications';
import { IosAuthorizationStatus } from 'expo-notifications';
import { useEffect, useState } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Button, Divider, Icon, Switch, Text } from 'react-native-paper';
import { IconBadge, Screen, styles } from '@/components/screen';
import { GlassCard, TimeField } from '@/components/ui';
import {
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import {
  checkBudgetAlerts,
  requestBudgetNotifications,
  testBudgetNotification,
  useBudgetNotifications,
} from '@/features/budgets/mobile';
import {
  syncDailyExpenseReminder,
  toggleMasterNotifications,
} from '@/features/notifications/notification-settings-service';
import { runRecurring } from '@/features/recurring/mobile';
import { vi } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';

const PRESET_TIMES = ['12:00', '18:00', '20:00', '21:00', '22:00'] as const;

export function NotificationSettingsView({ onClose }: { onClose(): void }) {
  const [subView, setSubView] = useState<'main' | 'budget'>('main');
  const [permissionStatus, setPermissionStatus] = useState<string>('');
  const [testNotice, setTestNotice] = useTransientState('');

  const theme = useDesignTheme();
  const palette = useFinancePalette();

  const notificationsEnabled = usePreferences(
    (state) => state.notificationsEnabled,
  );
  const notifyBudgetAlerts = usePreferences(
    (state) => state.notifyBudgetAlerts,
  );
  const notifyDailyExpenseReminder = usePreferences(
    (state) => state.notifyDailyExpenseReminder,
  );
  const dailyExpenseReminderTime = usePreferences(
    (state) => state.dailyExpenseReminderTime,
  );
  const notifyAIReply = usePreferences((state) => state.notifyAIReply);
  const notifyDebts = usePreferences((state) => state.notifyDebts);
  const notifyRecurring = usePreferences((state) => state.notifyRecurring);

  const setNotifyBudgetAlerts = usePreferences(
    (state) => state.setNotifyBudgetAlerts,
  );
  const setNotifyDailyExpenseReminder = usePreferences(
    (state) => state.setNotifyDailyExpenseReminder,
  );
  const setDailyExpenseReminderTime = usePreferences(
    (state) => state.setDailyExpenseReminderTime,
  );
  const setNotifyAIReply = usePreferences((state) => state.setNotifyAIReply);
  const setNotifyDebts = usePreferences((state) => state.setNotifyDebts);
  const setNotifyRecurring = usePreferences(
    (state) => state.setNotifyRecurring,
  );

  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (subView !== 'main') {
          setSubView('main');
          return true;
        }
        onClose();
        return true;
      },
    );
    return () => subscription.remove();
  }, [subView, onClose]);

  useEffect(() => {
    void Notifications.getPermissionsAsync()
      .then((perm) => {
        const granted =
          perm.granted ||
          perm.ios?.status === IosAuthorizationStatus.PROVISIONAL;
        setPermissionStatus(
          granted
            ? vi.budgetNotificationGranted
            : perm.status === 'undetermined'
              ? ''
              : vi.budgetNotificationDenied,
        );
      })
      .catch(() => setPermissionStatus(''));
  }, []);

  const handleMasterToggle = async (next: boolean) => {
    await toggleMasterNotifications(next);
    if (next) {
      await requestBudgetNotifications();
      const status = useBudgetNotifications.getState().status;
      setPermissionStatus(
        status === 'granted'
          ? vi.budgetNotificationGranted
          : vi.budgetNotificationDenied,
      );
    }
  };

  if (subView === 'budget') {
    const isGranted = permissionStatus === vi.budgetNotificationGranted;
    return (
      <Screen
        title={vi.notificationBudgetMenuTitle}
        onBack={() => setSubView('main')}
      >
        <GlassCard
          variant="elevated"
          radius="xl"
          padding={DesignSpacing.lg}
          style={{ gap: 14 }}
        >
          <View style={styles.row}>
            <View style={[styles.inlineRow, { flex: 1 }]}>
              <IconBadge
                icon="chart-arc"
                bg={theme.brand.primarySoft}
                fg={theme.brand.primary}
                size={40}
                iconSize={20}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  variant="titleMedium"
                  style={{ fontWeight: '700', color: theme.text.primary }}
                >
                  {vi.notificationBudgetSwitchLabel}
                </Text>
                <Text
                  variant="bodySmall"
                  style={{ color: theme.text.secondary, lineHeight: 18 }}
                >
                  {vi.budgetNotificationDescription}
                </Text>
              </View>
            </View>
            <Switch
              accessibilityLabel={vi.notificationBudgetSwitchLabel}
              value={notificationsEnabled && notifyBudgetAlerts}
              disabled={!notificationsEnabled}
              color={theme.brand.primary}
              onValueChange={(val) => {
                void setNotifyBudgetAlerts(val).then(() => checkBudgetAlerts());
              }}
            />
          </View>

          {!!permissionStatus && (
            <Text
              variant="bodySmall"
              style={{
                color: isGranted ? palette.incomeInk : palette.warningInk,
                fontWeight: '600',
              }}
            >
              {permissionStatus}
            </Text>
          )}

          <Divider style={{ backgroundColor: theme.card.border }} />

          <View style={localStyles.actionsRow}>
            <Button
              mode="contained-tonal"
              compact
              icon="send-clock-outline"
              onPress={() =>
                void testBudgetNotification().then((sent) =>
                  setTestNotice(
                    sent
                      ? vi.budgetNotificationTestScheduled
                      : vi.budgetNotificationDenied,
                  ),
                )
              }
            >
              {vi.budgetNotificationTest}
            </Button>
          </View>

          {!!testNotice && (
            <Text
              accessibilityLiveRegion="polite"
              variant="bodySmall"
              style={{ color: theme.brand.primaryText, fontWeight: '700' }}
            >
              {testNotice}
            </Text>
          )}
        </GlassCard>
      </Screen>
    );
  }

  return (
    <Screen title={vi.settingsNotificationsMenuTitle} onBack={onClose}>
      {/* 1. Master Notification Switch */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.lg}
        style={{ gap: 10 }}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="bell-check-outline"
              bg={theme.brand.primarySoft}
              fg={theme.brand.primary}
              size={40}
              iconSize={20}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                variant="titleMedium"
                style={{ fontWeight: '800', color: theme.text.primary }}
              >
                {vi.notificationMasterSwitchLabel}
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.text.secondary, lineHeight: 18 }}
              >
                {vi.notificationMasterSwitchDescription}
              </Text>
            </View>
          </View>
          <Switch
            accessibilityLabel={vi.notificationMasterSwitchLabel}
            value={notificationsEnabled}
            color={theme.brand.primary}
            onValueChange={(val) => void handleMasterToggle(val)}
          />
        </View>
      </GlassCard>

      {/* 2. Budget Notification Submenu (Cài đặt -> Thông báo -> Ngân sách) */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.md}
        accessibilityLabel={vi.notificationBudgetMenuTitle}
        onPress={() => setSubView('budget')}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="chart-box-outline"
              bg={palette.primarySoft}
              fg={palette.primaryInk}
              size={42}
              iconSize={22}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                variant="titleMedium"
                style={{ fontWeight: '700', color: theme.text.primary }}
              >
                {vi.notificationBudgetMenuTitle}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
                {vi.notificationBudgetMenuSubtitle}
              </Text>
            </View>
          </View>
          <Icon source="chevron-right" size={24} color={theme.text.muted} />
        </View>
      </GlassCard>

      {/* 3. Daily Expense Note Reminder with Time Picker */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.lg}
        style={{ gap: 12, opacity: notificationsEnabled ? 1 : 0.6 }}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="clock-edit-outline"
              bg={palette.warningSoft}
              fg={palette.warningInk}
              size={40}
              iconSize={20}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                variant="titleSmall"
                style={{ fontWeight: '700', color: theme.text.primary }}
              >
                {vi.notificationDailyExpenseLabel}
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.text.secondary, lineHeight: 18 }}
              >
                {vi.notificationDailyExpenseDescription}
              </Text>
            </View>
          </View>
          <Switch
            accessibilityLabel={vi.notificationDailyExpenseLabel}
            value={notificationsEnabled && notifyDailyExpenseReminder}
            disabled={!notificationsEnabled}
            color={theme.brand.primary}
            onValueChange={(val) => {
              void setNotifyDailyExpenseReminder(val).then(() =>
                syncDailyExpenseReminder(),
              );
            }}
          />
        </View>

        <Divider style={{ backgroundColor: theme.card.border }} />

        <View style={localStyles.timeRow}>
          <Text
            variant="bodyMedium"
            style={{
              flex: 1,
              flexShrink: 1,
              fontWeight: '600',
              color: theme.text.primary,
            }}
          >
            {vi.notificationDailyExpenseTimeLabel}
          </Text>

          <TimeField
            label={vi.notificationDailyExpenseTimeLabel}
            accessibilityLabel={vi.notificationDailyExpenseTimeLabel}
            value={dailyExpenseReminderTime}
            disabled={!notificationsEnabled}
            onChange={(nextTime) => {
              void setDailyExpenseReminderTime(nextTime).then(() =>
                syncDailyExpenseReminder(),
              );
            }}
          />
        </View>

        {Platform.OS !== 'ios' && (
          <View style={localStyles.presetsRow}>
            {PRESET_TIMES.map((preset) => {
              const active = dailyExpenseReminderTime === preset;
              return (
                <Pressable
                  key={preset}
                  disabled={!notificationsEnabled}
                  onPress={() => {
                    void setDailyExpenseReminderTime(preset).then(() =>
                      syncDailyExpenseReminder(),
                    );
                  }}
                  style={[
                    localStyles.presetChip,
                    {
                      backgroundColor: active
                        ? theme.brand.primary
                        : theme.card.surfaceSubtle,
                      borderColor: active
                        ? theme.brand.primary
                        : theme.card.border,
                    },
                  ]}
                >
                  <Text
                    variant="labelMedium"
                    style={{
                      fontWeight: '700',
                      color: active ? '#FFFFFF' : theme.text.secondary,
                    }}
                  >
                    {preset}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </GlassCard>

      {/* 4. AI Reply Completed Notification */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.lg}
        style={{ opacity: notificationsEnabled ? 1 : 0.6 }}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="robot-happy-outline"
              bg={palette.purpleSoft}
              fg={palette.purpleInk}
              size={40}
              iconSize={20}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                variant="titleSmall"
                style={{ fontWeight: '700', color: theme.text.primary }}
              >
                {vi.notificationAIReplyLabel}
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.text.secondary, lineHeight: 18 }}
              >
                {vi.notificationAIReplyDescription}
              </Text>
            </View>
          </View>
          <Switch
            accessibilityLabel={vi.notificationAIReplyLabel}
            value={notificationsEnabled && notifyAIReply}
            disabled={!notificationsEnabled}
            color={theme.brand.primary}
            onValueChange={(val) => void setNotifyAIReply(val)}
          />
        </View>
      </GlassCard>

      {/* 5. Debts & Loans Notification */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.lg}
        style={{ opacity: notificationsEnabled ? 1 : 0.6 }}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="handshake-outline"
              bg={palette.tealSoft}
              fg={palette.tealInk}
              size={40}
              iconSize={20}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                variant="titleSmall"
                style={{ fontWeight: '700', color: theme.text.primary }}
              >
                {vi.notificationDebtsLabel}
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.text.secondary, lineHeight: 18 }}
              >
                {vi.notificationDebtsDescription}
              </Text>
            </View>
          </View>
          <Switch
            accessibilityLabel={vi.notificationDebtsLabel}
            value={notificationsEnabled && notifyDebts}
            disabled={!notificationsEnabled}
            color={theme.brand.primary}
            onValueChange={(val) => {
              void setNotifyDebts(val).then(() =>
                runRecurring(true).catch(() => undefined),
              );
            }}
          />
        </View>
      </GlassCard>

      {/* 6. Recurring Transactions Due Notification */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.lg}
        style={{ opacity: notificationsEnabled ? 1 : 0.6 }}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="calendar-sync-outline"
              bg={theme.brand.primarySoft}
              fg={theme.brand.primaryText}
              size={40}
              iconSize={20}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                variant="titleSmall"
                style={{ fontWeight: '700', color: theme.text.primary }}
              >
                {vi.notificationRecurringLabel}
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.text.secondary, lineHeight: 18 }}
              >
                {vi.notificationRecurringDescription}
              </Text>
            </View>
          </View>
          <Switch
            accessibilityLabel={vi.notificationRecurringLabel}
            value={notificationsEnabled && notifyRecurring}
            disabled={!notificationsEnabled}
            color={theme.brand.primary}
            onValueChange={(val) => {
              void setNotifyRecurring(val).then(() =>
                runRecurring(true).catch(() => undefined),
              );
            }}
          />
        </View>
      </GlassCard>
    </Screen>
  );
}

const localStyles = StyleSheet.create({
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  presetsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  presetChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
  },
});
