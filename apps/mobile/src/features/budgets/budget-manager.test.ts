import { beforeEach, expect, it, vi } from 'vitest';
import { BudgetManager, partitionBudgetsByActivity } from './budget-manager';
import { readBudgetMonth, type BudgetRow } from '@/data/budgets';
import { vi as viMessages } from '@/messages/vi';

const harness = vi.hoisted(() => ({
  date: '2026-11-10',
  state: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateCursor: 0,
  refCursor: 0,
  focusEffects: [] as (() => void | (() => void))[],
  resolveLoads: [] as ((value: unknown) => void)[],
  invokeWithDb: false,
}));

vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = harness.stateCursor++;
      if (!(index in harness.state))
        harness.state[index] =
          typeof initial === 'function' ? initial() : initial;
      return [
        harness.state[index],
        (value: unknown) => {
          harness.state[index] =
            typeof value === 'function' ? value(harness.state[index]) : value;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = harness.refCursor++;
      return (harness.refs[index] ??= { current: initial });
    },
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useEffect: () => {},
  };
});
vi.mock('expo', () => ({ uuid: { v4: () => 'new-budget' } }));
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => harness.focusEffects.push(effect),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  BackHandler: { addEventListener: () => ({ remove() {} }) },
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'Spinner',
  Button: 'Button',
  Divider: 'Divider',
  ProgressBar: 'ProgressBar',
  SegmentedButtons: 'Segments',
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  useTheme: () => ({ colors: {} }),
}));
vi.mock('@/components/platform-icon', () => ({
  default: 'MaterialCommunityIcons',
}));
vi.mock('@/components/screen', () => ({
  EmptyStateCard: 'Empty',
  IconBadge: 'Badge',
  Screen: 'Screen',
  StatusPill: 'Status',
  styles: {},
}));
vi.mock('@/components/ui', () => ({
  AppleMenuPicker: 'Picker',
  DateField: 'Date',
  MoneyInput: 'Money',
  MonthField: 'Month',
  SegmentedOptionPicker: 'Segments',
}));
vi.mock('@/constants/theme', () => ({
  DesignSpacing: { bottomTabClearance: 112 },
  useFinancePalette: () => ({}),
}));
vi.mock('@/hooks/use-current-date', () => ({
  useCurrentDate: () => harness.date,
}));
vi.mock('@/hooks/use-transient-state', async () => ({
  useTransientState: (await import('react')).useState,
}));
vi.mock('@/hooks/use-tab-bar-scroll', () => ({ useTabBarScroll: () => ({}) }));
vi.mock('@/hooks/use-unsaved-changes-guard', () => ({
  useUnsavedChangesGuard: vi.fn(),
}));
vi.mock('@/data/budgets', () => ({
  createBudget: vi.fn(),
  updateBudget: vi.fn(),
  setBudgetActive: vi.fn(),
  readBudgetMonth: vi.fn(async () => []),
}));
vi.mock('@/data/categories', () => ({
  listCategories: vi.fn(async () => []),
  orderCategoriesByParent: (items: unknown[]) => items,
}));
vi.mock('@/data/connection', () => ({
  withDatabase: (fn: (db: unknown) => Promise<unknown>) =>
    harness.invokeWithDb
      ? fn({})
      : new Promise((resolve) => harness.resolveLoads.push(resolve)),
}));
vi.mock('@/state/app', () => ({ useApp: { setState: vi.fn() } }));
vi.mock('@/state/preferences', () => ({
  usePreferences: () => 'vi',
}));
vi.mock('./mobile', () => ({ checkBudgetAlerts: vi.fn() }));

function collectElements(
  node: unknown,
  predicate: (el: { type: unknown; props: Record<string, unknown> }) => boolean,
  acc: { type: unknown; props: Record<string, unknown> }[] = [],
) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, acc);
    return acc;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.props) {
    if (predicate({ type: el.type, props: el.props })) {
      acc.push({ type: el.type, props: el.props });
    }
    collectElements(el.props.children, predicate, acc);
    if (el.props.ListEmptyComponent) {
      collectElements(el.props.ListEmptyComponent, predicate, acc);
    }
    if (el.props.ListFooterComponent) {
      collectElements(el.props.ListFooterComponent, predicate, acc);
    }
  }
  return acc;
}

