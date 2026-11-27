import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GlassCard } from '@/components/ui/glass-card';

const { mockState } = vi.hoisted(() => ({
  mockState: {
    mode: 'light' as 'light' | 'dark',
    reducedMotion: false,
  },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => [
      typeof initial === 'function' ? (initial as () => T)() : initial,
      vi.fn(),
    ],
  };
});

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Platform: {
    OS: 'ios',
  },
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
  },
}));

vi.mock('react-native-reanimated', () => {
  const createEntering = (name: string) => ({
    name,
    duration() {
      return this;
    },
    delay() {
      return this;
    },
    springify() {
      return this;
    },
    damping() {
      return this;
    },
    stiffness() {
      return this;
    },
  });

  return {
    default: {
      View: 'Animated.View',
    },
    FadeInDown: createEntering('FadeInDown'),
    useSharedValue: (initial: number) => ({
      value: initial,
      set(value: number) {
        this.value = value;
      },
    }),
    useAnimatedStyle: (updater: () => Record<string, unknown>) => updater(),
    useReducedMotion: () => mockState.reducedMotion,
    withSpring: (target: number) => target,
  };
});

vi.mock('@/constants/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isCompactPhone: false }),
}));

vi.mock('@/constants/theme', async () => {
  const tokens = await import('@/constants/design-tokens');
  return {
    DesignRadius: tokens.DesignRadius,
    DesignSpacing: tokens.DesignSpacing,
    createSoftShadow: tokens.createSoftShadow,
    useDesignTheme: () => ({
      mode: mockState.mode,
      brand: {
        primarySoft: '#ede9fe',
        primaryBorder: '#8b5cf6',
      },
      card: {
        surface: '#ffffff',
        surfaceElevated: '#f8fafc',
        surfaceSubtle: '#f1f5f9',
        border: '#e2e8f0',
      },
    }),
  };
});

function collectElements(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  const result: ReactElement<Record<string, unknown>>[] = [];
  if (Array.isArray(node)) {
    for (const child of node) {
      result.push(...collectElements(child, predicate));
    }
    return result;
  }
  if (!isValidElement(node)) {
    return result;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  if (predicate(element)) {
    result.push(element);
  }
  const children = element.props.children as ReactNode;
  if (children !== undefined) {
    result.push(...collectElements(children, predicate));
  }
  return result;
}

describe('GlassCard', () => {
  beforeEach(() => {
    mockState.mode = 'light';
    mockState.reducedMotion = false;
  });

  it('separates entering layout animation from scale animatedStyle when pressable', () => {
    const tree = GlassCard({
      onPress: vi.fn(),
      enterIndex: 2,
      accessibilityLabel: 'Top Savings Goal',
      children: 'Card Content',
    });

    const animatedViews = collectElements(
      tree,
      (el) => el.type === 'Animated.View',
    );
    expect(animatedViews).toHaveLength(2);

    const [outerView, innerView] = animatedViews;
    expect(outerView!.props.entering).toBeDefined();
    expect(outerView!.props.style).toBeUndefined();
    expect(innerView!.props.entering).toBeUndefined();
    expect(innerView!.props.style).toEqual({ transform: [{ scale: 1 }] });
  });

  it('uses a single Animated.View for pressable cards without entering animation', () => {
    const tree = GlassCard({
      onPress: vi.fn(),
      accessibilityLabel: 'Pressable Card',
      children: 'Card Content',
    });

    const animatedViews = collectElements(
      tree,
      (el) => el.type === 'Animated.View',
    );
    expect(animatedViews).toHaveLength(1);
    expect(animatedViews[0]!.props.entering).toBeUndefined();
    expect(animatedViews[0]!.props.style).toEqual({
      transform: [{ scale: 1 }],
    });
  });

  it('keeps entering animation on non-pressable cards and respects reduced motion', () => {
    const animatedTree = GlassCard({
      enterIndex: 1,
      accessibilityLabel: 'Static Card',
      children: 'Card Content',
    });
    const animatedViews = collectElements(
      animatedTree,
      (el) => el.type === 'Animated.View',
    );
    expect(animatedViews).toHaveLength(1);
    expect(animatedViews[0]!.props.entering).toBeDefined();

    mockState.reducedMotion = true;
    const reducedTree = GlassCard({
      onPress: vi.fn(),
      enterIndex: 1,
      accessibilityLabel: 'Reduced Motion Card',
      children: 'Card Content',
    });
    const reducedAnimatedViews = collectElements(
      reducedTree,
      (el) => el.type === 'Animated.View',
    );
    expect(reducedAnimatedViews).toHaveLength(1);
    expect(reducedAnimatedViews[0]!.props.entering).toBeUndefined();
  });
});
