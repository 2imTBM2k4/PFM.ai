import { isValidElement, type ReactNode, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { GroupedBarChart } from './grouped-bar-chart';

const state = vi.hoisted(() => ({ fontScale: 1 }));
vi.mock('react', async (original) => ({
  ...(await original<object>()),
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ fontScale: state.fontScale }),
}));
vi.mock('react-native-paper', () => ({ Text: 'Text' }));
vi.mock('@/utils/display-money', () => ({
  formatCompactMoney: (value: number) => `${value}`,
  formatMoney: (value: number) => `${value}`,
}));
vi.mock('@/constants/theme', async () => {
  const { DesignColors, DesignSpacing } =
    await import('@/constants/design-tokens');
  return { DesignSpacing, useDesignTheme: () => DesignColors.light };
});

function textContent(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textContent).join(' ');
  if (isValidElement(node))
    return textContent(
      (node as ReactElement<{ children?: ReactNode }>).props.children,
    );
  return typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : '';
}

describe('Income and expense chart at accessibility text sizes', () => {
  it('reflows every period into labeled amounts without losing large or zero values', () => {
    state.fontScale = 2;
    const tree = GroupedBarChart({
      data: [{ label: '11/2026', income: 100_000_000_000, expense: 0 }],
      incomeLabel: 'Thu',
      expenseLabel: 'Chi',
    });
    expect(textContent(tree)).toContain('11/2026');
    expect(textContent(tree)).toContain('Thu: 100000000000');
    expect(textContent(tree)).toContain('Chi: 0');
  });
});
