import {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickTile, Screen, getFieldScrollOffset } from './screen';
import { Platform } from 'react-native';
import { usePreferences } from '@/state/preferences';
import { RevealFieldContext } from './field-feedback';

const { effectCallbacks, cleanups, keyboardListeners } = vi.hoisted(() => ({
  effectCallbacks: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
  keyboardListeners: {} as Record<string, (() => void)[]>,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useContext: () => false,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) =>
      getSnapshot(),
    useEffect: (fn: () => void | (() => void)) => {
      effectCallbacks.push(fn);
      const cleanup = fn();
      if (typeof cleanup === 'function') {
        cleanups.push(cleanup);
      }
    },
    useState: (initial: unknown) => [
      typeof initial === 'function' ? (initial as () => unknown)() : initial,
      vi.fn(),
    ],
    useRef: (initial: unknown) => ({ current: initial }),
    useCallback: <T>(fn: T) => fn,
    useMemo: <T>(fn: () => T) => fn(),
  };
});

vi.mock('react-native', () => ({
  Keyboard: {
    addListener: (event: string, callback: () => void) => {
      (keyboardListeners[event] ??= []).push(callback);
      return {
        remove: () => {
          keyboardListeners[event] =
            keyboardListeners[event]?.filter(
              (listener) => listener !== callback,
            ) ?? [];
        },
      };
    },
  },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: {
    OS: 'ios',
    select: <T>(obj: Record<string, T>): T => obj.ios ?? obj.default!,
  },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: {
    create: <T extends Record<string, unknown>>(s: T): T => s,
  },
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
  LinearTransition: { duration: () => ({}) },
  useReducedMotion: () => false,
}));

vi.mock('react-native-paper', () => ({
  Icon: 'PaperIcon',
  Text: 'PaperText',
}));
vi.mock('expo-symbols', () => ({ SymbolView: 'SymbolView' }));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('@/components/ui/gradient-background', () => ({
  GradientBackground: 'GradientBackground',
}));

vi.mock('@/data/connection', () => ({ withDatabase: vi.fn() }));
vi.mock('@/data/seed-data', () => ({
  applyDevSeedData: vi.fn(),
  removeDevSeedData: vi.fn(),
}));
vi.mock('@/state/preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state/preferences')>();
  return {
    ...actual,
    usePreferences: Object.assign(
      (
        selector: (
          state: ReturnType<typeof actual.usePreferences.getState>,
        ) => unknown,
      ) => selector(actual.usePreferences.getState()),
      {
        getState: actual.usePreferences.getState,
        setState: actual.usePreferences.setState,
      },
    ),
  };
});

function collectElements(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  const matches: ReactElement<Record<string, unknown>>[] = [];
  function visit(current: ReactNode) {
    if (!current) return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isValidElement(current)) return;
    const element = current as ReactElement<Record<string, unknown>>;
    if (typeof element.type === 'function') {
      visit(
        (element.type as (props: Record<string, unknown>) => ReactNode)(
          element.props,
        ),
      );
      return;
    }
    if (predicate(element)) {
      matches.push(element);
    }
    const props = element.props as Record<string, unknown> | undefined;
    if (props && 'children' in props) {
      visit(props.children as ReactNode);
    }
  }
  visit(node);
  return matches;
}

