import { useEffect } from 'react';
import { BackHandler, Pressable, StyleSheet, View } from 'react-native';
import { Button, Divider, Icon, Text } from 'react-native-paper';
import { IconBadge, Screen, styles } from '@/components/screen';
import { GlassCard } from '@/components/ui';
import { DesignRadius, DesignSpacing, useDesignTheme } from '@/constants/theme';
import { vi } from '@/messages/vi';
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
            accessibilityLabel={opt.label}
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

/** Displays the existing appearance, language and currency preferences. */
export function AppearanceSettingsView({ onClose }: { onClose(): void }) {
  const theme = useDesignTheme();
  const themeMode = usePreferences((state) => state.themeMode);
  const language = usePreferences((state) => state.language);
  const currency = usePreferences((state) => state.currency);
  const exchangeRate = usePreferences((state) => state.exchangeRate);
  const exchangeRateDate = usePreferences((state) => state.exchangeRateDate);
  const exchangeRateCached = usePreferences(
    (state) => state.exchangeRateCached,
  );

  const setThemeMode = usePreferences((state) => state.setThemeMode);
  const setLanguage = usePreferences((state) => state.setLanguage);
  const setCurrency = usePreferences((state) => state.setCurrency);
  const refreshExchangeRate = usePreferences(
    (state) => state.refreshExchangeRate,
  );
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        onClose();
        return true;
      },
    );
    return () => subscription.remove();
  }, [onClose]);
  return (
    <Screen title={vi.settingsPreferencesTitle} onBack={onClose}>
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
    minHeight: 44,
    borderRadius: DesignRadius.pill,
  },
});
