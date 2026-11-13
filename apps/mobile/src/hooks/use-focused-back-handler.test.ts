import { describe, expect, it, vi } from 'vitest';
import { useFocusedBackHandler } from './use-focused-back-handler';

const harness = vi.hoisted(() => ({
  focus: undefined as undefined | (() => () => void),
  handlers: [] as (() => boolean)[],
}));
vi.mock('react', () => ({ useCallback: (callback: unknown) => callback }));
vi.mock('expo-router', () => ({
  useFocusEffect: (focus: typeof harness.focus) => {
    harness.focus = focus;
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  BackHandler: {
    addEventListener: (_event: string, callback: () => boolean) => {
      harness.handlers.push(callback);
      return {
        remove: () => {
          harness.handlers = harness.handlers.filter(
            (item) => item !== callback,
          );
        },
      };
    },
  },
}));

describe('Focused hardware back handling', () => {
  it('removes the background listener when another route covers a settings screen', () => {
    const settingsBack = vi.fn(() => true);
    useFocusedBackHandler(settingsBack);
    expect(harness.handlers).toHaveLength(0);
    const blurSettings = harness.focus!();
    harness.handlers[0]!();
    expect(settingsBack).toHaveBeenCalledOnce();
    blurSettings();
    const modalBack = vi.fn(() => true);
    useFocusedBackHandler(modalBack);
    const blurModal = harness.focus!();
    expect(harness.handlers).toHaveLength(1);
    harness.handlers[0]!();
    expect(modalBack).toHaveBeenCalledOnce();
    expect(settingsBack).toHaveBeenCalledOnce();
    blurModal();
    expect(harness.handlers).toHaveLength(0);
  });
});
