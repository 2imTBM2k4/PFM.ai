import { useFocusedBackHandler } from '@/hooks/use-focused-back-handler';
import { LocalTransferSettings } from './local-transfer-settings';
import { useTransientState } from '@/hooks/use-transient-state';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { isRunningInExpoGo } from 'expo';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Divider, Switch, Text, TextInput } from 'react-native-paper';
import { IconBadge, Screen, styles } from '@/components/screen';
import { GlassCard } from '@/components/ui';
import {
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { vi } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';
import type { RemoteBackupMetadata } from './drive-client';
import {
  connectGoogleDriveBackup,
  disconnectGoogleDriveBackup,
  inspectRemoteGoogleDriveBackup,
  restoreFromGoogleDriveBackup,
  runManualGoogleDriveBackup,
  setGoogleDriveAutoBackupEnabled,
  useBackupRuntimeStatus,
  type BackupOperationError,
} from './mobile';

export function formatBackupErrorMessage(
  error: BackupOperationError | null,
): string {
  if (!error) return '';
  switch (error) {
    case 'needs_reauth':
      return vi.backupErrorNeedsReauth;
    case 'drive_quota_exceeded':
      return vi.backupErrorQuotaExceeded;
    case 'network_error':
      return vi.backupErrorNetwork;
    case 'schema_newer_than_app':
      return vi.backupErrorSchemaNewer;
    case 'checksum_mismatch':
      return vi.backupErrorChecksumMismatch;
    case 'verify_failed':
      return vi.backupErrorVerifyFailed;
    case 'play_services_unavailable':
      return vi.backupErrorPlayServices;
    case 'not_configured':
      return vi.backupErrorNotConfigured;
    case 'expo_go_unsupported':
      return vi.backupExpoGoOnlyBanner;
    case 'cancelled':
      return vi.backupErrorCancelled;
    default:
      return vi.backupErrorGeneric;
  }
}

export function formatBackupTimestamp(
  iso: string | null,
  language: 'vi' | 'en',
): string {
  if (!iso) return vi.backupNeverSucceeded;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  try {
    return parsed.toLocaleString(language === 'en' ? 'en-US' : 'vi-VN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

export function BackupSettingsView({ onClose }: { onClose(): void }) {
  const theme = useDesignTheme();
  const palette = useFinancePalette();
  const language = usePreferences((s) => s.language);
  const runtime = useBackupRuntimeStatus();
  const { state, isUploading } = runtime;

  const inExpoGo = isRunningInExpoGo() || !runtime.isSupportedRuntime;
  const isConnected = Boolean(state.accountEmail);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useTransientState('');
  const [actionError, setActionError] = useState<BackupOperationError | null>(
    null,
  );
  const [remoteMeta, setRemoteMeta] = useState<RemoteBackupMetadata | null>(
    null,
  );
  const [restoreAccountEmail, setRestoreAccountEmail] = useState<string | null>(
    null,
  );
  const [restoreConfirmText, setRestoreConfirmText] = useState('');
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  useUnsavedChangesGuard({
    id: 'backup-navigation',
    scope: 'tab',
    routeKey: 'settings',
    dirty: false,
    saving: busy,
    onDiscard: onClose,
  });

  useFocusedBackHandler(() => {
    onClose();
    return true;
  });

  const activeError: BackupOperationError | null =
    actionError ?? state.lastError;

  const handleSignInAndEnable = async () => {
    if (busy || isUploading || inExpoGo) return;
    setBusy(true);
    setNotice('');
    setActionError(null);
    try {
      const res = await connectGoogleDriveBackup();
      if (!res.ok) {
        if (res.error !== 'cancelled') {
          setActionError(res.error);
        }
      } else {
        setNotice(vi.backupNowSuccessNotice);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleToggleAuto = async (next: boolean) => {
    if (busy) return;
    setNotice('');
    setActionError(null);
    await setGoogleDriveAutoBackupEnabled(next);
  };

  const handleBackupNow = async () => {
    if (busy || isUploading || inExpoGo) return;
    setBusy(true);
    setNotice('');
    setActionError(null);
    try {
      const res = await runManualGoogleDriveBackup();
      if (res.ok) {
        setNotice(vi.backupNowSuccessNotice);
      } else if (res.error) {
        setActionError(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleInspectForRestore = async () => {
    if (busy || isUploading || inExpoGo) return;
    setBusy(true);
    setNotice('');
    setActionError(null);
    setRemoteMeta(null);
    setRestoreConfirmText('');
    try {
      const res = await inspectRemoteGoogleDriveBackup({
        signInIfNeeded: true,
      });
      if (!res.ok) {
        if (res.error !== 'cancelled') {
          setActionError(res.error);
        }
        return;
      }
      if (!res.found) {
        setNotice(vi.backupRemoteNotFoundNotice);
        return;
      }
      setRemoteMeta(res.metadata);
      setRestoreAccountEmail(res.accountEmail);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmRestore = async () => {
    if (
      busy ||
      isUploading ||
      !remoteMeta ||
      restoreConfirmText !== vi.backupRestoreConfirmWord
    ) {
      return;
    }
    setBusy(true);
    setNotice('');
    setActionError(null);
    try {
      const res = await restoreFromGoogleDriveBackup({
        fileId: remoteMeta.fileId,
        enableAutoBackupAfterRestore: true,
        accountEmail: restoreAccountEmail ?? state.accountEmail,
      });
      if (!res.ok) {
        setActionError(res.error);
        return;
      }
      setRemoteMeta(null);
      setRestoreConfirmText('');
      setNotice(vi.backupRestoreSuccessNotice);
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async (deleteRemoteFile: boolean) => {
    if (busy || isUploading) return;
    setBusy(true);
    setNotice('');
    setActionError(null);
    try {
      await disconnectGoogleDriveBackup({ deleteRemoteFile });
      setConfirmingDisconnect(false);
      setRemoteMeta(null);
      setRestoreConfirmText('');
      setNotice(vi.backupDisconnectedNotice);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={vi.backupMenuTitle} onBack={onClose} backDisabled={busy}>
      {/* Expo Go Notice */}
      {inExpoGo && (
        <GlassCard
          variant="default"
          radius="xl"
          padding={DesignSpacing.md}
          style={{
            backgroundColor: palette.warningSoft,
            borderColor: palette.warning,
          }}
        >
          <View style={styles.inlineRow}>
            <IconBadge
              icon="information-outline"
              bg={palette.warning}
              fg="#FFFFFF"
              size={36}
              iconSize={20}
            />
            <Text
              variant="bodySmall"
              style={{
                flex: 1,
                color: palette.warningInk,
                fontWeight: '700',
                lineHeight: 19,
              }}
            >
              {vi.backupExpoGoOnlyBanner}
            </Text>
          </View>
        </GlassCard>
      )}

      {/* Error Banner with Action */}
      {!!activeError && activeError !== 'expo_go_unsupported' && (
        <GlassCard
          variant="default"
          radius="xl"
          padding={DesignSpacing.md}
          style={{
            backgroundColor: palette.dangerSoft,
            borderColor: palette.danger,
            gap: 10,
          }}
        >
          <View style={styles.inlineRow}>
            <IconBadge
              icon="alert-circle-outline"
              bg={palette.danger}
              fg="#FFFFFF"
              size={36}
              iconSize={20}
            />
            <Text
              accessibilityRole="alert"
              variant="bodySmall"
              style={{
                flex: 1,
                color: palette.dangerInk,
                fontWeight: '700',
                lineHeight: 19,
              }}
            >
              {formatBackupErrorMessage(activeError)}
            </Text>
          </View>
          {activeError === 'needs_reauth' && !inExpoGo && (
            <Button
              hitSlop={4}
              mode="contained"
              icon="google"
              buttonColor={palette.danger}
              textColor="#FFFFFF"
              loading={busy}
              disabled={busy || isUploading}
              onPress={() => void handleSignInAndEnable()}
            >
              {vi.backupActionReauth}
            </Button>
          )}
        </GlassCard>
      )}

      {/* Success / Info Notice */}
      {!!notice && (
        <GlassCard
          variant="default"
          radius="xl"
          padding={DesignSpacing.md}
          style={{
            backgroundColor: palette.tealSoft,
            borderColor: palette.teal,
          }}
        >
          <Text
            accessibilityLiveRegion="polite"
            variant="bodySmall"
            style={{ color: palette.tealInk, fontWeight: '700' }}
          >
            {notice}
          </Text>
        </GlassCard>
      )}

      {/* Connected Account & Controls OR Sign-In Card */}
      {isConnected ? (
        <GlassCard
          variant="elevated"
          radius="xl"
          padding={DesignSpacing.lg}
          style={{ gap: 14 }}
        >
          <View style={styles.inlineRow}>
            <IconBadge
              icon="google-drive"
              bg={theme.brand.primarySoft}
              fg={theme.brand.primary}
              size={42}
              iconSize={22}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                variant="labelMedium"
                style={{ color: theme.text.muted, fontWeight: '600' }}
              >
                {vi.backupConnectedAccountLabel}
              </Text>
              <Text
                variant="titleMedium"
                style={{ fontWeight: '800', color: theme.text.primary }}
              >
                {state.accountEmail}
              </Text>
            </View>
          </View>

          <Divider style={{ backgroundColor: theme.card.border }} />

          <View style={styles.row}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                variant="titleSmall"
                style={{ fontWeight: '700', color: theme.text.primary }}
              >
                {vi.backupAutoSwitchLabel}
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.text.secondary, lineHeight: 18 }}
              >
                {vi.backupAutoSwitchDescription}
              </Text>
            </View>
            <Switch
              accessibilityLabel={vi.backupAutoSwitchLabel}
              value={state.enabled}
              disabled={busy || inExpoGo}
              color={theme.brand.primary}
              onValueChange={(next) => void handleToggleAuto(next)}
            />
          </View>

          <Divider style={{ backgroundColor: theme.card.border }} />

          <View style={{ gap: 4 }}>
            <Text
              variant="labelMedium"
              style={{ color: theme.text.muted, fontWeight: '600' }}
            >
              {vi.backupLastSuccessLabel}
            </Text>
            <Text
              variant="bodyMedium"
              style={{ color: theme.text.primary, fontWeight: '700' }}
            >
              {isUploading
                ? vi.backupStatusUploading
                : formatBackupTimestamp(state.lastSuccessAt, language)}
            </Text>
          </View>

          <View style={localStyles.actionsRow}>
            <Button
              hitSlop={4}
              mode="contained"
              icon="cloud-upload-outline"
              buttonColor={theme.brand.primaryStrong}
              textColor="#FFFFFF"
              loading={busy || isUploading}
              disabled={busy || isUploading || inExpoGo}
              onPress={() => void handleBackupNow()}
            >
              {vi.backupNowButton}
            </Button>
            <Button
              hitSlop={4}
              mode="contained-tonal"
              icon="cloud-download-outline"
              disabled={busy || isUploading || inExpoGo}
              onPress={() => void handleInspectForRestore()}
            >
              {vi.backupRestoreButton}
            </Button>
          </View>
        </GlassCard>
      ) : (
        <GlassCard
          variant="elevated"
          radius="xl"
          padding={DesignSpacing.lg}
          style={{ gap: 14 }}
        >
          <Button
            hitSlop={4}
            mode="contained"
            icon="google"
            buttonColor={theme.brand.primaryStrong}
            textColor="#FFFFFF"
            contentStyle={styles.button}
            loading={busy || isUploading}
            disabled={busy || isUploading || inExpoGo}
            onPress={() => void handleSignInAndEnable()}
          >
            {vi.backupSignInButton}
          </Button>
          <Button
            hitSlop={4}
            mode="outlined"
            icon="cloud-download-outline"
            contentStyle={styles.button}
            disabled={busy || isUploading || inExpoGo}
            onPress={() => void handleInspectForRestore()}
          >
            {vi.backupRestoreButton}
          </Button>
        </GlassCard>
      )}

      {/* Restore Confirmation Card (when remote backup metadata has been fetched) */}
      {!!remoteMeta && (
        <GlassCard
          variant="elevated"
          radius="xl"
          padding={DesignSpacing.lg}
          style={{
            gap: 12,
            borderColor: palette.warning,
            borderWidth: 1,
          }}
        >
          <Text
            variant="titleSmall"
            style={{ fontWeight: '800', color: theme.text.primary }}
          >
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
          <Text
            variant="bodySmall"
            style={{ color: palette.dangerInk, lineHeight: 19 }}
          >
            {vi.backupRestoreWarningExplanation}
          </Text>
          <TextInput
            label={vi.backupRestoreConfirmPrompt}
            accessibilityLabel={vi.backupRestoreConfirmPrompt}
            mode="outlined"
            value={restoreConfirmText}
            onChangeText={setRestoreConfirmText}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <Button
            hitSlop={4}
            mode="contained"
            icon="cloud-download-outline"
            buttonColor={palette.danger}
            textColor="#FFFFFF"
            loading={busy}
            disabled={
              busy || restoreConfirmText !== vi.backupRestoreConfirmWord
            }
            onPress={() => void handleConfirmRestore()}
          >
            {vi.backupRestoreConfirmButton}
          </Button>
          <Button
            hitSlop={4}
            mode="outlined"
            disabled={busy}
            onPress={() => {
              setRemoteMeta(null);
              setRestoreConfirmText('');
            }}
          >
            {vi.cancel}
          </Button>
        </GlassCard>
      )}

      {/* Transparency Card: What is backed up, where, unencrypted JSON notice, and what is excluded */}
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.lg}
        style={{ gap: 12 }}
      >
        <View style={styles.inlineRow}>
          <IconBadge
            icon="shield-alert-outline"
            bg={palette.warningSoft}
            fg={palette.warningInk}
            size={38}
            iconSize={20}
          />
          <Text
            variant="titleSmall"
            style={{ fontWeight: '800', color: theme.text.primary, flex: 1 }}
          >
            {vi.backupWhatIsBackedUpTitle}
          </Text>
        </View>
        <Text
          variant="bodySmall"
          style={{ color: theme.text.secondary, lineHeight: 20 }}
        >
          {vi.backupWhatIsBackedUpBody}
        </Text>

        <Divider style={{ backgroundColor: theme.card.border }} />

        <Text
          variant="titleSmall"
          style={{ fontWeight: '800', color: theme.text.primary }}
        >
          {vi.backupWhatIsExcludedTitle}
        </Text>
        <Text
          variant="bodySmall"
          style={{ color: theme.text.secondary, lineHeight: 20 }}
        >
          {vi.backupWhatIsExcludedBody}
        </Text>
      </GlassCard>

      {/* Disconnect Controls (when connected) */}
      {isConnected && (
        <GlassCard
          variant="elevated"
          radius="xl"
          padding={DesignSpacing.lg}
          style={{ gap: 12 }}
        >
          {!confirmingDisconnect ? (
            <Button
              hitSlop={4}
              mode="outlined"
              icon="logout-variant"
              textColor={palette.danger}
              style={{ borderColor: palette.danger }}
              disabled={busy || isUploading}
              onPress={() => setConfirmingDisconnect(true)}
            >
              {vi.backupDisconnectButton}
            </Button>
          ) : (
            <View style={{ gap: 10 }}>
              <Text
                variant="bodySmall"
                style={{ color: theme.text.secondary, lineHeight: 19 }}
              >
                {vi.backupDisconnectExplanation}
              </Text>
              <Button
                hitSlop={4}
                mode="contained"
                buttonColor={theme.brand.primaryStrong}
                textColor="#FFFFFF"
                loading={busy}
                disabled={busy}
                onPress={() => void handleDisconnect(false)}
              >
                {vi.backupDisconnectKeepRemoteButton}
              </Button>
              <Button
                hitSlop={4}
                mode="outlined"
                textColor={palette.danger}
                style={{ borderColor: palette.danger }}
                disabled={busy}
                onPress={() => void handleDisconnect(true)}
              >
                {vi.backupDisconnectDeleteRemoteButton}
              </Button>
              <Button
                hitSlop={4}
                mode="text"
                disabled={busy}
                onPress={() => setConfirmingDisconnect(false)}
              >
                {vi.cancel}
              </Button>
            </View>
          )}
        </GlassCard>
      )}
      <LocalTransferSettings />
    </Screen>
  );
}

const localStyles = StyleSheet.create({
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    borderRadius: DesignRadius.md,
  },
});
