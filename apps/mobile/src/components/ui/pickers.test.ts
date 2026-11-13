import {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { Pill } from './pill';
import { CATEGORY_ICONS } from '@/data/categories';
import { setActiveLanguage } from '@/messages/language';
import { vi as viMessages } from '@/messages/vi';
import { toSfSymbol } from '@/utils/sf-symbols';
import {
  formatLocalDateToIso,
  parseIsoDateToLocalDate,
} from './date-field-helpers';
import {
  buildMonthYearOptions,
  formatMonthDraftToKey,
  getMonthWheelLabels,
  parseMonthKeyToDraft,
} from './month-field-helpers';
import {
  formatPickerOptionLabel,
  resolveSelectedOption,
} from './picker-helpers';
import {
  formatDateToTime,
  parseHourMinuteInputs,
  parseTimeToLocalDate,
} from './time-field-helpers';

const { stateHooks } = vi.hoisted(() => ({
  stateHooks: {
    values: [] as unknown[],
    setters: [] as ((next: unknown) => void)[],
    cursor: 0,
  },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const idx = stateHooks.cursor++;
      if (!(idx in stateHooks.values)) {
        stateHooks.values[idx] =
          typeof initial === 'function'
            ? (initial as () => unknown)()
            : initial;
        stateHooks.setters[idx] = (next: unknown) => {
          stateHooks.values[idx] =
            typeof next === 'function'
              ? (next as (prev: unknown) => unknown)(stateHooks.values[idx])
              : next;
        };
      }
      return [stateHooks.values[idx], stateHooks.setters[idx]];
    },
    useMemo: <T>(fn: () => T) => fn(),
    useCallback: <T>(fn: T) => fn,
    useRef: (initial: unknown) => ({ current: initial }),
  };
});

vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
  View: 'View',
  Text: 'RNText',
  Pressable: 'Pressable',
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  TouchableWithoutFeedback: 'TouchableWithoutFeedback',
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
    hairlineWidth: 1,
  },
}));

vi.mock('react-native-reanimated', () => ({
  useReducedMotion: () => false,
  default: { View: 'Animated.View' },
  useSharedValue: (initial: number) => ({ value: initial, set: vi.fn() }),
  useAnimatedStyle: (fn: () => Record<string, unknown>) => fn(),
  withSpring: (v: number) => v,
  withTiming: (v: number) => v,
  LinearTransition: { duration: () => ({}) },
}));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: 'MaterialCommunityIcons',
}));

vi.mock('expo-symbols', () => ({
  SymbolView: 'SymbolView',
}));

vi.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  SchedulableTriggerInputTypes: { DAILY: 'daily' },
  getPermissionsAsync: vi.fn().mockResolvedValue({ granted: true }),
  requestPermissionsAsync: vi.fn().mockResolvedValue({ granted: true }),
  cancelScheduledNotificationAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
}));

vi.mock('@/state/preferences', () => {
  const state = {
    themeMode: 'light' as const,
    language: 'vi' as const,
    currency: 'VND' as const,
    exchangeRate: 25000,
  };
  return {
    usePreferences: Object.assign(
      (selector?: (s: typeof state) => unknown) =>
        selector ? selector(state) : state,
      { getState: () => state },
    ),
  };
});

vi.mock('@expo/ui/swift-ui', () => ({
  Host: 'SwiftUI.Host',
  Menu: 'SwiftUI.Menu',
  Picker: 'SwiftUI.Picker',
  DatePicker: 'SwiftUI.DatePicker',
  HStack: 'SwiftUI.HStack',
  Image: 'SwiftUI.Image',
  Label: 'SwiftUI.Label',
  Text: 'SwiftUI.Text',
  Circle: 'SwiftUI.Circle',
}));

vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: (value: string) => ({
    type: 'accessibilityLabel',
    value,
  }),
  background: (style: unknown, shape: unknown) => ({
    type: 'background',
    style,
    shape,
  }),
  buttonStyle: (value: string) => ({ type: 'buttonStyle', value }),
  clipShape: (shape: string, radius?: number) => ({
    type: 'clipShape',
    shape,
    radius,
  }),
  contentTransition: (transitionType: string) => ({
    type: 'contentTransition',
    transitionType,
  }),
  datePickerStyle: (value: string) => ({ type: 'datePickerStyle', value }),
  labelsHidden: () => ({ type: 'labelsHidden' }),
  disabled: (value?: boolean) => ({ type: 'disabled', value }),
  foregroundStyle: (value: unknown) => ({ type: 'foregroundStyle', value }),
  frame: (value: unknown) => ({ type: 'frame', value }),
  geometryGroup: () => ({ type: 'geometryGroup' }),
  lineLimit: (value: number) => ({ type: 'lineLimit', value }),
  menuOrder: (value: string) => ({ type: 'menuOrder', value }),
  menuStyle: (value: string) => ({ type: 'menuStyle', value }),
  padding: (value: unknown) => ({ type: 'padding', value }),
  pickerStyle: (value: string) => ({ type: 'pickerStyle', value }),
  shapes: {
    roundedRectangle: (params: unknown) => ({
      shape: 'roundedRectangle',
      params,
    }),
  },
  tag: (value: unknown) => ({ type: 'tag', value }),
  truncationMode: (mode: string) => ({ type: 'truncationMode', mode }),
}));

vi.mock('react-native-paper', () => ({
  Button: 'PaperButton',
  HelperText: 'PaperHelperText',
  IconButton: 'PaperIconButton',
  SegmentedButtons: 'PaperSegmentedButtons',
  Text: 'PaperText',
  TextInput: 'PaperTextInput',
}));

function resetStateHooks() {
  stateHooks.values = [];
  stateHooks.setters = [];
  stateHooks.cursor = 0;
}

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
      visit(
        (element.type as (props: Record<string, unknown>) => ReactNode)(
          element.props,
        ),
      );
      return;
    }
    if (
      typeof element.type === 'object' &&
      element.type !== null &&
      'type' in element.type &&
      typeof (element.type as { type: unknown }).type === 'function'
    ) {
      visit(
        (
          element.type as {
            type: (props: Record<string, unknown>) => ReactNode;
          }
        ).type(element.props),
      );
      return;
    }
    if (predicate(element)) {
      matches.push(element);
    }
    const props = element.props as Record<string, unknown> | undefined;
    if (props && 'children' in props) {
      visit(props.children as ReactNode);
    }
    if (props && 'label' in props && isValidElement(props.label)) {
      visit(props.label);
    }
  }
  visit(node);
  return matches;
}