describe('Screen sticky footer and tab bar clearance (D3 / 3-PA1)', () => {
  it('positions focused notes above the keyboard, including tall multiline notes', () => {
    expect(getFieldScrollOffset(420, 100, 300)).toBe(404);
    expect(getFieldScrollOffset(420, 400, 300)).toBe(536);
    expect(getFieldScrollOffset(0, 100, 300)).toBe(0);
    expect(getFieldScrollOffset(420, 100, 0)).toBe(404);
  });

  it.each([false, true])(
    'reveals focused notes after keyboard resize in modal=%s',
    (inModal) => {
      const tree = Screen({
        title: 'Form',
        inModal,
        footer: createElement('SaveButton'),
      });
      const scroll = collectElements(
        tree,
        (element) => element.type === 'ScrollView',
      )[0]!;
      const content = collectElements(
        tree,
        (element) =>
          element.type === 'Animated.View' && Boolean(element.props.ref),
      )[0]!;
      const provider = collectElements(
        tree,
        (element) => element.type === RevealFieldContext.Provider,
      )[0]!;
      const scrollTo = vi.fn();
      (scroll.props.ref as { current: unknown }).current = { scrollTo };
      (content.props.ref as { current: unknown }).current = {};
      const reveal = provider.props.value as (target: object | null) => void;
      const target = {
        measureLayout: (
          _relative: unknown,
          success: (...values: number[]) => void,
        ) => success(0, 420, 300, 400),
      };
      (scroll.props.onLayout as (event: unknown) => void)({
        nativeEvent: { layout: { height: 600 } },
      });
      reveal(target);
      expect(scrollTo).toHaveBeenLastCalledWith({ y: 404, animated: true });
      (scroll.props.onLayout as (event: unknown) => void)({
        nativeEvent: { layout: { height: 300 } },
      });
      expect(scrollTo).toHaveBeenLastCalledWith({ y: 536, animated: true });
      scrollTo.mockClear();
      keyboardListeners.keyboardDidShow?.forEach((listener) => listener());
      expect(scrollTo).toHaveBeenCalledWith({ y: 536, animated: true });
      reveal(null);
      scrollTo.mockClear();
      keyboardListeners.keyboardDidShow?.forEach((listener) => listener());
      expect(scrollTo).not.toHaveBeenCalled();
    },
  );
  beforeEach(() => {
    (Platform as { OS: string }).OS = 'ios';
    effectCallbacks.length = 0;
    cleanups.splice(0).forEach((fn) => fn());
    usePreferences.setState({ isTabBarVisible: true, tabBarHideCount: 0 });
  });

  it.each(['ios', 'android', 'web'])(
    'keeps collapsed quick actions accessible and functional on %s',
    (platform) => {
      (Platform as { OS: string }).OS = platform;
      const onPress = vi.fn();
      const tree = QuickTile({
        icon: 'calendar-sync-outline',
        label: 'Recurring',
        bg: '#eee',
        fg: '#111',
        compact: true,
        onPress,
      });
      const button = collectElements(
        tree,
        (element) => element.type === 'Pressable',
      )[0]!;
      expect(button.props.accessibilityLabel).toBe('Recurring');
      const buttonStyle = (
        button.props.style as (state: { pressed: boolean }) => object[]
      )({ pressed: false });
      expect(Object.assign({}, ...buttonStyle)).toMatchObject({
        width: 44,
        height: 44,
      });
      expect(button.props.hitSlop).toBe(6);
      expect(
        collectElements(tree, (element) => element.type === 'PaperText'),
      ).toHaveLength(0);
      expect(
        collectElements(
          tree,
          (element) =>
            element.type === (platform === 'ios' ? 'SymbolView' : 'PaperIcon'),
        ),
      ).toHaveLength(1);
      (button.props.onPress as () => void)();
      expect(onPress).toHaveBeenCalledOnce();
      const expanded = QuickTile({
        icon: 'calendar-sync-outline',
        label: 'Recurring',
        bg: '#eee',
        fg: '#111',
        compact: false,
        onPress,
      });
      expect(
        collectElements(expanded, (element) => element.type === 'PaperText'),
      ).toHaveLength(1);
    },
  );

  it('hides FloatingTabBar while a tab long-form footer is mounted and restores it on unmount', () => {
    const footerNode = createElement('SaveButton', { testID: 'sticky-save' });
    const tree = Screen({
      title: 'Thêm ngân sách',
      footer: footerNode,
      children: createElement('FormBody'),
    });

    expect(usePreferences.getState().isTabBarVisible).toBe(false);

    usePreferences.getState().setTabBarVisible(true);
    expect(usePreferences.getState().isTabBarVisible).toBe(false);

    const kav = collectElements(
      tree,
      (el) => el.type === 'KeyboardAvoidingView',
    )[0]!;
    const children = kav.props.children as ReactNode[];
    expect(
      collectElements(children[0], (el) => el.type === 'ScrollView'),
    ).toHaveLength(1);
    expect(
      collectElements(children[1], (el) => el.type === 'SaveButton'),
    ).toHaveLength(1);

    cleanups.splice(0).forEach((fn) => fn());
    expect(usePreferences.getState().isTabBarVisible).toBe(true);
  });

  it('does not touch FloatingTabBar when hasTabBar is false (modal form)', () => {
    const footerNode = createElement('SaveButton', { testID: 'sticky-save' });
    Screen({
      title: 'Thêm giao dịch',
      hasTabBar: false,
      footer: footerNode,
      children: createElement('FormBody'),
    });

    expect(usePreferences.getState().isTabBarVisible).toBe(true);
  });
});
