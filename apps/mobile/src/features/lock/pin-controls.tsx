import { useTransientState } from '@/hooks/use-transient-state';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import {
  Button,
  HelperText,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { vi } from '@/messages/vi';
import { styles } from '@/components/screen';
import {
  checkPinStorage,
  isPinDeferred,
  lockSession,
  pinLock,
  useLockSession,
} from './mobile';
import { logAppEvent } from '@/services/logger';

export function pinErrorMessage(error: unknown) {
  switch (error instanceof Error ? error.message : '') {
    case 'PIN_INVALID':
      return vi.pinInvalid;
    case 'PIN_DELAYED':
      return vi.pinDelayed;
    default:
      return vi.pinStorageError;
  }
}

export function PinField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  return (
    <TextInput
      mode="outlined"
      label={label}
      accessibilityLabel={label}
      value={value}
      onChangeText={onChange}
      secureTextEntry
      keyboardType="number-pad"
      maxLength={12}
      autoComplete="off"
      textContentType="none"
      autoCorrect={false}
      disabled={disabled}
    />
  );
}

export function RetryDelay() {
  const blockedUntil = useLockSession((state) => state.blockedUntil);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const remaining = Math.max(0, Math.ceil((blockedUntil - now) / 1000));
  return remaining > 0 ? (
    <View style={{ gap: 4 }}>
      <Text>{vi.pinWaitLabel}</Text>
      <Text style={styles.number}>{remaining}</Text>
    </View>
  ) : null;
}

export function PinSettings() {
  if (isPinDeferred)
    return (
      <View style={{ gap: 12 }}>
        <Text accessibilityRole="header" variant="titleMedium">
          {vi.pinDeferredTitle}
        </Text>
        <Text>{vi.pinDeferredDescription}</Text>
      </View>
    );
  return <ActivePinSettings />;
}

function ActivePinSettings() {
  const enabled = useLockSession((state) => state.enabled);
  const [mode, setMode] = useState<'enable' | 'change' | 'disable' | null>(
    null,
  );
  const [saved, setSaved] = useTransientState(false);
  return (
    <View style={{ gap: 16 }}>
      <Text accessibilityRole="header" variant="titleMedium">
        {enabled ? vi.pinEnabled : vi.pinDisabled}
      </Text>
      <Text>{vi.pinDescription}</Text>
      <Text>{vi.biometricsDeferred}</Text>
      {saved && <Text accessibilityLiveRegion="polite">{vi.pinSaved}</Text>}
      {mode ? (
        <PinForm
          mode={mode}
          onDone={() => {
            setMode(null);
            setSaved(true);
          }}
          onCancel={() => setMode(null)}
        />
      ) : enabled ? (
        <>
          <Button
            hitSlop={4}
            contentStyle={styles.button}
            onPress={() => {
              setSaved(false);
              setMode('change');
            }}
          >
            {vi.pinChange}
          </Button>
          <Button
            hitSlop={4}
            contentStyle={styles.button}
            onPress={() => {
              setSaved(false);
              setMode('disable');
            }}
          >
            {vi.pinDisable}
          </Button>
          <Button
            hitSlop={4}
            contentStyle={styles.button}
            onPress={() => lockSession.getState().lock()}
          >
            {vi.pinLockNow}
          </Button>
        </>
      ) : (
        <Button
          hitSlop={4}
          contentStyle={styles.button}
          onPress={() => {
            setSaved(false);
            setMode('enable');
          }}
        >
          {vi.pinEnable}
        </Button>
      )}
    </View>
  );
}

function PinForm({
  mode,
  onDone,
  onCancel,
}: {
  mode: 'enable' | 'change' | 'disable';
  onDone(): void;
  onCancel(): void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [storageResult, setStorageResult] = useState('');
  const working = useRef(false);
  const { colors } = useTheme();
  const hasPinInput =
    current.length > 0 || next.length > 0 || confirmation.length > 0;
  const { requestLeave } = useUnsavedChangesGuard({
    id: 'pin-form',
    scope: 'tab',
    routeKey: 'settings',
    dirty: hasPinInput,
    saving: busy,
    hasError: !!error,
    onDiscard: onCancel,
  });
  async function diagnoseStorage() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setStorageResult('');
    try {
      await checkPinStorage();
      setStorageResult(vi.pinStorageCheckPassed);
    } catch {
      setStorageResult(vi.pinStorageError);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    if (working.current) return;
    if (mode !== 'disable' && !/^\d{6,12}$/.test(next)) {
      setError(vi.pinInvalid);
      return;
    }
    if (mode !== 'disable' && next !== confirmation) {
      setError(vi.pinMismatch);
      return;
    }
    working.current = true;
    setBusy(true);
    setError('');
    try {
      let valid = true;
      if (mode === 'enable') await pinLock.enable(next);
      else if (mode === 'change') valid = await pinLock.change(current, next);
      else valid = await pinLock.disable(current);
      await lockSession.getState().refresh();
      if (!valid) {
        setError(vi.pinWrong);
        setCurrent('');
        return;
      }
      setCurrent('');
      setNext('');
      setConfirmation('');
      onDone();
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const errorCode = [
        'PIN_RECORD_INVALID',
        'PIN_VERIFIER_INVALID',
        'PIN_SALT_INVALID',
      ].includes(code)
        ? code
        : 'PIN_OPERATION_FAILED';
      logAppEvent('error', { route: 'lock', status: 'failed', errorCode });
      setError(pinErrorMessage(error));
      try {
        await lockSession.getState().refresh();
      } catch {
        /* The session fails closed on storage errors. */
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 16 }}>
      {mode !== 'enable' && (
        <PinField
          label={vi.oldPin}
          value={current}
          onChange={setCurrent}
          disabled={busy}
        />
      )}
      {mode !== 'disable' && (
        <>
          <PinField
            label={vi.newPin}
            value={next}
            onChange={setNext}
            disabled={busy}
          />
          <PinField
            label={vi.confirmPin}
            value={confirmation}
            onChange={setConfirmation}
            disabled={busy}
          />
          <HelperText
            type={confirmation && next !== confirmation ? 'error' : 'info'}
          >
            {confirmation && next !== confirmation
              ? vi.pinMismatch
              : vi.pinHint}
          </HelperText>
        </>
      )}
      <RetryDelay />
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}
      {__DEV__ && (
        <Button
          hitSlop={4}
          disabled={busy}
          contentStyle={styles.button}
          onPress={diagnoseStorage}
        >
          {vi.pinCheckStorage}
        </Button>
      )}
      {!!storageResult && (
        <Text accessibilityLiveRegion="polite">{storageResult}</Text>
      )}
      <Button
        hitSlop={4}
        mode="contained"
        contentStyle={styles.button}
        loading={busy}
        disabled={busy}
        onPress={submit}
      >
        {mode === 'disable' ? vi.pinDisable : vi.pinSave}
      </Button>
      <Button
        hitSlop={4}
        contentStyle={styles.button}
        disabled={busy}
        onPress={requestLeave}
      >
        {vi.cancel}
      </Button>
    </View>
  );
}
