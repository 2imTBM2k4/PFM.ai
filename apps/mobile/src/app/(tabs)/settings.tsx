import { useRouter } from 'expo-router';
import { useTransientState } from '@/hooks/use-transient-state';
import { useState } from 'react';
import { View } from 'react-native';
import { Divider, Icon, List, Switch, Text } from 'react-native-paper';
import { IconBadge, Screen, styles } from '@/components/screen';
import { GlassCard } from '@/components/ui';
import {
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { useBackupRuntimeStatus } from '@/features/backup/mobile';
import { hasBackupIndicatorIssue } from '@/features/backup/scheduler';
import { vi } from '@/messages/vi';
import { isDevSeedToolsEnabled, usePreferences } from '@/state/preferences';

/**
 * Settings screen: display mode (Pastel Sunset / Midnight Aurora), currency,
 * preview tools (seed data and CSV), category management, notifications and PIN security.
 */
export default function Settings() {
  const router = useRouter();
  const openDetail = (screen: string) =>
    router.push({ pathname: '/detail', params: { screen } });
  const [seedNotice, setSeedNotice] = useTransientState('');
  const [seedError, setSeedError] = useState('');
  const [seedBusy, setSeedBusy] = useState(false);

  const palette = useFinancePalette();
  const theme = useDesignTheme();

  const seedEnabled = usePreferences((state) => state.seedEnabled);
  const setSeedEnabled = usePreferences((state) => state.setSeedEnabled);
  const backupStatus = useBackupRuntimeStatus();
  const showBackupIssueBadge = hasBackupIndicatorIssue(backupStatus.state);

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
      {[
        [
          {
            screen: 'appearance',
            title: vi.settingsPreferencesTitle,
            icon: 'palette-swatch-outline',
            description: undefined,
          },
          {
            screen: 'categories',
            title: vi.manageCategories,
            icon: 'shape-outline',
            description: vi.categoryStructureHint,
          },
          {
            screen: 'notifications',
            title: vi.settingsNotificationsMenuTitle,
            icon: 'bell-ring-outline',
            description: vi.settingsNotificationsMenuSubtitle,
          },
        ],
        [
          {
            screen: 'security',
            title: vi.settingsSecurityTitle,
            icon: 'shield-lock-outline',
            description: vi.settingsSecuritySubtitle,
          },
          {
            screen: 'backup',
            title: vi.backupMenuTitle,
            icon: 'cloud-upload-outline',
            description: [
              backupStatus.state.accountEmail
                ? vi.backupMenuSubtitleConnected.replace(
                    '{email}',
                    backupStatus.state.accountEmail,
                  )
                : vi.backupMenuSubtitleDisconnected,
              showBackupIssueBadge ? vi.backupMenuBadgeIssue : '',
            ]
              .filter(Boolean)
              .join(' ? '),
          },
        ],
      ].map((group, groupIndex) => (
        <GlassCard key={groupIndex} variant="elevated" radius="md" padding={0}>
          {group.map((item, index) => (
            <View key={item.screen}>
              {index > 0 && (
                <Divider
                  style={{
                    marginStart: 60,
                    backgroundColor: theme.card.border,
                  }}
                />
              )}
              <List.Item
                title={item.title}
                description={item.description}
                titleNumberOfLines={0}
                descriptionNumberOfLines={0}
                titleStyle={{
                  color: theme.text.primary,
                  fontSize: 17,
                  fontWeight: '400',
                }}
                descriptionStyle={{ color: theme.text.secondary }}
                style={{ minHeight: 64, paddingHorizontal: 12 }}
                left={() => (
                  <View style={{ justifyContent: 'center' }}>
                    <IconBadge
                      icon={item.icon}
                      bg={theme.brand.primarySoft}
                      fg={theme.brand.primaryText}
                      size={32}
                      iconSize={19}
                    />
                  </View>
                )}
                right={() => (
                  <View style={{ justifyContent: 'center' }}>
                    <Icon
                      source="chevron-right"
                      size={20}
                      color={theme.text.muted}
                    />
                  </View>
                )}
                accessibilityRole="button"
                accessibilityLabel={[item.title, item.description]
                  .filter(Boolean)
                  .join('. ')}
                onPress={() => openDetail(item.screen)}
              />
            </View>
          ))}
        </GlassCard>
      ))}

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
