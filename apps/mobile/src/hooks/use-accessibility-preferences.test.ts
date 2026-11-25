import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccessibilityPreferences as readPreferences } from './use-accessibility-preferences';

const harness = vi.hoisted(() => ({
  values: [] as boolean[],
  cursor: 0,
  effect: undefined as undefined | (() => void | (() => void)),
  listeners: {} as Record<string, (value: boolean) => void>,
  transparency: undefined as undefined | ((value: boolean) => void),
  contrast: undefined as undefined | ((value: boolean) => void),
  remove: vi.fn(),
  platform: 'ios',
}));
vi.mock('react', () => ({
  useState: (initial: boolean) => {
    const index = harness.cursor++;
    harness.values[index] ??= initial;
    return [
      harness.values[index],
      (value: boolean) => {
        harness.values[index] = value;
      },
    ];
  },
  useEffect: (effect: typeof harness.effect) => {
    harness.effect = effect;
  },
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return harness.platform;
    },
  },
  AccessibilityInfo: {
    addEventListener: (name: string, callback: (value: boolean) => void) => {
      harness.listeners[name] = callback;
      return { remove: harness.remove };
    },
    isReduceTransparencyEnabled: () =>
      new Promise<boolean>((resolve) => {
        harness.transparency = resolve;
      }),
    isDarkerSystemColorsEnabled: () =>
      new Promise<boolean>((resolve) => {
        harness.contrast = resolve;
      }),
  },
}));

describe('iOS accessibility appearance preferences', () => {
  beforeEach(() => {
    harness.values = [];
    harness.cursor = 0;
    harness.listeners = {};
    harness.remove.mockClear();
    harness.platform = 'ios';
  });
  it('uses a solid surface until preferences load and tracks live iOS contrast changes', async () => {
    expect(readPreferences()).toEqual({
      reduceTransparency: true,
      increaseContrast: false,
    });
    const cleanup = harness.effect!();
    harness.transparency!(false);
    harness.contrast!(false);
    await Promise.resolve();
    expect(harness.values).toEqual([false, false]);
    harness.listeners.reduceTransparencyChanged!(true);
    harness.listeners.darkerSystemColorsChanged!(true);
    expect(harness.values).toEqual([true, true]);
    cleanup!();
    expect(harness.remove).toHaveBeenCalledTimes(2);
  });
  it('does not overwrite a newer system setting with a stale initial response', async () => {
    readPreferences();
    harness.effect!();
    harness.listeners.reduceTransparencyChanged!(true);
    harness.listeners.darkerSystemColorsChanged!(true);
    harness.transparency!(false);
    harness.contrast!(false);
    await Promise.resolve();
    expect(harness.values).toEqual([true, true]);
  });
  it('keeps Android and web free of iOS preference listeners', () => {
    for (const platform of ['android', 'web']) {
      harness.platform = platform;
      harness.cursor = 0;
      harness.values = [];
      expect(readPreferences().reduceTransparency).toBe(false);
      harness.effect!();
      expect(harness.listeners).toEqual({});
    }
  });
});
