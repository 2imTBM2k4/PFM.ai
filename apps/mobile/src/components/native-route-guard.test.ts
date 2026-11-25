import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeRouteGuard } from './native-route-guard';
import {
  getBlockingGuard,
  registerUnsavedGuard,
  resetUnsavedGuards,
} from '@/utils/unsaved-changes';

const mocks = vi.hoisted(() => ({
  callback: undefined as undefined | ((event: { repeat(): void }) => void),
  confirm: undefined as undefined | (() => void),
  prevent: false,
}));
vi.mock('react', () => ({
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));
vi.mock('expo-router', () => ({
  usePreventRemove: (prevent: boolean, callback: typeof mocks.callback) => {
    mocks.prevent = prevent;
    mocks.callback = callback;
  },
}));
vi.mock('@/utils/unsaved-changes', async (original) => ({
  ...(await original<object>()),
  promptDiscardChanges: (confirm: () => void) => {
    mocks.confirm = confirm;
  },
}));
vi.mock('react-native', () => ({
  Alert: {},
  Platform: { OS: 'ios' },
  View: 'View',
}));
vi.mock('react-native-paper', () => ({
  TextInput: 'TextInput',
  HelperText: 'HelperText',
}));
vi.mock('@/state/preferences', () => ({ usePreferences: () => 'vi' }));

describe('Native route draft protection', () => {
  beforeEach(() => {
    resetUnsavedGuards();
    mocks.confirm = undefined;
  });
  it('allows clean dismissal and ignores drafts belonging to another destination', () => {
    registerUnsavedGuard({
      id: 'other',
      scope: 'tab',
      routeKey: 'settings',
      dirty: true,
      saving: false,
      saved: false,
      onDiscard: vi.fn(),
    });
    NativeRouteGuard({ scope: 'modal' });
    expect(mocks.prevent).toBe(false);
  });
  it('keeps a dirty sheet open until discard is confirmed, then repeats navigation once', () => {
    const onDiscard = vi.fn();
    registerUnsavedGuard({
      id: 'draft',
      scope: 'modal',
      dirty: true,
      saving: false,
      saved: false,
      onDiscard,
    });
    NativeRouteGuard({ scope: 'modal' });
    expect(mocks.prevent).toBe(true);
    const repeat = vi.fn();
    mocks.callback!({ repeat });
    expect(repeat).not.toHaveBeenCalled();
    expect(getBlockingGuard('modal')).toBeDefined();
    mocks.confirm!();
    expect(getBlockingGuard('modal')).toBeUndefined();
    expect(repeat).toHaveBeenCalledOnce();
    // Discarding an entire route unmounts its draft; onDiscard may itself navigate.
    expect(onDiscard).not.toHaveBeenCalled();
  });
  it('blocks dismissal while a database save is in progress without offering discard', () => {
    registerUnsavedGuard({
      id: 'saving',
      scope: 'modal',
      dirty: true,
      saving: true,
      saved: false,
      onDiscard: vi.fn(),
    });
    NativeRouteGuard({ scope: 'modal' });
    const repeat = vi.fn();
    mocks.callback!({ repeat });
    expect(repeat).not.toHaveBeenCalled();
    expect(mocks.confirm).toBeUndefined();
  });
});
