import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Alert } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_TAB_ITEMS,
  CustomBottomTabBar,
  type ExpoBottomTabBarProps,
} from '@/components/app-tabs';
import {
  FloatingTabBarView,
  getFloatingTabBarLayout,
  TabIconButton,
} from '@/components/ui/floating-tab-bar';
import { vi as viMessages } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';

const mockNavigate = vi.fn();
const { mockWindowDimensions } = vi.hoisted(() => ({
  mockWindowDimensions: { width: 390, height: 844 },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useEffect: (effect: () => void) => effect(),
    useState: <T>(initial: T) => [initial, vi.fn()],
  };
});

vi.mock('@/data/connection', () => ({
  withDatabase: async () => undefined,
}));

vi.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: vi.fn().mockResolvedValue({ granted: true }),
  requestMediaLibraryPermissionsAsync: vi
    .fn()
    .mockResolvedValue({ granted: true }),
  launchCameraAsync: vi
    .fn()
    .mockResolvedValue({ canceled: false, assets: [{ uri: 'file://receipt.jpg' }] }),
  launchImageLibraryAsync: vi
    .fn()
    .mockResolvedValue({ canceled: false, assets: [{ uri: 'file://receipt.jpg' }] }),
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Text: 'Text',
  Alert: { alert: vi.fn() },
  Platform: {
    OS: 'ios',
    select: <T>(obj: Record<string, T>): T => obj.ios ?? obj.default!,
  },
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
  },
  useWindowDimensions: () => mockWindowDimensions,
}));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: 'MaterialCommunityIcons',
}));

vi.mock('react-native-reanimated', () => ({
  Extrapolation: { CLAMP: 'clamp' },
  default: {
    View: 'Animated.View',
  },
  interpolate: (
    value: number,
    input: readonly number[],
    output: readonly number[],
  ) => (value <= input[0]! ? output[0] : output[output.length - 1]),
  useSharedValue: (initial: number) => ({
    value: initial,
    set: vi.fn(),
  }),
  useAnimatedStyle: (updater: () => Record<string, unknown>) => updater(),
  useReducedMotion: () => false,
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
    mockWindowDimensions.width = 390;
    mockWindowDimensions.height = 844;
    usePreferences.setState({
      pendingTransactionEntry: null,
      pendingChatAction: null,
    });
  });

  it('renders 4 primary tabs with Vietnamese accessibility labels and marks only the active tab as selected', () => {
    const onSelect = vi.fn();
    const onActionSelect = vi.fn();

    const tree = FloatingTabBarView({
      items: APP_TAB_ITEMS,
      activeKey: 'budgets',
      onSelect,
      onActionSelect,
      bottomInset: 34,
    });

    const tabButtons = collectElements(
      tree,
      (el) => el.props.accessibilityRole === 'tab',
    );

    expect(tabButtons).toHaveLength(4);
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
      viMessages.budgetsTabTitle,
      viMessages.transactions,
      viMessages.settings,
    ]);

    const selectedStates = tabButtons.map(
      (btn) =>
        (btn.props.accessibilityState as { selected?: boolean })?.selected,
    );
    expect(selectedStates).toEqual([false, true, false, false]);

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

  it('fits compact iPhones and caps the navigation width on expanded displays', () => {
    const compact = getFloatingTabBarLayout(320);
    expect(compact.compact).toBe(true);
    expect(compact.rowWidth).toBeLessThanOrEqual(300);
    expect(compact.inactiveTabWidth).toBeGreaterThanOrEqual(44);
    expect(compact.showActiveLabel).toBe(false);

    const standard = getFloatingTabBarLayout(390);
    expect(standard.compact).toBe(false);
    expect(standard.showActiveLabel).toBe(true);
    expect(standard.activeTabWidth).toBeGreaterThan(standard.inactiveTabWidth);

    const expanded = getFloatingTabBarLayout(900, 24, 24);
    expect(expanded.rowWidth).toBe(468);
  });

  it('navigates primary tabs and routes all three "+" menu actions', () => {
    const { props, emitSpy, navigateToTabSpy } = makeMockBottomTabBarProps(0);
    const tree = CustomBottomTabBar(props);

    expect(tree).not.toBeNull();

    const tabButtons = collectElements(
      tree,
      (el) => el.props.accessibilityRole === 'tab',
    );
    expect(tabButtons).toHaveLength(4);

    // Press the 3rd primary tab ('transactions')
    const transactionsTab = tabButtons[2]!;
    (transactionsTab.props.onPress as () => void)();

    expect(emitSpy).toHaveBeenCalledWith({
      type: 'tabPress',
      target: 'transactions-key',
      canPreventDefault: true,
    });
    expect(navigateToTabSpy).toHaveBeenCalledWith('transactions-key');

    // The separate '+' button exposes all three actions.
    const addButtons = collectElements(
      tree,
      (el) =>
        el.props.accessibilityRole === 'button' &&
        el.props.accessibilityLabel === viMessages.quickAddMenu,
    );
    expect(addButtons).toHaveLength(1);

    const manualAction = collectElements(
      tree,
      (el) => el.props.accessibilityLabel === viMessages.quickAddManual,
    )[0]!;
    (manualAction.props.onPress as () => void)();
    expect(usePreferences.getState().isAddTransactionOpen).toBe(true);

    const cameraAction = collectElements(
      tree,
      (el) => el.props.accessibilityLabel === viMessages.quickAddCamera,
    )[0]!;
    (cameraAction.props.onPress as () => void)();
    expect(Alert.alert).toHaveBeenCalledWith(
      viMessages.receiptScan,
      viMessages.receiptChooseSource,
      expect.any(Array),
    );

    const chatAction = collectElements(
      tree,
      (el) => el.props.accessibilityLabel === viMessages.quickAddAI,
    )[0]!;
    (chatAction.props.onPress as () => void)();
    expect(usePreferences.getState().isChatOpen).toBe(true);
  });

  it('hides navigation in regular iPhone Chat and keeps the closed Duo rail', () => {
    const { props } = makeMockBottomTabBarProps(2); // index 2 = 'chat'

    expect(CustomBottomTabBar(props)).toBeNull();

    mockWindowDimensions.width = 540;
    mockWindowDimensions.height = 720;
    expect(CustomBottomTabBar(props)).not.toBeNull();
  });
});