describe('Đợt 2 picker, date, month, and time helpers', () => {
  beforeEach(() => {
    resetStateHooks();
    setActiveLanguage('vi');
    (Platform as { OS: string }).OS = 'ios';
  });

  it.each(['ios', 'android', 'web'])(
    'keeps compact transaction filters labeled, selected and actionable on %s',
    (platform) => {
      (Platform as { OS: string }).OS = platform;
      const onPress = vi.fn();
      const compact = Pill({
        label: viMessages.transactionExpense,
        icon: 'arrow-top-right',
        compact: true,
        selected: true,
        onPress,
      });
      const buttons = collectElements(
        compact,
        (element) => element.type === 'Pressable',
      );
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.props.accessibilityLabel).toBe(
        viMessages.transactionExpense,
      );
      expect(buttons[0]!.props.accessibilityState).toEqual({ selected: true });
      expect(
        Object.assign(
          {},
          ...(buttons[0]!.props.style as object[]).flat(Infinity),
        ),
      ).toMatchObject({ width: 44, height: 44 });
      expect(
        collectElements(compact, (element) => element.type === 'RNText'),
      ).toHaveLength(0);
      expect(
        collectElements(
          compact,
          (element) =>
            element.type ===
            (platform === 'ios' ? 'SymbolView' : 'MaterialCommunityIcons'),
        ),
      ).toHaveLength(1);
      (buttons[0]!.props.onPress as () => void)();
      expect(onPress).toHaveBeenCalledOnce();
      const expanded = Pill({
        label: viMessages.transactionExpense,
        icon: 'arrow-top-right',
        compact: false,
        selected: true,
        onPress,
      });
      expect(
        collectElements(expanded, (element) => element.type === 'RNText'),
      ).toHaveLength(1);
    },
  );

  it('round-trips ISO dates including leap days and distant years without day shift', () => {
    for (const iso of [
      '2026-11-11',
      '2028-02-29',
      '1995-01-01',
      '2099-12-31',
    ]) {
      const date = parseIsoDateToLocalDate(iso, '2026-11-11');
      expect(formatLocalDateToIso(date)).toBe(iso);
    }
    const fallback = parseIsoDateToLocalDate('', '2026-11-11');
    expect(formatLocalDateToIso(fallback)).toBe('2026-11-11');
  });

  it('parses month keys and builds wheel year ranges covering distant selected years', () => {
    expect(parseMonthKeyToDraft('2026-11', '2026-01')).toEqual({
      year: 2026,
      monthIndex: 10,
    });
    expect(formatMonthDraftToKey({ year: 2026, monthIndex: 10 })).toBe(
      '2026-11',
    );
    const years = buildMonthYearOptions(2065, 2026, 30);
    expect(years[0]).toBe(1996);
    expect(years.at(-1)).toBe(2095);
    expect(years).toContain(2065);
    expect(getMonthWheelLabels('vi', viMessages.monthPickerMonth)).toHaveLength(
      12,
    );
  });

  it('parses and formats arbitrary times such as 07:10 and rejects invalid inputs', () => {
    const parsedDate = parseTimeToLocalDate('07:10');
    expect(formatDateToTime(parsedDate)).toBe('07:10');

    expect(parseHourMinuteInputs('7', '10')).toBe('07:10');
    expect(parseHourMinuteInputs('00', '00')).toBe('00:00');
    expect(parseHourMinuteInputs('23', '59')).toBe('23:59');
    expect(parseHourMinuteInputs('24', '00')).toBeNull();
    expect(parseHourMinuteInputs('12', '60')).toBeNull();
    expect(parseHourMinuteInputs('ab', '10')).toBeNull();
  });

  it('maps all category icons and wallet icons to non-placeholder SF Symbols', () => {
    for (const icon of CATEGORY_ICONS) {
      expect(toSfSymbol(icon)).not.toBe('circle');
    }
    for (const icon of [
      'cash-multiple',
      'bank-outline',
      'cellphone-check',
      'credit-card-outline',
      'piggy-bank-outline',
      'wallet-outline',
      'chart-donut',
      'repeat',
      'eye-outline',
      'bell-outline',
      'shield-lock-outline',
      'database-remove-outline',
      'magnify',
      'pencil-outline',
      'receipt-text-outline',
      'wallet-plus-outline',
    ]) {
      expect(toSfSymbol(icon)).not.toBe('circle');
    }
    expect(
      formatPickerOptionLabel({
        value: '1',
        label: 'Cà phê',
        subtitle: 'Thuộc: Ăn uống',
      }),
    ).toBe('Cà phê · Thuộc: Ăn uống');
    expect(
      resolveSelectedOption([{ value: 'a', label: 'A' }], 'a')?.label,
    ).toBe('A');
  });
});

