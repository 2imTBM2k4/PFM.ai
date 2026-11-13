import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { BackHandler, Platform } from 'react-native';

/** Keeps covered screens from intercepting the foreground route's hardware back action. */
export function useFocusedBackHandler(onBack: () => boolean) {
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return;
      const subscription = BackHandler.addEventListener(
        'hardwareBackPress',
        onBack,
      );
      return () => subscription.remove();
    }, [onBack]),
  );
}