function makeBudgetRow(overrides: Partial<BudgetRow> = {}): BudgetRow {
  return {
    id: 'b1',
    category_id: 'cat-food',
    amount: 3_000_000,
    warn_percent: 80,
    start_month: '2026-01',
    end_month: null,
    period_type: 'monthly',
    start_date: null,
    end_date: null,
    is_active: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    category_name: 'Ăn uống',
    category_archived: 0,
    spent: 500_000,
    in_period: 1,
    ...overrides,
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

function render() {
  harness.stateCursor = 0;
  harness.refCursor = 0;
  harness.focusEffects = [];
  const tree = BudgetManager();
  harness.focusEffects.forEach((effect) => effect());
  return tree;
}

beforeEach(() => {
  harness.date = '2026-11-10';
  harness.state = [];
  harness.refs = [];
  harness.resolveLoads = [];
  harness.invokeWithDb = false;
  vi.mocked(readBudgetMonth).mockReset();
  vi.mocked(readBudgetMonth).mockResolvedValue([]);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    callback();
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

it('loads the new day while an older database read is pending and ignores the stale result', async () => {
  render();
  expect(harness.resolveLoads).toHaveLength(1);
  harness.date = '2026-11-11';
  render();
  expect(harness.resolveLoads).toHaveLength(2);
  const today = [{ id: 'daily', spent: 0 }];
  harness.resolveLoads[1]!({ rows: today, categories: [] });
  await Promise.resolve();
  const yesterday = [{ id: 'daily', spent: 150000 }];
  harness.resolveLoads[0]!({ rows: yesterday, categories: [] });
  await Promise.resolve();
  expect(harness.state).toContain(today);
  expect(harness.state).not.toContain(yesterday);
});

it('partitions active in-period budgets from paused and out-of-period budgets', () => {
  const active = makeBudgetRow({ id: 'active', is_active: 1, in_period: 1 });
  const paused = makeBudgetRow({ id: 'paused', is_active: 0, in_period: 1 });
  const ended = makeBudgetRow({ id: 'ended', is_active: 1, in_period: 0 });
  const pausedOutside = makeBudgetRow({
    id: 'both-off',
    is_active: 0,
    in_period: 0,
  });

  const { activeRows, inactiveRows } = partitionBudgetsByActivity([
    active,
    paused,
    ended,
    pausedOutside,
  ]);

  expect(activeRows).toEqual([active]);
  expect(inactiveRows).toEqual([paused, ended, pausedOutside]);
});

it('shows only the current month without month navigation and groups inactive budgets into a collapsible footer', async () => {
  const active = makeBudgetRow({ id: 'active-food', is_active: 1, in_period: 1 });
  const paused = makeBudgetRow({ id: 'paused-shop', is_active: 0, in_period: 1 });
  const expired = makeBudgetRow({ id: 'expired-trip', is_active: 1, in_period: 0 });
  harness.invokeWithDb = true;
  vi.mocked(readBudgetMonth).mockResolvedValue([active, paused, expired]);

  render();
  await flushMicrotasks();

  expect(readBudgetMonth).toHaveBeenCalledWith(
    expect.anything(),
    '2026-11',
    undefined,
    '2026-11-10',
  );

  // Month rollover updates queried month automatically without manual month chevrons.
  harness.date = '2026-12-01';
  render();
  await flushMicrotasks();
  const tree = render();

  expect(readBudgetMonth).toHaveBeenCalledWith(
    expect.anything(),
    '2026-12',
    undefined,
    '2026-12-01',
  );

  const flatLists = collectElements(tree, (el) => el.type === 'FlatList');
  expect(flatLists).toHaveLength(1);
  expect(flatLists[0]!.props.data).toEqual([active]);

  const jsonTree = JSON.stringify(tree);
  expect(jsonTree).toContain('12/2026');
  expect(jsonTree).not.toContain(viMessages.budgetPreviousMonth);
  expect(jsonTree).not.toContain(viMessages.budgetNextMonth);

  const toggleButtons = collectElements(
    tree,
    (el) =>
      el.type === 'Pressable' &&
      el.props.accessibilityRole === 'button' &&
      el.props.accessibilityState !== undefined,
  );
  expect(toggleButtons).toHaveLength(1);
  expect(toggleButtons[0]!.props.accessibilityState).toEqual({
    expanded: false,
  });

  // Expanding footer reveals the paused and out-of-period budgets so users can resume/edit them.
  (toggleButtons[0]!.props.onPress as () => void)();
  const expandedTree = render();
  const expandedLists = collectElements(
    expandedTree,
    (el) => el.type === 'FlatList',
  );
  const footerJson = JSON.stringify(expandedLists[0]!.props.ListFooterComponent);
  expect(footerJson).toContain('paused-shop');
  expect(footerJson).toContain('expired-trip');
});

it('shows the no-active-budgets empty card while keeping paused budgets accessible below', async () => {
  const pausedOnly = makeBudgetRow({
    id: 'only-paused',
    is_active: 0,
    in_period: 1,
  });
  harness.invokeWithDb = true;
  vi.mocked(readBudgetMonth).mockResolvedValue([pausedOnly]);

  render();
  await flushMicrotasks();
  const tree = render();

  const empties = collectElements(tree, (el) => el.type === 'Empty');
  expect(empties).toHaveLength(1);
  expect(empties[0]!.props.message).toBe(viMessages.budgetNoActive);
});
