import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_TAB_ITEMS,
  CustomBottomTabBar,
  type ExpoBottomTabBarProps,
} from '@/components/app-tabs';
import {
  FloatingTabBarView,
  TabIconButton,
} from '@/components/ui/floating-tab-bar';
import { vi as viMessages } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';

const mockNavigate = vi.fn();

vi.mock('@/data/connection', () => ({
  withDatabase: async () => undefined,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Text: 'Text',
  Platform: {
    OS: 'ios',
    select: <T>(obj: Record<string, T>): T => obj.ios ?? obj.default!,
  },
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
  },
}));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: 'MaterialCommunityIcons',
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: 'Animated.View',
  },
  useSharedValue: (initial: number) => ({
    value: initial,
    set: vi.fn(),
  }),
  useAnimatedStyle: (updater: () => Record<string, unknown>) => updater(),
  withSpring: (target: number) => target,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

vi.mock('@/constants/theme', async () => {
  const tokens = await import('@/constants/design-tokens');
  return {
    DesignColors: tokens.DesignColors,
    DesignRadius: tokens.DesignRadius,
    DesignSpacing: tokens.DesignSpacing,
    createSoftShadow: tokens.createSoftShadow,
    useDesignTheme: () => tokens.DesignColors.light,
  };
});

vi.mock('expo-router', () => {
  const TabsComponent = ({ children }: { children?: ReactNode }) => children;
  TabsComponent.Screen = 'Tabs.Screen';
  return {
    Tabs: TabsComponent,
    useRouter: () => ({
      navigate: mockNavigate,
    }),
  };
});

/**
 * Recursively expands custom function components in a React element tree so tests can
 * inspect rendered Pressables, accessibility props, and icons in a pure Node environment.
 */
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
    const elementType = element.type as unknown;

    // Unwrap React.memo or function components
    if (typeof elementType === 'function') {
      const rendered = (
        elementType as (props: Record<string, unknown>) => ReactNode
      )(element.props);
      visit(rendered);
      return;
    }
    if (
      typeof elementType === 'object' &&
      elementType !== null &&
      'type' in elementType &&
      typeof (elementType as { type: unknown }).type === 'function'
    ) {
      const rendered = (
        elementType as { type: (props: Record<string, unknown>) => ReactNode }
      ).type(element.props);
      visit(rendered);
      return;
    }

    if (predicate(element)) {
      matches.push(element);
    }

    if (element.props && 'children' in element.props) {
      visit(element.props.children as ReactNode);
    }
  }

  visit(node);
  return matches;
}

function makeMockBottomTabBarProps(
  activeIndex: number,
  overrides?: Partial<ExpoBottomTabBarProps>,
): {
  props: ExpoBottomTabBarProps;
  emitSpy: ReturnType<typeof vi.fn>;
  navigateToTabSpy: ReturnType<typeof vi.fn>;
} {
  const routes = [
    { key: 'index-key', name: 'index' },
    { key: 'budgets-key', name: 'budgets' },
    { key: 'chat-key', name: 'chat' },
    { key: 'transactions-key', name: 'transactions' },
    { key: 'settings-key', name: 'settings' },
  ];
  const emitSpy = vi.fn(() => ({ defaultPrevented: false }));
  const navigateToTabSpy = vi.fn();

  const props = {
    state: {
      index: activeIndex,
      routes,
    },
    descriptors: {},
    emitter: {
      emit: emitSpy,
    },
    navigateToTab: navigateToTabSpy,
    insets: { top: 47, right: 0, bottom: 34, left: 0 },
    ...overrides,
  } as unknown as ExpoBottomTabBarProps;

  return { props, emitSpy, navigateToTabSpy };
}

describe('FloatingTabBar & CustomBottomTabBar (Group 1 & Group 2)', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    usePreferences.setState({ pendingTransactionEntry: null });
  });

  it('renders all 5 tabs with Vietnamese accessibility labels and marks only the active tab as selected', () => {
    const onSelect = vi.fn();
    const onAddPress = vi.fn();

    const tree = FloatingTabBarView({
      items: APP_TAB_ITEMS,
      activeKey: 'budgets',
      onSelect,
      onAddPress,
      bottomInset: 34,
    });

    const tabButtons = collectElements(
      tree,
      (el) => el.props.accessibilityRole === 'tab',
    );

    expect(tabButtons).toHaveLength(5);
    for (const button of tabButtons) {
      const style = Object.assign(
        {},
        ...(button.props.style as (Record<string, unknown> | false)[]).filter(
          Boolean,
        ),
      );
      expect(style.width).toBeGreaterThanOrEqual(44);
      expect(style.height).toBeGreaterThanOrEqual(44);
    }
    expect(tabButtons.map((btn) => btn.props.accessibilityLabel)).toEqual([
      viMessages.overview,
      viMessages.statsTabTitle,
      viMessages.chat,
      viMessages.transactions,
      viMessages.settings,
    ]);

    const selectedStates = tabButtons.map(
      (btn) =>
        (btn.props.accessibilityState as { selected?: boolean })?.selected,
    );
    expect(selectedStates).toEqual([false, true, false, false, false]);

    // Verify active tab uses activeIcon ('chart-box') while inactive tabs use outline icons
    const activeTabIcon = collectElements(
      TabIconButton({
        item: APP_TAB_ITEMS[1]!,
        active: true,
        onPress: () => {},
      }),
      (el) => el.type === 'MaterialCommunityIcons',
    )[0];
    const inactiveTabIcon = collectElements(
      TabIconButton({
        item: APP_TAB_ITEMS[1]!,
        active: false,
        onPress: () => {},
      }),
      (el) => el.type === 'MaterialCommunityIcons',
    )[0];

    expect(activeTabIcon?.props.name).toBe('chart-box');
    expect(inactiveTabIcon?.props.name).toBe('chart-box-outline');
  });

  it('invokes navigateToTab when pressing an inactive tab and requestAddTransaction("manual") when pressing "+"', () => {
    const { props, emitSpy, navigateToTabSpy } = makeMockBottomTabBarProps(0);
    const tree = CustomBottomTabBar(props);

    expect(tree).not.toBeNull();

    const tabButtons = collectElements(
      tree,
      (el) => el.props.accessibilityRole === 'tab',
    );
    expect(tabButtons).toHaveLength(5);

    // Press the 4th tab ('transactions')
    const transactionsTab = tabButtons[3]!;
    (transactionsTab.props.onPress as () => void)();

    expect(emitSpy).toHaveBeenCalledWith({
      type: 'tabPress',
      target: 'transactions-key',
      canPreventDefault: true,
    });
    expect(navigateToTabSpy).toHaveBeenCalledWith('transactions-key');

    // Press the separate circular '+' button
    const addButtons = collectElements(
      tree,
      (el) =>
        el.props.accessibilityRole === 'button' &&
        el.props.accessibilityLabel === viMessages.addTransaction,
    );
    expect(addButtons).toHaveLength(1);

    (addButtons[0]!.props.onPress as () => void)();
    expect(usePreferences.getState().pendingTransactionEntry).toBe('manual');
    expect(navigateToTabSpy).toHaveBeenLastCalledWith('transactions-key');
  });

  it('hides the FloatingTabBar when the active route is "chat" (Option 1.B)', () => {
    const { props } = makeMockBottomTabBarProps(2); // index 2 = 'chat'
    const tree = CustomBottomTabBar(props);
    expect(tree).toBeNull();
  });
});
