import { useEffect, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { Button, Divider, Icon, Text } from 'react-native-paper';
import { DeleteDataControl } from '@/components/delete-data-control';
import { IconBadge, Screen, styles } from '@/components/screen';
import { GlassCard } from '@/components/ui';
import {
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import { isPinDeferred, useLockSession } from '@/features/lock/mobile';
import { PinSettings } from '@/features/lock/pin-controls';
import { withdrawReceiptConsent } from '@/features/quick-entry/receipt-consent';
import { vi } from '@/messages/vi';

export function SecuritySettingsView({ onClose }: { onClose(): void }) {
  const [subView, setSubView] = useState<'menu' | 'pin' | 'data'>('menu');
  const [receiptConsentNotice, setReceiptConsentNotice] = useState('');
  const theme = useDesignTheme();
  const palette = useFinancePalette();
  const pinEnabled = useLockSession((state) => state.enabled);

  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (subView !== 'menu') {
          setSubView('menu');
          return true;
        }
        onClose();
        return true;
      },
    );
    return () => subscription.remove();
  }, [subView, onClose]);

  if (subView === 'pin') {
    return (
      <Screen
        title={vi.securityPinMenuTitle}
        onBack={() => setSubView('menu')}
      >
        <GlassCard
          variant="elevated"
          radius="xl"
          padding={DesignSpacing.lg}
          style={{ gap: 12 }}
        >
          <PinSettings />
        </GlassCard>
      </Screen>
    );
  }

  if (subView === 'data') {
    return (
      <Screen
        title={vi.securityDataMenuTitle}
        onBack={() => setSubView('menu')}
      >
        <GlassCard
          variant="elevated"
          radius="xl"
          padding={DesignSpacing.lg}
          style={{ gap: 14 }}
        >
          <View style={styles.inlineRow}>
            <IconBadge
              icon="database-remove-outline"
              bg={palette.dangerSoft}
              fg={palette.dangerInk}
              size={40}
              iconSize={20}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                variant="titleMedium"
                style={{ fontWeight: '700', color: theme.text.primary }}
              >
                {vi.securityDataMenuTitle}
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.text.secondary, lineHeight: 18 }}
              >
                {vi.securityDataMenuSubtitle}
              </Text>
            </View>
          </View>

          <Divider style={{ backgroundColor: theme.card.border }} />

          <DeleteDataControl />

          <Divider style={{ backgroundColor: theme.card.border }} />

          <Button
            mode="outlined"
            onPress={() =>
              void withDatabase(withdrawReceiptConsent)
                .then(() => setReceiptConsentNotice(vi.receiptConsentWithdrawn))
                .catch(() => setReceiptConsentNotice(vi.saveError))
            }
          >
            {vi.receiptConsentWithdraw}
          </Button>
          {!!receiptConsentNotice && (
            <Text accessibilityLiveRegion="polite">{receiptConsentNotice}</Text>
          )}
        </GlassCard>

        <GlassCard
          variant="elevated"
          radius="xl"
          padding={DesignSpacing.lg}
          style={{ gap: 6 }}
        >
          <Text
            accessibilityRole="header"
            variant="titleSmall"
            style={{ fontWeight: '700', color: theme.text.primary }}
          >
            {vi.security}
          </Text>
          <Text
            variant="bodySmall"
            style={{ color: theme.text.secondary, lineHeight: 19 }}
          >
            {vi.securityDescription}
          </Text>
        </GlassCard>
      </Screen>
    );
  }

  const pinStatusSubtitle = isPinDeferred
    ? vi.pinDeferredTitle
    : pinEnabled
      ? vi.pinEnabled
      : vi.pinDisabled;

  return (
    <Screen title={vi.settingsSecurityTitle} onBack={onClose}>
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.md}
        accessibilityLabel={vi.securityPinMenuTitle}
        onPress={() => setSubView('pin')}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="shield-lock-outline"
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
                {vi.securityPinMenuTitle}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
                {pinStatusSubtitle}
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
        accessibilityLabel={vi.securityDataMenuTitle}
        onPress={() => setSubView('data')}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="database-cog-outline"
              bg={palette.dangerSoft}
              fg={palette.dangerInk}
              size={42}
              iconSize={22}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                variant="titleMedium"
                style={{ fontWeight: '700', color: theme.text.primary }}
              >
                {vi.securityDataMenuTitle}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
                {vi.securityDataMenuSubtitle}
              </Text>
            </View>
          </View>
          <Icon source="chevron-right" size={24} color={theme.text.muted} />
        </View>
      </GlassCard>

      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.lg}
        style={{ gap: 6 }}
      >
        <Text
          accessibilityRole="header"
          variant="titleSmall"
          style={{ fontWeight: '700', color: theme.text.primary }}
        >
          {vi.security}
        </Text>
        <Text
          variant="bodySmall"
          style={{ color: theme.text.secondary, lineHeight: 19 }}
        >
          {vi.securityDescription}
        </Text>
      </GlassCard>
    </Screen>
  );
}
