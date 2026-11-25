import { useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  Button,
  HelperText,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import { Pressable, View } from 'react-native';
import { MAX_AMOUNT_VND } from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import { IconBadge, Screen, styles } from '@/components/screen';
import { MoneyInput } from '@/components/ui';
import { useFinancePalette } from '@/constants/theme';
import { vi } from '@/messages/vi';
import { useApp } from '@/state/app';
import { usePreferences } from '@/state/preferences';
import { PinSettings } from '@/features/lock/pin-controls';
import {
  formatBackupErrorMessage,
  formatBackupTimestamp,
} from '@/features/backup/backup-settings-view';
import type { RemoteBackupMetadata } from '@/features/backup/drive-client';
import {
  inspectRemoteGoogleDriveBackup,
  restoreFromGoogleDriveBackup,
} from '@/features/backup/mobile';
import { isRunningInExpoGo } from 'expo';

const PRESET_BALANCES = [0, 1_500_000, 5_000_000, 10_000_000] as const;

export function Onboarding() {
  const {
    control,
    setValue,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm({ defaultValues: { balance: '' } });
  const [error, setError] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveMessage, setDriveMessage] = useState('');
  const [driveError, setDriveError] = useState('');
  const [remoteMeta, setRemoteMeta] = useState<RemoteBackupMetadata | null>(
    null,
  );
  const [restoreEmail, setRestoreEmail] = useState<string | null>(null);
  const complete = useApp((state) => state.completeOnboarding);
  const language = usePreferences((state) => state.language);
  const theme = useTheme();
  const palette = useFinancePalette();
  const saving = useRef(false);
  const inExpoGo = isRunningInExpoGo();

  async function handleInspectDriveBackup() {
    if (driveBusy || isSubmitting || skipping) return;
    if (inExpoGo) {
      setDriveError(vi.backupExpoGoOnlyBanner);
      return;
    }
    setDriveBusy(true);
    setDriveMessage('');
    setDriveError('');
    setRemoteMeta(null);
    try {
      const res = await inspectRemoteGoogleDriveBackup({
        signInIfNeeded: true,
      });
      if (!res.ok) {
        if (res.error !== 'cancelled') {
          setDriveError(formatBackupErrorMessage(res.error));
        }
        return;
      }
      if (!res.found) {
        setDriveMessage(vi.backupRemoteNotFoundNotice);
        return;
      }
      setRemoteMeta(res.metadata);
      setRestoreEmail(res.accountEmail);
    } finally {
      setDriveBusy(false);
    }
  }

  async function handleConfirmDriveRestore() {
    if (driveBusy || !remoteMeta) return;
    setDriveBusy(true);
    setDriveMessage('');
    setDriveError('');
    try {
      const res = await restoreFromGoogleDriveBackup({
        fileId: remoteMeta.fileId,
        enableAutoBackupAfterRestore: true,
        accountEmail: restoreEmail,
      });
      if (!res.ok) {
        setDriveError(formatBackupErrorMessage(res.error));
      }
    } finally {
      setDriveBusy(false);
    }
  }
  async function save(balance: number) {
    if (saving.current) return;
    saving.current = true;
    setError(false);
    try {
      await complete(balance);
    } catch {
      setError(true);
    } finally {
      saving.current = false;
    }
  }
  return (
    <Screen
      title={vi.welcome}
      subtitle={vi.welcomeDescription}
      hasTabBar={false}
    >
      <View
        style={[
          styles.panel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        <View style={styles.inlineRow}>
          <IconBadge
            icon="wallet-plus-outline"
            bg={palette.primarySoft}
            fg={palette.primaryInk}
            size={44}
            iconSize={22}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="titleMedium" style={{ fontWeight: '700' }}>
              {vi.startingBalance}
            </Text>
            <Text variant="bodySmall" style={{ color: palette.textMuted }}>
              {vi.balanceHint}
            </Text>
          </View>
        </View>

        <Controller
          control={control}
          name="balance"
          rules={{
            validate: (value) =>
              value === '' ||
              (/^\d+$/.test(value) && Number(value) <= MAX_AMOUNT_VND) ||
              vi.invalidAmount,
          }}
          render={({ field: { value, onChange, onBlur }, fieldState }) => (
            <View style={{ gap: 8 }}>
              <MoneyInput
                label={vi.startingBalance}
                accessibilityLabel={vi.startingBalance}
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                error={!!fieldState.error}
                disabled={isSubmitting || skipping}
                left={<TextInput.Icon icon="cash" />}
              />
              {!!fieldState.error && (
                <HelperText type="error">{fieldState.error.message}</HelperText>
              )}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {PRESET_BALANCES.map((preset) => {
                  const selected = value === String(preset);
                  return (
                    <Pressable
                      key={preset}
                      accessibilityRole="button"
                      accessibilityLabel={formatVnd(preset)}
                      accessibilityState={{
                        selected,
                        disabled: isSubmitting || skipping,
                      }}
                      disabled={isSubmitting || skipping}
                      onPress={() =>
                        setValue('balance', String(preset), {
                          shouldValidate: true,
                        })
                      }
                      style={{
                        minHeight: 44,
                        justifyContent: 'center',
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: selected
                          ? palette.primary
                          : palette.border,
                        backgroundColor: selected
                          ? palette.primarySoft
                          : palette.surfaceMuted,
                      }}
                    >
                      <Text
                        variant="labelMedium"
                        style={[
                          styles.number,
                          {
                            color: selected ? palette.primaryInk : palette.text,
                            fontWeight: '600',
                          },
                        ]}
                      >
                        {formatVnd(preset)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}
        />
      </View>

      <View
        style={[
          styles.subtlePanel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        <View style={styles.inlineRow}>
          <IconBadge
            icon="shield-check-outline"
            bg={palette.tealSoft}
            fg={palette.tealInk}
            size={38}
            iconSize={20}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="titleSmall" style={{ fontWeight: '700' }}>
              {isRunningInExpoGo() ? vi.previewTitle : vi.encryptedStorageTitle}
            </Text>
            <Text variant="bodySmall" style={{ color: palette.textMuted }}>
              {isRunningInExpoGo()
                ? vi.previewDescription
                : vi.encryptedStorageDescription}
            </Text>
          </View>
        </View>
      </View>

      <View
        style={[
          styles.subtlePanel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        <PinSettings />
      </View>

      {error && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.error }}>
          {vi.saveError}
        </Text>
      )}
      {!!driveError && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.error }}>
          {driveError}
        </Text>
      )}
      {!!driveMessage && (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: palette.primaryInk, fontWeight: '600' }}
        >
          {driveMessage}
        </Text>
      )}
      {!!remoteMeta && (
        <View
          style={[
            styles.panel,
            {
              backgroundColor: palette.surface,
              borderColor: palette.primary,
              gap: 10,
            },
          ]}
        >
          <Text variant="titleSmall" style={{ fontWeight: '700' }}>
            {vi.backupRemoteFoundSummary
              .replace(
                '{date}',
                formatBackupTimestamp(
                  remoteMeta.createdAt ?? remoteMeta.modifiedTime,
                  language,
                ),
              )
              .replace('{txCount}', String(remoteMeta.txCount))
              .replace('{walletCount}', String(remoteMeta.walletCount))}
          </Text>
          <Button
            hitSlop={4}
            mode="contained"
            icon="cloud-download-outline"
            contentStyle={styles.button}
            loading={driveBusy}
            disabled={driveBusy}
            onPress={() => void handleConfirmDriveRestore()}
          >
            {vi.onboardingRestoreConfirmBtn}
          </Button>
          <Button
            hitSlop={4}
            mode="outlined"
            contentStyle={styles.button}
            disabled={driveBusy}
            onPress={() => setRemoteMeta(null)}
          >
            {vi.cancel}
          </Button>
        </View>
      )}
      <Button
        hitSlop={4}
        mode="contained"
        icon="arrow-right"
        contentStyle={[styles.button, { flexDirection: 'row-reverse' }]}
        loading={isSubmitting}
        disabled={isSubmitting || skipping || driveBusy}
        onPress={() => {
          void handleSubmit(({ balance }) => save(Number(balance || '0')))();
        }}
      >
        {vi.start}
      </Button>
      <Button
        hitSlop={4}
        mode="outlined"
        contentStyle={styles.button}
        disabled={isSubmitting || skipping || driveBusy}
        loading={skipping}
        onPress={async () => {
          setSkipping(true);
          try {
            await save(0);
          } finally {
            setSkipping(false);
          }
        }}
      >
        {vi.skip}
      </Button>
      <Button
        hitSlop={4}
        mode="text"
        icon="google-drive"
        contentStyle={styles.button}
        loading={driveBusy && !remoteMeta}
        disabled={isSubmitting || skipping || driveBusy}
        onPress={() => void handleInspectDriveBackup()}
      >
        {vi.onboardingRestoreFromDriveBtn}
      </Button>
    </Screen>
  );
}
