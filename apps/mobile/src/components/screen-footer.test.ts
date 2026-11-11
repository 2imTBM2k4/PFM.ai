import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Screen } from './screen';

const { effectCallbacks, cleanups, tabBarState } = vi.hoisted(() => ({
  effectCallbacks: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
  tabBarState: {
    isTabBarVisible: true,
    setTabBarVisible: (visible: boolean) => {
      tabBarState.isTabBarVisible = visible;
    },
  },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
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
  Keyboard: { addListener: () => ({ remove: vi.fn() }) },
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
}));

vi.mock('react-native-paper', () => ({
  Icon: 'PaperIcon',
  Text: 'PaperText',
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('@/components/ui/gradient-background', () => ({
  GradientBackground: 'GradientBackground',
}));

vi.mock('@/state/preferences', () => {
  const getState = () => ({
    themeMode: 'light' as const,
    language: 'vi' as const,
    currency: 'VND' as const,
    exchangeRate: 25000,
    isTabBarVisible: tabBarState.isTabBarVisible,
    setTabBarVisible: tabBarState.setTabBarVisible,
  });
  return {
    usePreferences: Object.assign(
      (selector?: (s: ReturnType<typeof getState>) => unknown) =>
        selector ? selector(getState()) : getState(),
      { getState },
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
      visit((element.type as (props: Record<string, unknown>) => ReactNode)(element.props));
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
  beforeEach(() => {
    effectCallbacks.length = 0;
    cleanups.splice(0).forEach((fn) => fn());
    tabBarState.isTabBarVisible = true;
  });

  it('hides FloatingTabBar while a tab long-form footer is mounted and restores it on unmount', () => {
    const footerNode = createElement('SaveButton', { testID: 'sticky-save' });
    const tree = Screen({
      title: 'Thêm ngân sách',
      footer: footerNode,
      children: createElement('FormBody'),
    });

    expect(tabBarState.isTabBarVisible).toBe(false);

    const kav = collectElements(tree, (el) => el.type === 'KeyboardAvoidingView')[0]!;
    const children = kav.props.children as ReactNode[];
    expect(collectElements(children[0], (el) => el.type === 'ScrollView')).toHaveLength(1);
    expect(collectElements(children[1], (el) => el.type === 'SaveButton')).toHaveLength(1);

    cleanups.splice(0).forEach((fn) => fn());
    expect(tabBarState.isTabBarVisible).toBe(true);
  });

  it('does not touch FloatingTabBar when hasTabBar is false (modal form)', () => {
    const footerNode = createElement('SaveButton', { testID: 'sticky-save' });
    Screen({
      title: 'Thêm giao dịch',
      hasTabBar: false,
      footer: footerNode,
      children: createElement('FormBody'),
    });

    expect(tabBarState.isTabBarVisible).toBe(true);
  });
});
