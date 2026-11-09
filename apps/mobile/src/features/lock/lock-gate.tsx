import { type PropsWithChildren, useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Text, useTheme } from 'react-native-paper';
import { DeleteDataControl } from '@/components/delete-data-control';
import { Screen, styles } from '@/components/screen';
import { vi } from '@/messages/vi';
import { useApp } from '@/state/app';
import { lockSession, useLockSession } from './mobile';
import { PinField, pinErrorMessage, RetryDelay } from './pin-controls';

export function LockGate({ children }: PropsWithChildren) {
  const status = useLockSession((state) => state.status);
  const storageError = useLockSession((state) => state.storageError);
  const visible = useLockSession((state) => state.visible);
  const deleting = useApp((state) => state.deleting);
  const deleteFailed = useApp((state) => state.deleteFailed);
  const deleteData = useApp((state) => state.deleteData);
  const { colors } = useTheme();
  useEffect(() => {
    let current = AppState.currentState;
    let focused = true;
    const update = () =>
      lockSession.getState().setVisible(current === 'active' && focused);
    const change = AppState.addEventListener('change', (next) => {
      current = next;
      update();
    });
    const blur =
      Platform.OS === 'android'
        ? AppState.addEventListener('blur', () => {
            focused = false;
            update();
          })
        : undefined;
    const focus =
      Platform.OS === 'android'
        ? AppState.addEventListener('focus', () => {
            focused = true;
            update();
          })
        : undefined;
    update();
    void lockSession.getState().initialize();
    return () => {
      change.remove();
      blur?.remove();
      focus?.remove();
    };
  }, []);

  let content = children;
  if (deleting)
    content = (
      <Screen title={vi.appName}>
        <ActivityIndicator />
        <Text>{vi.deletingData}</Text>
      </Screen>
    );
  else if (deleteFailed)
    content = (
      <Screen title={vi.appName}>
        <Text accessibilityRole="alert">{vi.deleteError}</Text>
        <Button onPress={deleteData}>{vi.retry}</Button>
      </Screen>
    );
  else if (status === 'checking')
    content = (
      <Screen title={vi.appName}>
        <ActivityIndicator />
        <Text>{vi.pinChecking}</Text>
      </Screen>
    );
  else if (status === 'error')
    content = (
      <Screen title={vi.lockTitle}>
        <Text accessibilityRole="alert">{vi[storageError]}</Text>
        <Button
          contentStyle={styles.button}
          onPress={() => lockSession.getState().initialize()}
        >
          {vi.retry}
        </Button>
        {storageError === 'pinStorageError' && (
          <Text>{vi.pinForgotDescription}</Text>
        )}
        <DeleteDataControl />
      </Screen>
    );
  else if (status === 'locked') content = <UnlockScreen />;

  // shortcut: AppState concealment is best effort; add native snapshot protection before release.
  return (
    <View style={styles.fill}>
      <View
        style={[styles.fill, { opacity: visible ? 1 : 0 }]}
        pointerEvents={visible ? 'auto' : 'none'}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      >
        {content}
      </View>
      {!visible && (
        <View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: colors.background },
          ]}
        >
          <Screen title={vi.appName}>
            <Text>{vi.contentHidden}</Text>
          </Screen>
        </View>
      )}
    </View>
  );
}

function UnlockScreen() {
  const busy = useLockSession((state) => state.busy);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [forgotten, setForgotten] = useState(false);
  const { colors } = useTheme();
  async function unlock() {
    setError('');
    try {
      const result = await lockSession.getState().unlock(pin);
      if (result === 'invalid') {
        setError(vi.pinWrong);
        setPin('');
      }
    } catch (error) {
      setError(pinErrorMessage(error));
    }
  }
  return (
    <Screen title={vi.lockTitle}>
      <PinField
        label={vi.pinLabel}
        value={pin}
        onChange={setPin}
        disabled={busy}
      />
      <RetryDelay />
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}
      <Button
        mode="contained"
        contentStyle={styles.button}
        disabled={busy || !pin}
        loading={busy}
        onPress={unlock}
      >
        {busy ? vi.pinWaiting : vi.pinUnlock}
      </Button>
      <Button
        contentStyle={styles.button}
        disabled={busy}
        onPress={() => setForgotten(!forgotten)}
      >
        {vi.pinForgot}
      </Button>
      {forgotten && (
        <>
          <Text>{vi.pinForgotDescription}</Text>
          <DeleteDataControl />
        </>
      )}
    </Screen>
  );
}
