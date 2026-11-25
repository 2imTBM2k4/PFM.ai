import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vi as viMessages } from '@/messages/vi';

const harness = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as { current: unknown }[],
  cursor: 0,
  refCursor: 0,
  effect: undefined as undefined | (() => void | (() => void)),
  readDashboard: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = harness.cursor++;
      if (!(index in harness.values)) {
        harness.values[index] =
          typeof initial === 'function' ? (initial as () => unknown)() : initial;
      }
      return [
        harness.values[index],
        (next: unknown) => {
          harness.values[index] =
            typeof next === 'function'
              ? (next as (prev: unknown) => unknown)(harness.values[index])
              : next;
        },
      ];
    },
    useRef: (initial: unknown) =>
      (harness.refs[harness.refCursor++] ??= { current: initial }),
    useCallback: <T>(fn: T) => fn,
    useEffect: (effect: () => void | (() => void)) => {
      harness.effect = effect;
    },
  };
});

vi.mock('@/components/platform-icon', () => ({
  default: 'MaterialCommunityIcons',
}));
vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Button: 'Button',
  Text: 'Text',
}));
vi.mock('@/components/screen', () => ({
  EmptyStateCard: 'EmptyStateCard',
  Screen: 'Screen',
  styles: { row: {}, inlineRow: {} },
}));
vi.mock('@/components/ui', () => ({
  GlassCard: 'GlassCard',
  Pill: 'Pill',
}));
vi.mock('@/constants/theme', () => ({
  DesignSpacing: { md: 16 },
  useDesignTheme: () => ({
    brand: { primary: '#5b5cf6' },
    text: { primary: '#111827', secondary: '#4b5563' },
  }),
  useFinancePalette: () => ({
    dangerSoft: '#fee2e2',
    danger: '#dc2626',
    dangerInk: '#991b1b',
  }),
}));
vi.mock('@/data/connection', () => ({
  withDatabase: (task: (db: object) => Promise<unknown>) => task({}),
}));
vi.mock('@/data/dashboard', () => ({
  readDashboard: harness.readDashboard,
}));
vi.mock('@/state/preferences', () => ({
  formatCurrencyAmount: (amount: number) => `${amount} đ`,
  usePreferences: Object.assign(
    (selector: (s: { language: 'vi' | 'en' }) => unknown) =>
      selector({ language: 'vi' }),
    { getState: () => ({ currency: 'VND', language: 'vi' }) },
  ),
}));

function collect(
  node: ReactNode,
  type: string,
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((child) => collect(child, type));
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [
    ...(el.type === type ? [el] : []),
    ...collect(el.props.children as ReactNode, type),
  ];
}

async function flushPromises() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

describe('NotificationsView', () => {
  beforeEach(() => {
    harness.values = [];
    harness.refs = [];
    harness.cursor = 0;
    harness.refCursor = 0;
    harness.effect = undefined;
    harness.readDashboard.mockReset();
  });

  it('shows an error alert with retry instead of empty state on load failure and recovers on retry', async () => {
    const { NotificationsView } = await import('./notifications-view');
    const render = () => {
      harness.cursor = 0;
      harness.refCursor = 0;
      return NotificationsView({ onClose: vi.fn() });
    };

    harness.readDashboard.mockRejectedValueOnce(new Error('DB offline'));
    let tree = render();
    expect(collect(tree, 'ActivityIndicator')).toHaveLength(1);
    harness.effect?.();
    await flushPromises();

    tree = render();
    expect(collect(tree, 'EmptyStateCard')).toHaveLength(0);
    const alertText = collect(tree, 'Text').find(
      (el) => el.props.accessibilityRole === 'alert',
    );
    expect(alertText?.props.children).toBe(viMessages.notificationsLoadError);
    const retryBtn = collect(tree, 'Button').find(
      (el) => el.props.children === viMessages.retry,
    );
    expect(retryBtn).toBeDefined();

    harness.readDashboard.mockResolvedValueOnce({
      budgets: [],
      goals: [],
      current: { income: 1000, expense: 500, net: 500 },
    });
    (retryBtn!.props.onPress as () => void)();
    await flushPromises();

    tree = render();
    expect(
      collect(tree, 'Text').find((el) => el.props.accessibilityRole === 'alert'),
    ).toBeUndefined();
    expect(collect(tree, 'GlassCard')).toHaveLength(1);
  });
});
