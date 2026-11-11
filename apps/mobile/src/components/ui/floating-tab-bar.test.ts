import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Alert, Platform } from 'react-native';
import { setActiveLanguage } from '@/messages/language';
import { DesignColors, createSoftShadow } from '@/constants/design-tokens';
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
const { mockWindowDimensions, mockState } = vi.hoisted(() => ({
  mockWindowDimensions: { width: 390, height: 844 },
  mockState: {
    glass: true,
    mode: 'light' as 'light' | 'dark',
    menuOpen: false,
    reducedMotion: false,
  },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useEffect: (effect: () => void) => effect(),
    useState: (initial: boolean | (() => boolean)) =>
      typeof initial === 'function'
        ? [initial(), vi.fn()]
        : [
            mockState.menuOpen,
            (value: boolean | ((open: boolean) => boolean)) => {
              mockState.menuOpen =
                typeof value === 'function' ? value(mockState.menuOpen) : value;
            },
          ],
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
  launchCameraAsync: vi.fn().mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file://receipt.jpg' }],
  }),
  launchImageLibraryAsync: vi.fn().mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file://receipt.jpg' }],
  }),
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
    absoluteFill: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
  },
  useWindowDimensions: () => mockWindowDimensions,
}));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: 'MaterialCommunityIcons',
}));

vi.mock('expo-glass-effect', () => ({
  GlassView: 'GlassView',
  isLiquidGlassAvailable: () => mockState.glass,
}));

vi.mock('expo-symbols', () => ({ SymbolView: 'SymbolView' }));

vi.mock('@expo/ui/swift-ui', () => ({
  Host: 'SwiftUI.Host',
  Menu: 'SwiftUI.Menu',
  Button: 'SwiftUI.Button',
  Image: 'SwiftUI.Image',
}));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: (value: string) => ({
    type: 'accessibilityLabel',
    value,
  }),
  buttonStyle: (value: string) => ({ type: 'buttonStyle', value }),
  contentShape: (value: unknown) => ({ type: 'contentShape', value }),
  frame: (value: unknown) => ({ type: 'frame', value }),
  menuIndicator: (value: string) => ({ type: 'menuIndicator', value }),
  menuOrder: (value: string) => ({ type: 'menuOrder', value }),
  menuStyle: (value: string) => ({ type: 'menuStyle', value }),
  shapes: { circle: () => ({ shape: 'circle' }) },
}));
vi.mock('react-native-paper', async () => {
  const { createElement } = await import('react');
  const Menu = Object.assign(
    (props: Record<string, unknown>) => createElement('PaperMenu', props),
    { Item: 'PaperMenu.Item' },
  );
  return { Menu };
});
// Vitest does not resolve platform suffixes; run the actual implementation for each platform.
vi.mock('@/components/ui/quick-action-menu', async (importOriginal) => {
  const fallback = await importOriginal<typeof import('./quick-action-menu')>();
  const native = await import('./quick-action-menu.ios');
  return {
    QuickActionMenu: (props: Parameters<typeof fallback.QuickActionMenu>[0]) =>
      Platform.OS === 'ios'
        ? native.QuickActionMenu(props)
        : fallback.QuickActionMenu(props),
  };
});

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
    set(value: number) {
      this.value = value;
    },
  }),
  useAnimatedStyle: (updater: () => Record<string, unknown>) => updater(),
  useReducedMotion: () => mockState.reducedMotion,
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
    useDesignTheme: () => tokens.DesignColors[mockState.mode],
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
      visit(element.props.anchor as ReactNode);
      visit(element.props.label as ReactNode);
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

function flattenStyle(element: ReactElement<Record<string, unknown>>) {
  return Object.assign(
    {},
    ...([element.props.style].flat(Infinity).filter(Boolean) as Record<
      string,
      unknown
    >[]),
  );
}

function renderBar(visible = true) {
  return FloatingTabBarView({
    items: APP_TAB_ITEMS,
    activeKey: 'index',
    onSelect: vi.fn(),
    onActionSelect: vi.fn(),
    visible,
  });
}

