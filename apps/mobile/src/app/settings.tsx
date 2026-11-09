import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Divider, Icon, Switch, Text } from 'react-native-paper';
import { IconBadge, Screen, styles } from '@/components/screen';
import { GlassCard } from '@/components/ui';
import {
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import { CategoryManager } from '@/features/categories/category-manager';
import { SecuritySettingsView } from '@/features/lock/security-settings-view';
import { NotificationSettingsView } from '@/features/notifications/notification-settings-view';
import { vi } from '@/messages/vi';
import {
  exportLocalTransactionsCsv,
  importLocalTransactionsCsv,
} from '@/services/csv-transfer';
import { pickAndReadCsvFile, saveCsvFile } from '@/services/file-transfer';
import { usePreferences } from '@/state/preferences';

function InlineTogglePill<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string; icon?: string }[];
  onChange(next: T): void;
}) {
  const theme = useDesignTheme();
  return (
    <View
      style={[
        localStyles.pillContainer,
        {
          backgroundColor: theme.card.surfaceSubtle,
          borderColor: theme.card.border,
        },
      ]}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(opt.value)}
            style={[
              localStyles.pillOption,
              active && {
                backgroundColor: theme.brand.primary,
              },
            ]}
          >
            {!!opt.icon && (
              <Icon
                source={opt.icon}
                size={14}
                color={active ? '#FFFFFF' : theme.text.secondary}
              />
            )}
            <Text
              variant="labelMedium"
              style={{
                fontWeight: '700',
                color: active ? '#FFFFFF' : theme.text.secondary,
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Settings screen: display mode (Pastel Sunset / Midnight Aurora), currency,
 * preview tools (seed data and CSV), category management, notifications and PIN security.
 */
export default function Settings() {
  const [managingCategories, setManagingCategories] = useState(false);
  const [viewingNotifications, setViewingNotifications] = useState(false);
  const [viewingSecurity, setViewingSecurity] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvNotice, setCsvNotice] = useState('');
  const [csvError, setCsvError] = useState('');
  const [seedNotice, setSeedNotice] = useState('');
  const [seedError, setSeedError] = useState('');
  const [seedBusy, setSeedBusy] = useState(false);

  const palette = useFinancePalette();
  const theme = useDesignTheme();

  const themeMode = usePreferences((state) => state.themeMode);
  const language = usePreferences((state) => state.language);
  const currency = usePreferences((state) => state.currency);
  const exchangeRate = usePreferences((state) => state.exchangeRate);
  const exchangeRateDate = usePreferences((state) => state.exchangeRateDate);
  const exchangeRateCached = usePreferences(
    (state) => state.exchangeRateCached,
  );
  const seedEnabled = usePreferences((state) => state.seedEnabled);
  const setThemeMode = usePreferences((state) => state.setThemeMode);
  const setLanguage = usePreferences((state) => state.setLanguage);
  const setCurrency = usePreferences((state) => state.setCurrency);
  const refreshExchangeRate = usePreferences(
    (state) => state.refreshExchangeRate,
  );
  const setSeedEnabled = usePreferences((state) => state.setSeedEnabled);

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

  const handleExportCsv = async () => {
    if (csvBusy) return;
    setCsvBusy(true);
    setCsvError('');
    setCsvNotice('');
    try {
      const exported = await exportLocalTransactionsCsv();
      const dateStr = new Date().toISOString().slice(0, 10);
      const fileName = `pfm-transactions-${dateStr}.csv`;
      await saveCsvFile(fileName, exported);
      setCsvNotice(`${vi.csvExportSuccess}: ${fileName}`);
    } catch {
      setCsvError(vi.saveError);
    } finally {
      setCsvBusy(false);
    }
  };

  const handlePickAndImportCsv = async () => {
    if (csvBusy) return;
    setCsvBusy(true);
    setCsvError('');
    setCsvNotice('');
    try {
      const picked = await pickAndReadCsvFile();
      if (!picked) {
        setCsvBusy(false);
        return;
      }
      const count = await withDatabase((db) =>
        importLocalTransactionsCsv(db, picked.content),
      );
      setCsvNotice(
        `${vi.csvImportSuccess} (${count} ${language === 'en' ? 'from' : 'từ'} ${picked.fileName})`,
      );
    } catch {
      setCsvError(vi.csvImportError);
    } finally {
      setCsvBusy(false);
    }
  };

  return (
    <Screen title={vi.settings}>
      {/* 1. Display preferences (Single-row toggles) */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.lg}
        style={{ gap: 12 }}
      >
        <View style={styles.inlineRow}>
          <IconBadge
            icon="palette-swatch-outline"
            bg={theme.brand.primarySoft}
            fg={theme.brand.primaryText}
            size={40}
            iconSize={20}
          />
          <View style={{ flex: 1 }}>
            <Text
              variant="titleMedium"
              style={{ fontWeight: '800', color: theme.text.primary }}
            >
              {vi.settingsPreferencesTitle}
            </Text>
          </View>
        </View>

        <Divider style={{ backgroundColor: theme.card.border }} />

        <View style={localStyles.singleRowSetting}>
          <Text
            variant="titleSmall"
            style={{ fontWeight: '700', color: theme.text.primary, flex: 1 }}
          >
            {vi.settingsLanguageLabel}
          </Text>
          <InlineTogglePill
            value={language}
            onChange={(value) => void setLanguage(value)}
            options={[
              { value: 'vi', label: vi.settingsLanguageVi },
              { value: 'en', label: vi.settingsLanguageEn },
            ]}
          />
        </View>

        <Divider style={{ backgroundColor: theme.card.border }} />

        <View style={localStyles.singleRowSetting}>
          <Text
            variant="titleSmall"
            style={{ fontWeight: '700', color: theme.text.primary, flex: 1 }}
          >
            {vi.settingsCurrencyLabel}
          </Text>
          <InlineTogglePill
            value={currency}
            onChange={(value) => void setCurrency(value)}
            options={[
              { value: 'VND', label: 'VND (₫)' },
              { value: 'USD', label: 'USD ($)' },
            ]}
          />
        </View>

        <View style={localStyles.exchangeRateRow}>
          <Text
            variant="bodySmall"
            style={{ color: theme.text.muted, flex: 1 }}
          >
            {exchangeRate && exchangeRateDate
              ? `1 USD ≈ ${Math.round(exchangeRate).toLocaleString(language === 'en' ? 'en-US' : 'vi-VN')} ₫ · ${exchangeRateDate}${exchangeRateCached ? (language === 'en' ? ' · cached' : ' · đã lưu') : ''}`
              : language === 'en'
                ? 'USD/VND rate unavailable. Connect to the internet to convert amounts.'
                : 'Chưa có tỷ giá USD/VND. Cần kết nối mạng để quy đổi.'}
          </Text>
          <Button compact onPress={() => void refreshExchangeRate()}>
            {language === 'en' ? 'Refresh' : 'Cập nhật tỷ giá'}
          </Button>
        </View>

        <Divider style={{ backgroundColor: theme.card.border }} />

        <View style={localStyles.singleRowSetting}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              variant="titleSmall"
              style={{ fontWeight: '700', color: theme.text.primary }}
            >
              {vi.settingsThemeLabel}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.text.muted }}>
              Pastel Sunset / Midnight Aurora
            </Text>
          </View>
          <InlineTogglePill
            value={themeMode}
            onChange={(value) => void setThemeMode(value)}
            options={[
              {
                value: 'light',
                label: vi.settingsThemeLightShort,
                icon: 'weather-sunset',
              },
              {
                value: 'dark',
                label: vi.settingsThemeDarkShort,
                icon: 'weather-night',
              },
            ]}
          />
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

      {/* 3. Preview / Seed Data */}
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

      {/* 4. Local CSV Import / Export Card */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.lg}
        style={{ gap: 12 }}
      >
        <View style={styles.inlineRow}>
          <IconBadge
            icon="file-delimited-outline"
            bg={palette.tealSoft}
            fg={palette.tealInk}
            size={40}
            iconSize={20}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              variant="titleMedium"
              style={{ fontWeight: '800', color: theme.text.primary }}
            >
              {vi.csvSectionTitle}
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.text.secondary, lineHeight: 18 }}
            >
              {vi.csvSectionHint}
            </Text>
          </View>
        </View>

        <View style={localStyles.csvButtonsRow}>
          <Button
            mode="contained"
            compact
            icon="tray-arrow-up"
            buttonColor={theme.brand.primaryStrong}
            textColor="#FFFFFF"
            disabled={csvBusy}
            loading={csvBusy}
            onPress={() => void handleExportCsv()}
          >
            {vi.csvExportBtn}
          </Button>
          <Button
            mode="contained-tonal"
            compact
            icon="folder-open-outline"
            disabled={csvBusy}
            loading={csvBusy}
            onPress={() => void handlePickAndImportCsv()}
          >
            {vi.csvPickFileBtn}
          </Button>
        </View>

        <Text
          variant="bodySmall"
          style={{
            color: theme.brand.primaryText,
            fontStyle: 'italic',
            fontSize: 12,
            lineHeight: 16,
          }}
        >
          {vi.csvDriveBackupNote}
        </Text>

        {!!csvNotice && (
          <Text
            accessibilityLiveRegion="polite"
            variant="bodySmall"
            style={{ color: theme.finance.incomeText, fontWeight: '700' }}
          >
            {csvNotice}
          </Text>
        )}
        {!!csvError && (
          <Text
            accessibilityRole="alert"
            variant="bodySmall"
            style={{ color: palette.danger, fontWeight: '600' }}
          >
            {csvError}
          </Text>
        )}
      </GlassCard>

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
  singleRowSetting: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  exchangeRateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  pillContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
    padding: 3,
    gap: 2,
  },
  pillOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: DesignRadius.pill,
  },
  csvButtonsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
});
