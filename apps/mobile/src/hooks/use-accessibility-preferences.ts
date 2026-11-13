import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/** Tracks live iOS appearance preferences and starts with a readable solid surface. */
export function useAccessibilityPreferences() {
  const [reduceTransparency, setReduceTransparency] = useState(
    Platform.OS === 'ios',
  );
  const [increaseContrast, setIncreaseContrast] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let active = true;
    let transparencyChanged = false;
    let contrastChanged = false;
    const transparency = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      (value) => {
        transparencyChanged = true;
        if (active) setReduceTransparency(value);
      },
    );
    const contrast = AccessibilityInfo.addEventListener(
      'darkerSystemColorsChanged',
      (value) => {
        contrastChanged = true;
        if (active) setIncreaseContrast(value);
      },
    );
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => {
        if (active && !transparencyChanged) setReduceTransparency(value);
      })
      .catch(() => {});
    void AccessibilityInfo.isDarkerSystemColorsEnabled()
      .then((value) => {
        if (active && !contrastChanged) setIncreaseContrast(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      transparency.remove();
      contrast.remove();
    };
  }, []);
  return { reduceTransparency, increaseContrast };
}
