import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { TransactionManager } from './transaction-manager';
vi.mock('@/components/platform-icon', () => ({
  default: 'MaterialCommunityIcons',
}));

const harness = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as { current: unknown }[],
  memos: [] as { value: unknown; deps: unknown[] }[],
  cursor: 0,
  refCursor: 0,
  memoCursor: 0,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values))
      harness.values[index] =
        initial === true
          ? false
          : typeof initial === 'function'
            ? initial()
            : initial;
    return [
      harness.values[index],
      (next: unknown) => {
        harness.values[index] =
          typeof next === 'function' ? next(harness.values[index]) : next;
      },
    ];
  },
  useRef: (value: unknown) =>
    (harness.refs[harness.refCursor++] ??= { current: value }),
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    const index = harness.memoCursor++;
    const previous = harness.memos[index];
    if (
      !previous ||
      deps.some((value, i) => !Object.is(value, previous.deps[i]))
    )
      harness.memos[index] = { value: factory(), deps };
    return harness.memos[index]!.value;
  },
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
}));
vi.mock('expo', () => ({ uuid: { v4: () => 'new' } }));
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: 'Icon' }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  FlatList: 'FlatList',
  ScrollView: 'ScrollView',
  View: 'View',
  Pressable: 'Pressable',
  TextInput: 'Search',
  Keyboard: { dismiss: vi.fn() },
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  LinearTransition: { duration: () => ({}) },
}));
vi.mock('react-native-paper', () => ({
  Button: 'Button',
  Text: 'Text',
  TextInput: 'Input',
  Divider: 'Divider',
  HelperText: 'Help',
  ActivityIndicator: 'Spinner',
  useTheme: () => ({ colors: {} }),
}));
vi.mock('@/components/screen', () => ({
  Screen: 'Screen',
  QuickTile: 'QuickTile',
  EmptyStateCard: 'Empty',
  IconBadge: 'Badge',
  StatusPill: 'Status',
  styles: { fill: {} },
}));
vi.mock('@/components/ui', () => ({
  Pill: 'Pill',
  GlassCard: 'Card',
  AppleMenuPicker: 'Picker',
  MoneyInput: 'Money',
  DateField: 'Date',
  SegmentedOptionPicker: 'Segments',
}));
vi.mock('@/constants/theme', () => ({
  DesignRadius: {},
  DesignSpacing: {},
  createSoftShadow: () => ({}),
  walletKindVisual: vi.fn(),
  useFinancePalette: () => ({}),
  useDesignTheme: () => ({ mode: 'light', text: {}, brand: {}, card: {} }),
}));
vi.mock('@/data/connection', () => ({ withDatabase: vi.fn() }));
vi.mock('@/features/quick-entry/confirmation', () => ({
  EntryConfirmation: 'Confirmation',
}));
vi.mock('./transaction-filters', () => ({ TransactionFilterForm: 'Filters' }));
vi.mock('@/state/app', () => ({ useApp: () => 0 }));
vi.mock('@/state/preferences', () => ({
  usePreferences: (selector: (state: object) => unknown) =>
    selector({ language: 'vi', pendingTransactionEntry: null }),
}));
vi.mock('@/hooks/use-tab-bar-scroll', async (original) => ({
  ...(await original<typeof import('@/hooks/use-tab-bar-scroll')>()),
  useTabBarScroll: () => ({ onScroll() {} }),
}));

function collect(
  node: ReactNode,
  type: string,
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((child) => collect(child, type));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [
    ...(element.type === type ? [element] : []),
    ...collect(element.props.children as ReactNode, type),
  ];
}

function render() {
  harness.cursor = 0;
  harness.refCursor = 0;
  harness.memoCursor = 0;
  return TransactionManager({ onManageDebts() {}, onManageRecurring() {} });
}

it('hides search with two compact rows, preserves filters, restores search and omits the top add action', () => {
  let tree = render();
  expect(tree.props.headerRight).toBeUndefined();
  const query = collect(tree, 'Search')[0]!;
  (query.props.onChangeText as (value: string) => void)('coffee');
  const list = collect(tree, 'FlatList')[0]!;
  (list.props.onScroll as (event: unknown) => void)({
    nativeEvent: {
      contentOffset: { y: 150 },
      contentSize: { height: 1500 },
      layoutMeasurement: { height: 600 },
    },
  });
  tree = render();
  expect(collect(tree, 'Search')).toHaveLength(0);
  expect(collect(tree, 'Pill')).toHaveLength(4);
  expect(collect(tree, 'QuickTile')).toHaveLength(3);
  for (const button of [
    ...collect(tree, 'Pill'),
    ...collect(tree, 'QuickTile'),
  ])
    expect(button.props.compact).toBe(true);
  (collect(tree, 'FlatList')[0]!.props.onScroll as (event: unknown) => void)({
    nativeEvent: {
      contentOffset: { y: 100 },
      contentSize: { height: 1500 },
      layoutMeasurement: { height: 600 },
    },
  });
  tree = render();
  expect(collect(tree, 'Search')[0]!.props.value).toBe('coffee');
  for (const button of [
    ...collect(tree, 'Pill'),
    ...collect(tree, 'QuickTile'),
  ])
    expect(button.props.compact).toBe(false);
});
