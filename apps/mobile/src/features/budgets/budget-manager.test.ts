import { beforeEach, expect, it, vi } from 'vitest';
import { BudgetManager } from './budget-manager';

const harness = vi.hoisted(() => ({
  date: '2026-11-10',
  state: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateCursor: 0,
  refCursor: 0,
  focusEffects: [] as (() => void | (() => void))[],
  resolveLoads: [] as ((value: unknown) => void)[],
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
  View: 'View',
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'Spinner',
  Button: 'Button',
  Divider: 'Divider',
  IconButton: 'IconButton',
  ProgressBar: 'ProgressBar',
  SegmentedButtons: 'Segments',
  Text: 'Text',
  TextInput: 'TextInput',
  useTheme: () => ({ colors: {} }),
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
  DesignSpacing: {},
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
vi.mock('@/data/connection', () => ({
  withDatabase: () =>
    new Promise((resolve) => harness.resolveLoads.push(resolve)),
}));
vi.mock('@/state/app', () => ({ useApp: { setState: vi.fn() } }));
vi.mock('@/state/preferences', () => ({ usePreferences: () => 'vi' }));
vi.mock('./mobile', () => ({ checkBudgetAlerts: vi.fn() }));

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