describe('Đợt 2 iOS native vs Android/web controls', () => {
  beforeEach(() => {
    resetStateHooks();
    setActiveLanguage('vi');
  });

  it('renders native SwiftUI Menu + Picker on iOS AppleMenuPicker with colorSwatch and subtitles', async () => {
    const { AppleMenuPicker: IosAppleMenuPicker } =
      await import('./apple-menu-picker.ios');
    const onSelect = vi.fn();
    const tree = createElement(IosAppleMenuPicker, {
      label: 'Danh mục',
      value: 'coffee',
      options: [
        { value: '', label: 'Chưa phân loại', icon: 'help-circle-outline' },
        {
          value: 'coffee',
          label: 'Cà phê',
          subtitle: 'Thuộc: Ăn uống',
          icon: 'food',
          colorSwatch: '#A35319',
        },
      ],
      onSelect,
    });

    const host = collectElements(tree, (el) => el.type === 'SwiftUI.Host')[0]!;
    expect(host.props.matchContents).toEqual({ vertical: true });
    expect(host.props.alignment).toBe('trailing');
    expect(
      collectElements(tree, (el) => el.type === 'SwiftUI.Menu'),
    ).toHaveLength(1);
    expect(
      collectElements(tree, (el) => el.type === 'SwiftUI.Circle'),
    ).toHaveLength(1);
    const picker = collectElements(
      tree,
      (el) => el.type === 'SwiftUI.Picker',
    )[0]!;
    expect(picker.props.selection).toBe('coffee');

    const labels = collectElements(tree, (el) => el.type === 'SwiftUI.Label');
    expect(labels.map((el) => el.props.title)).toEqual([
      'Chưa phân loại',
      'Cà phê · Thuộc: Ăn uống',
    ]);

    (picker.props.onSelectionChange as (val: unknown) => void)('');
    expect(onSelect).toHaveBeenCalledWith('');
  });

  it('keeps custom Modal popup on Android/web AppleMenuPicker', async () => {
    const { AppleMenuPicker: FallbackAppleMenuPicker } =
      await import('./apple-menu-picker');
    const onSelect = vi.fn();
    const tree = createElement(FallbackAppleMenuPicker, {
      label: 'Ví',
      value: 'w1',
      options: [{ value: 'w1', label: 'Tiền mặt' }],
      onSelect,
    });
    expect(
      collectElements(tree, (el) => el.type === 'SwiftUI.Menu'),
    ).toHaveLength(0);
    expect(collectElements(tree, (el) => el.type === 'Modal')).toHaveLength(1);
  });

  it('renders DateField iOS graphical DatePicker and supports allowClear and Today without firing on Cancel', async () => {
    const { DateField: IosDateField } = await import('./date-field.ios');
    const onChange = vi.fn();
    const render = (allowClear: boolean, value = '2026-11-11') =>
      IosDateField({
        label: 'Hạn mục tiêu',
        value,
        allowClear,
        onChange,
      });

    stateHooks.cursor = 0;
    const treeWithClear = render(true);
    const buttons = collectElements(
      treeWithClear,
      (el) => el.type === 'PaperButton',
    );
    const clearBtn = buttons.find((b) => b.props.children === viMessages.clear);
    const todayBtn = buttons.find(
      (b) => b.props.children === viMessages.datePickerToday,
    );
    const cancelBtn = buttons.find(
      (b) => b.props.children === viMessages.cancel,
    );
    expect(clearBtn).toBeDefined();
    expect(todayBtn).toBeDefined();

    const nativeDatePicker = collectElements(
      treeWithClear,
      (el) => el.type === 'SwiftUI.DatePicker',
    )[0]!;
    expect(nativeDatePicker.props.displayedComponents).toEqual(['date']);

    (cancelBtn!.props.onPress as () => void)();
    expect(onChange).not.toHaveBeenCalled();

    (clearBtn!.props.onPress as () => void)();
    expect(onChange).toHaveBeenCalledWith('');

    resetStateHooks();
    const treeWithoutClear = render(false);
    const buttonsNoClear = collectElements(
      treeWithoutClear,
      (el) => el.type === 'PaperButton',
    );
    expect(
      buttonsNoClear.find((b) => b.props.children === viMessages.clear),
    ).toBeUndefined();
  });

  it('renders MonthField iOS dual wheel Pickers and preserves allowClear', async () => {
    const { MonthField: IosMonthField } = await import('./month-field.ios');
    const onChange = vi.fn();
    const tree = IosMonthField({
      label: 'Tháng kết thúc',
      value: '2026-11',
      allowClear: true,
      onChange,
    });
    const pickers = collectElements(tree, (el) => el.type === 'SwiftUI.Picker');
    expect(pickers).toHaveLength(2);

    const buttons = collectElements(tree, (el) => el.type === 'PaperButton');
    const clearBtn = buttons.find(
      (b) => b.props.children === viMessages.clear,
    )!;
    (clearBtn.props.onPress as () => void)();
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('renders TimeField iOS native hourAndMinute picker and Android/web editable HH:MM modal supporting 07:10', async () => {
    const { TimeField: IosTimeField } = await import('./time-field.ios');
    const { TimeField: FallbackTimeField } = await import('./time-field');
    const onIosChange = vi.fn();
    const iosTree = IosTimeField({
      label: 'Giờ nhắc',
      value: '20:00',
      onChange: onIosChange,
    });
    const iosPicker = collectElements(
      iosTree,
      (el) => el.type === 'SwiftUI.DatePicker',
    )[0]!;
    const host = collectElements(
      iosTree,
      (el) => el.type === 'SwiftUI.Host',
    )[0]!;
    expect(host.props.matchContents).toEqual({ vertical: true });
    expect(iosPicker.props.modifiers).toContainEqual({ type: 'labelsHidden' });
    expect(iosPicker.props.modifiers).toContainEqual({
      type: 'disabled',
      value: false,
    });
    (iosPicker.props.onDateChange as (d: Date) => void)(
      new Date(2026, 10, 11, 20, 0),
    );
    expect(onIosChange).not.toHaveBeenCalled();
    expect(iosPicker.props.displayedComponents).toEqual(['hourAndMinute']);
    (iosPicker.props.onDateChange as (d: Date) => void)(
      new Date(2026, 10, 11, 7, 10),
    );
    expect(onIosChange).toHaveBeenCalledWith('07:10');

    resetStateHooks();
    const onFallbackChange = vi.fn();
    const renderFallback = () => {
      stateHooks.cursor = 0;
      return FallbackTimeField({
        label: 'Giờ nhắc',
        value: '20:00',
        onChange: onFallbackChange,
      });
    };
    let fallbackTree = renderFallback();
    const trigger = collectElements(
      fallbackTree,
      (el) => el.type === 'Pressable',
    )[0]!;
    (trigger.props.onPress as () => void)();
    fallbackTree = renderFallback();
    const inputs = collectElements(
      fallbackTree,
      (el) => el.type === 'PaperTextInput',
    );
    (inputs[0]!.props.onChangeText as (v: string) => void)('07');
    (inputs[1]!.props.onChangeText as (v: string) => void)('10');
    fallbackTree = renderFallback();
    const doneBtn = collectElements(
      fallbackTree,
      (el) =>
        el.type === 'PaperButton' && el.props.children === viMessages.done,
    )[0]!;
    (doneBtn.props.onPress as () => void)();
    expect(onFallbackChange).toHaveBeenCalledWith('07:10');
  });

  it('renders SegmentedOptionPicker natively on iOS and via SegmentedButtons on Android/web', async () => {
    const { SegmentedOptionPicker: IosSegmentedOptionPicker } =
      await import('./segmented-option-picker.ios');
    const { SegmentedOptionPicker: FallbackSegmentedOptionPicker } =
      await import('./segmented-option-picker');
    const onIosSelect = vi.fn();
    const iosTree = IosSegmentedOptionPicker({
      label: 'Loại giao dịch',
      value: 'expense',
      options: [
        { value: 'expense', label: 'Chi' },
        { value: 'income', label: 'Thu' },
        { value: 'transfer', label: 'Chuyển' },
      ],
      onSelect: onIosSelect,
    });
    const picker = collectElements(
      iosTree,
      (el) => el.type === 'SwiftUI.Picker',
    )[0]!;
    expect(picker.props.selection).toBe('expense');
    (picker.props.onSelectionChange as (v: unknown) => void)('income');
    expect(onIosSelect).toHaveBeenCalledWith('income');

    const fallbackTree = FallbackSegmentedOptionPicker({
      label: 'Loại giao dịch',
      value: 'expense',
      options: [
        { value: 'expense', label: 'Chi' },
        { value: 'income', label: 'Thu' },
        { value: 'transfer', label: 'Chuyển' },
      ],
      onSelect: vi.fn(),
    });
    expect(
      collectElements(
        fallbackTree,
        (el) => el.type === 'PaperSegmentedButtons',
      ),
    ).toHaveLength(1);
  });
});