describe('FloatingTabBar & CustomBottomTabBar (Group 1 & Group 2)', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    setActiveLanguage('vi');
    Platform.OS = 'ios';
    Object.assign(mockState, {
      glass: true,
      mode: 'light',
      menuOpen: false,
      reducedMotion: false,
    });
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

    // Verify iOS uses the selected and unselected SF Symbols.
    const activeTabIcon = collectElements(
      TabIconButton({
        item: APP_TAB_ITEMS[1]!,
        active: true,
        onPress: () => {},
      }),
      (el) => el.type === 'SymbolView',
    )[0];
    const inactiveTabIcon = collectElements(
      TabIconButton({
        item: APP_TAB_ITEMS[1]!,
        active: false,
        onPress: () => {},
      }),
      (el) => el.type === 'SymbolView',
    )[0];

    expect(activeTabIcon?.props.name).toBe('chart.bar.fill');
    expect(inactiveTabIcon?.props.name).toBe('chart.bar');
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

  for (const mode of ['light', 'dark'] as const) {
    for (const platform of ['ios', 'android', 'web'] as const) {
      for (const glass of platform === 'ios' ? [true, false] : [false]) {
        it(`${platform}, ${mode}, glass=${glass}: preserves the appropriate bar surface and icons`, () => {
          Platform.OS = platform;
          Object.assign(mockState, { mode, glass });
          const tree = renderBar();
          const bar = collectElements(
            tree,
            (el) => el.props.accessibilityRole === 'tablist',
          )[0]!;
          const style = flattenStyle(bar);
          const action = collectElements(
            tree,
            (el) => el.props.testID === 'floating-tab-action',
          )[0]!;
          const actionGlass = collectElements(
            action,
            (el) => el.type === 'GlassView',
          )[0]!;
          const actionStyle = flattenStyle(actionGlass);
          expect(actionGlass.props.glassEffectStyle).toBe('clear');
          expect(actionGlass.props.colorScheme).toBe(mode);
          expect(actionGlass.props.tintColor).toBeUndefined();
          expect(actionStyle.borderRadius).toBe(24);
          expect(actionStyle).not.toHaveProperty('shadowColor');
          expect(actionStyle).not.toHaveProperty('opacity');
          if (glass) {
            expect(actionStyle).not.toHaveProperty('backgroundColor');
            expect(actionStyle).not.toHaveProperty('borderColor');
          } else {
            expect(actionStyle).toMatchObject({
              backgroundColor: DesignColors[mode].tabBar.pillBackground,
              borderColor: DesignColors[mode].tabBar.pillBorder,
              borderWidth: 1,
            });
          }
          if (platform === 'ios') {
            const menu = collectElements(
              action,
              (el) => el.type === 'SwiftUI.Menu',
            )[0]!;
            expect(
              (menu.props.label as ReactElement<Record<string, unknown>>).props
                .color,
            ).toBe(DesignColors[mode].text.primary);
          } else {
            const icon = collectElements(
              action,
              (el) => el.type === 'MaterialCommunityIcons',
            )[0]!;
            expect(icon.props.color).toBe(DesignColors[mode].text.primary);
          }
          expect(bar.props.isInteractive).toBe(true);
          expect(bar.props.colorScheme).toBe(mode);
          if (glass) {
            for (const key of [
              'backgroundColor',
              'borderColor',
              'borderWidth',
              'shadowColor',
              'shadowOpacity',
              'boxShadow',
              'elevation',
            ]) {
              expect(style).not.toHaveProperty(key);
            }
          } else {
            expect(style).toMatchObject({
              backgroundColor: DesignColors[mode].tabBar.pillBackground,
              borderColor: DesignColors[mode].tabBar.pillBorder,
              borderWidth: 1,
              ...createSoftShadow(mode, 'lg'),
            });
          }
          if (platform === 'web')
            expect(style.backdropFilter).toBe('blur(28px) saturate(190%)');
          const symbols = [
            ['house', 'house.fill'],
            ['chart.bar', 'chart.bar.fill'],
            ['wallet.bifold', 'wallet.bifold.fill'],
            ['gearshape', 'gearshape.fill'],
          ];
          APP_TAB_ITEMS.forEach((item, index) => {
            for (const active of [false, true]) {
              const icon = collectElements(
                TabIconButton({ item, active, onPress: vi.fn() }),
                (el) =>
                  el.type ===
                  (platform === 'ios'
                    ? 'SymbolView'
                    : 'MaterialCommunityIcons'),
              )[0]!;
              expect(icon.props.name).toBe(
                platform === 'ios'
                  ? symbols[index]![active ? 1 : 0]
                  : active
                    ? item.activeIcon
                    : item.icon,
              );
              expect(
                icon.props[platform === 'ios' ? 'tintColor' : 'color'],
              ).toBe(
                active
                  ? DesignColors[mode].tabBar.activeIcon
                  : DesignColors[mode].tabBar.inactiveIcon,
              );
            }
          });
        });
      }
    }
  }

  for (const duo of [false, true]) {
    for (const reducedMotion of [false, true]) {
      it(`hides and shows using only vertical translation, Duo=${duo}, reduced motion=${reducedMotion}`, () => {
        mockState.reducedMotion = reducedMotion;
        if (duo)
          Object.assign(mockWindowDimensions, { width: 540, height: 720 });
        for (const visible of [true, false, true]) {
          const tree = renderBar(visible);
          const row = tree.props.children as ReactElement<
            Record<string, unknown>
          >;
          expect(flattenStyle(tree).alignItems).toBe('center');
          expect(flattenStyle(row)).toMatchObject({
            flexDirection: duo ? 'column' : 'row',
            alignItems: 'center',
            justifyContent: 'center',
          });
          const rowChildren = row.props.children as ReactElement<
            Record<string, unknown>
          >[];
          expect(rowChildren).toHaveLength(2);
          expect(rowChildren[1]!.props.testID).toBe('floating-tab-action');
          if (duo)
            expect(flattenStyle(rowChildren[0]!).overflow).toBe('hidden');
          const pill = collectElements(
            tree,
            (el) => el.props.testID === 'floating-tab-pill',
          )[0]!;
          const action = collectElements(
            tree,
            (el) => el.props.testID === 'floating-tab-action',
          )[0]!;
          expect(flattenStyle(tree)).not.toHaveProperty('transform');
          expect(flattenStyle(action)).not.toHaveProperty('transform');
          expect(tree.props.pointerEvents).toBe('box-none');
          expect(
            collectElements(action, (el) => el.type === 'SwiftUI.Menu'),
          ).toHaveLength(1);
          expect(
            collectElements(pill, (el) => el.type === 'SwiftUI.Menu'),
          ).toHaveLength(0);
          const style = flattenStyle(pill);
          expect(style).not.toHaveProperty('opacity');
          expect(style.transform).toHaveLength(1);
          const translation = (style.transform as { translateY: number }[])[0]!
            .translateY;
          if (visible) expect(translation).toBe(0);
          else expect(translation).toBeGreaterThan(duo ? 270 : 64);
          expect(pill.props.pointerEvents).toBe(visible ? 'auto' : 'none');
          expect(pill.props.accessibilityElementsHidden).toBe(!visible);
          const bar = collectElements(
            tree,
            (el) => el.props.accessibilityRole === 'tablist',
          )[0]!;
          expect(flattenStyle(bar).flexDirection).toBe(duo ? 'column' : 'row');
          const controls = collectElements(
            bar,
            (el) => el.type === 'Pressable',
          );
          expect(controls.map((el) => el.props.accessibilityRole)).toEqual([
            'tab',
            'tab',
            'tab',
            'tab',
          ]);
          for (const animated of collectElements(
            tree,
            (el) => el.type === 'Animated.View',
          ))
            expect(flattenStyle(animated)).not.toHaveProperty('opacity');
        }
      });
    }
  }

  it('uses an icon-only native single-tap menu with localized actions and a full circular hit area', () => {
    for (const language of ['vi', 'en'] as const) {
      setActiveLanguage(language);
      const onActionSelect = vi.fn();
      const tree = FloatingTabBarView({
        items: APP_TAB_ITEMS,
        activeKey: 'index',
        visible: false,
        onSelect: vi.fn(),
        onActionSelect,
      });
      const menu = collectElements(
        tree,
        (el) => el.type === 'SwiftUI.Menu',
      )[0]!;
      expect(menu.props.onPrimaryAction).toBeUndefined();
      expect(menu.props.modifiers).toEqual(
        expect.arrayContaining([
          { type: 'accessibilityLabel', value: viMessages.addTransaction },
          { type: 'buttonStyle', value: 'plain' },
          { type: 'menuIndicator', value: 'hidden' },
        ]),
      );
      const icon = menu.props.label as ReactElement<Record<string, unknown>>;
      expect(icon.props.systemName).toBe('plus');
      expect(icon.props.color).toBe(DesignColors.light.text.primary);
      expect(icon.props.modifiers).toEqual([
        { type: 'frame', value: { width: 48, height: 48 } },
        { type: 'contentShape', value: { shape: 'circle' } },
      ]);
      const actions = collectElements(
        menu,
        (el) => el.type === 'SwiftUI.Button',
      );
      expect(actions.map((el) => el.props.label)).toEqual([
        viMessages.quickAddManual,
        viMessages.quickAddCamera,
        viMessages.quickAddAI,
      ]);
      expect(actions.map((el) => el.props.systemImage)).toEqual([
        'pencil',
        'camera',
        'sparkles',
      ]);
      actions.forEach((el) => (el.props.onPress as () => void)());
      expect(onActionSelect.mock.calls).toEqual([
        ['manual'],
        ['camera'],
        ['chat'],
      ]);
      expect(
        collectElements(tree, (el) => el.type === 'PaperMenu'),
      ).toHaveLength(0);
    }
    setActiveLanguage('vi');
  });

  for (const platform of ['android', 'web'] as const) {
    it(
      platform +
        ': opens, dismisses, and selects all actions while the pill is hidden',
      () => {
        Platform.OS = platform;
        const onActionSelect = vi.fn();
        const render = () =>
          FloatingTabBarView({
            items: APP_TAB_ITEMS,
            activeKey: 'index',
            visible: false,
            onSelect: vi.fn(),
            onActionSelect,
          });
        const getMenu = () =>
          collectElements(render(), (el) => el.type === 'PaperMenu')[0]!;
        const open = () => {
          const menu = getMenu();
          const trigger = menu.props.anchor as ReactElement<
            Record<string, unknown>
          >;
          expect(trigger.props.accessibilityLabel).toBe(
            viMessages.addTransaction,
          );
          expect(trigger.props.accessibilityState).toEqual({ expanded: false });
          (trigger.props.onPress as () => void)();
          expect(getMenu().props.visible).toBe(true);
          expect(
            (getMenu().props.anchor as ReactElement<Record<string, unknown>>)
              .props.accessibilityState,
          ).toEqual({ expanded: true });
        };
        expect(getMenu().props.visible).toBe(false);
        open();
        (getMenu().props.onDismiss as () => void)();
        expect(getMenu().props.visible).toBe(false);
        for (let index = 0; index < 3; index++) {
          open();
          const actions = collectElements(
            getMenu(),
            (el) => el.type === 'PaperMenu.Item',
          );
          expect(actions.map((el) => el.props.title)).toEqual([
            viMessages.quickAddManual,
            viMessages.quickAddCamera,
            viMessages.quickAddAI,
          ]);
          (actions[index]!.props.onPress as () => void)();
          expect(getMenu().props.visible).toBe(false);
        }
        expect(onActionSelect.mock.calls).toEqual([
          ['manual'],
          ['camera'],
          ['chat'],
        ]);
        expect(
          collectElements(render(), (el) => el.type === 'SwiftUI.Host'),
        ).toHaveLength(0);
      },
    );
  }

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

    const openMenu = () => CustomBottomTabBar(props);
    const manualAction = collectElements(
      openMenu(),
      (el) =>
        el.type === 'SwiftUI.Button' &&
        el.props.label === viMessages.quickAddManual,
    )[0]!;
    (manualAction.props.onPress as () => void)();
    expect(usePreferences.getState().isAddTransactionOpen).toBe(true);

    const cameraAction = collectElements(
      openMenu(),
      (el) =>
        el.type === 'SwiftUI.Button' &&
        el.props.label === viMessages.quickAddCamera,
    )[0]!;
    (cameraAction.props.onPress as () => void)();
    expect(Alert.alert).toHaveBeenCalledWith(
      viMessages.receiptScan,
      viMessages.receiptChooseSource,
      expect.any(Array),
    );

    const chatAction = collectElements(
      openMenu(),
      (el) =>
        el.type === 'SwiftUI.Button' &&
        el.props.label === viMessages.quickAddAI,
    )[0]!;
    (chatAction.props.onPress as () => void)();
    expect(usePreferences.getState().isChatOpen).toBe(true);
  });

  it('does not navigate when the selected tab is pressed or tabPress is prevented', () => {
    const { props, emitSpy, navigateToTabSpy } = makeMockBottomTabBarProps(0);
    const tabs = collectElements(
      CustomBottomTabBar(props),
      (el) => el.props.accessibilityRole === 'tab',
    );
    (tabs[0]!.props.onPress as () => void)();
    expect(emitSpy).toHaveBeenCalledOnce();
    expect(navigateToTabSpy).not.toHaveBeenCalled();
    emitSpy.mockReturnValue({ defaultPrevented: true });
    (tabs[1]!.props.onPress as () => void)();
    expect(navigateToTabSpy).not.toHaveBeenCalled();
  });

  it('hides navigation in regular iPhone Chat and keeps the closed Duo rail', () => {
    const { props } = makeMockBottomTabBarProps(2); // index 2 = 'chat'

    expect(CustomBottomTabBar(props)).toBeNull();

    mockWindowDimensions.width = 540;
    mockWindowDimensions.height = 720;
    expect(CustomBottomTabBar(props)).not.toBeNull();
  });
});
