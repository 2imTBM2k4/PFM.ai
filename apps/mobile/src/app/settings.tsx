import { useTransientState } from '@/hooks/use-transient-state';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Divider, Icon, Switch, Text } from 'react-native-paper';
import { IconBadge, Screen, styles } from '@/components/screen';
import { GlassCard } from '@/components/ui';
import {
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { AppearanceSettingsView } from '@/features/settings/appearance-settings-view';
import { BackupSettingsView } from '@/features/backup/backup-settings-view';
import { useBackupRuntimeStatus } from '@/features/backup/mobile';
import { hasBackupIndicatorIssue } from '@/features/backup/scheduler';
import { CategoryManager } from '@/features/categories/category-manager';
import { SecuritySettingsView } from '@/features/lock/security-settings-view';
import { NotificationSettingsView } from '@/features/notifications/notification-settings-view';
import { vi } from '@/messages/vi';
import { isDevSeedToolsEnabled, usePreferences } from '@/state/preferences';

/**
 * Settings screen: display mode (Pastel Sunset / Midnight Aurora), currency,
 * preview tools (seed data and CSV), category management, notifications and PIN security.
 */
export default function Settings() {
  const [managingCategories, setManagingCategories] = useState(false);
  const [viewingNotifications, setViewingNotifications] = useState(false);
  const [viewingSecurity, setViewingSecurity] = useState(false);
  const [viewingAppearance, setViewingAppearance] = useState(false);
  const [viewingBackup, setViewingBackup] = useState(false);
  const [seedNotice, setSeedNotice] = useTransientState('');
  const [seedError, setSeedError] = useState('');
  const [seedBusy, setSeedBusy] = useState(false);

  const palette = useFinancePalette();
  const theme = useDesignTheme();

  const seedEnabled = usePreferences((state) => state.seedEnabled);
  const setSeedEnabled = usePreferences((state) => state.setSeedEnabled);
  const backupStatus = useBackupRuntimeStatus();
  const showBackupIssueBadge = hasBackupIndicatorIssue(backupStatus.state);

  if (viewingAppearance)
    return (
      <AppearanceSettingsView onClose={() => setViewingAppearance(false)} />
    );

  if (managingCategories) {
    return <CategoryManager onClose={() => setManagingCategories(false)} />;
  }
  if (viewingNotifications) {
    return (
      <NotificationSettingsView
        onClose={() => setViewingNotifications(false)}
      />
    );
  }
  if (viewingSecurity) {
    return <SecuritySettingsView onClose={() => setViewingSecurity(false)} />;
  }
  if (viewingBackup) {
    return <BackupSettingsView onClose={() => setViewingBackup(false)} />;
  }

  const handleToggleSeed = async (nextValue: boolean) => {
    if (seedBusy) return;
    setSeedBusy(true);
    setSeedNotice('');
    setSeedError('');
    try {
      await setSeedEnabled(nextValue);
      setSeedNotice(
        nextValue ? vi.settingsSeedActiveNotice : vi.settingsSeedRemovedNotice,
      );
    } catch {
      setSeedError(vi.settingsSeedFailedNotice);
    } finally {
      setSeedBusy(false);
    }
  };

  return (
    <Screen title={vi.settings}>
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.md}
        accessibilityLabel={vi.settingsPreferencesTitle}
        onPress={() => setViewingAppearance(true)}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="palette-swatch-outline"
              bg={theme.brand.primarySoft}
              fg={theme.brand.primaryText}
              size={42}
              iconSize={22}
            />
            <Text
              variant="titleMedium"
              style={{ flex: 1, fontWeight: '700', color: theme.text.primary }}
            >
              {vi.settingsPreferencesTitle}
            </Text>
          </View>
          <Icon source="chevron-right" size={24} color={theme.text.muted} />
        </View>
      </GlassCard>

      {/* 2. Navigation Cards: Categories, Notifications, Security */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.md}
        accessibilityLabel={vi.manageCategories}
        onPress={() => setManagingCategories(true)}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="shape-outline"
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
                {vi.manageCategories}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
                {vi.categoryStructureHint}
              </Text>
            </View>
          </View>
          <Icon source="chevron-right" size={24} color={theme.text.muted} />
        </View>
      </GlassCard>

      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.md}
        accessibilityLabel={vi.settingsNotificationsMenuTitle}
        onPress={() => setViewingNotifications(true)}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="bell-ring-outline"
              bg={theme.brand.primarySoft}
              fg={theme.brand.primary}
              size={42}
              iconSize={22}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                variant="titleMedium"
                style={{ fontWeight: '700', color: theme.text.primary }}
              >
                {vi.settingsNotificationsMenuTitle}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
                {vi.settingsNotificationsMenuSubtitle}
              </Text>
            </View>
          </View>
          <Icon source="chevron-right" size={24} color={theme.text.muted} />
        </View>
      </GlassCard>

      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.md}
        accessibilityLabel={vi.settingsSecurityTitle}
        onPress={() => setViewingSecurity(true)}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="shield-lock-outline"
              bg={palette.tealSoft}
              fg={palette.tealInk}
              size={42}
              iconSize={22}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                variant="titleMedium"
                style={{ fontWeight: '700', color: theme.text.primary }}
              >
                {vi.settingsSecurityTitle}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
                {vi.settingsSecuritySubtitle}
              </Text>
            </View>
          </View>
          <Icon source="chevron-right" size={24} color={theme.text.muted} />
        </View>
      </GlassCard>

      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.md}
        accessibilityLabel={vi.backupMenuTitle}
        onPress={() => setViewingBackup(true)}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="google-drive"
              bg={
                showBackupIssueBadge
                  ? palette.warningSoft
                  : theme.brand.primarySoft
              }
              fg={
                showBackupIssueBadge ? palette.warningInk : theme.brand.primary
              }
              size={42}
              iconSize={22}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <View style={localStyles.backupTitleRow}>
                <Text
                  variant="titleMedium"
                  style={{ fontWeight: '700', color: theme.text.primary }}
                >
                  {vi.backupMenuTitle}
                </Text>
                {showBackupIssueBadge && (
                  <View
                    style={[
                      localStyles.issueBadge,
                      {
                        backgroundColor: palette.warningSoft,
                        borderColor: palette.warning,
                      },
                    ]}
                  >
                    <View
                      style={[
                        localStyles.issueDot,
                        { backgroundColor: palette.warning },
                      ]}
                    />
                    <Text
                      variant="labelSmall"
                      style={{
                        color: palette.warningInk,
                        fontWeight: '700',
                        fontSize: 10,
                      }}
                    >
                      {vi.backupMenuBadgeIssue}
                    </Text>
                  </View>
                )}
              </View>
              <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
                {backupStatus.state.accountEmail
                  ? vi.backupMenuSubtitleConnected.replace(
                      '{email}',
                      backupStatus.state.accountEmail,
                    )
                  : vi.backupMenuSubtitleDisconnected}
              </Text>
            </View>
          </View>
          <Icon source="chevron-right" size={24} color={theme.text.muted} />
        </View>
      </GlassCard>

      {/* 3. Preview / Seed Data (Development builds only) */}
      {isDevSeedToolsEnabled() && (
        <>
          <View style={{ gap: 2 }}>
            <Text
              variant="titleSmall"
              style={{ fontWeight: '700', color: theme.text.primary }}
            >
              {vi.settingsExperiments}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.text.muted }}>
              {vi.settingsExperimentsHint}
            </Text>
          </View>

          <GlassCard
            variant="elevated"
            radius="xl"
            padding={DesignSpacing.lg}
            style={{ gap: 10 }}
          >
            <View style={styles.row}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  variant="titleSmall"
                  style={{ fontWeight: '700', color: theme.text.primary }}
                >
                  {vi.settingsSeedLabel}
                </Text>
                <Text
                  variant="bodySmall"
                  style={{ color: theme.text.secondary, lineHeight: 18 }}
                >
                  {vi.settingsSeedDescription}
                </Text>
              </View>
              <Switch
                accessibilityLabel={vi.settingsSeedLabel}
                value={seedEnabled}
                disabled={seedBusy}
                color={theme.brand.primary}
                onValueChange={(value) => void handleToggleSeed(value)}
              />
            </View>
            {!!seedError && (
              <Text
                accessibilityRole="alert"
                variant="bodySmall"
                style={{ color: palette.danger }}
              >
                {seedError}
              </Text>
            )}
            {!!seedNotice && (
              <Text
                variant="bodySmall"
                style={{ color: theme.finance.incomeText, fontWeight: '700' }}
              >
                {seedNotice}
              </Text>
            )}
          </GlassCard>
        </>
      )}

      {/* 5. Local Data & Timezone Info Card */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.lg}
        style={{ gap: 12 }}
      >
        <View style={styles.inlineRow}>
          <IconBadge
            icon="database-outline"
            bg={palette.tealSoft}
            fg={palette.tealInk}
            size={38}
            iconSize={20}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              variant="titleMedium"
              style={{ fontWeight: '700', color: theme.text.primary }}
            >
              {vi.localData}
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.text.secondary, lineHeight: 19 }}
            >
              {vi.localDataDescription}
            </Text>
          </View>
        </View>

        <Divider style={{ backgroundColor: theme.card.border }} />

        <View style={styles.row}>
          <View style={styles.inlineRow}>
            <IconBadge
              icon="clock-outline"
              bg={palette.purpleSoft}
              fg={palette.purpleInk}
              size={34}
              iconSize={18}
            />
            <Text
              variant="titleSmall"
              style={{ fontWeight: '600', color: theme.text.primary }}
            >
              {vi.timeZone}
            </Text>
          </View>
          <Text variant="bodyMedium" style={{ color: theme.text.secondary }}>
            {vi.timeZoneValue}
          </Text>
        </View>
      </GlassCard>
    </Screen>
  );
}

const localStyles = StyleSheet.create({
  backupTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  issueBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
  },
  issueDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
