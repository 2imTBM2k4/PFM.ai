import SegmentedButtons from '@/components/ui/native-segmented-buttons';
import { useTransientState } from '@/hooks/use-transient-state';
import { useCurrentDate } from '@/hooks/use-current-date';
import { FieldFeedback } from '@/components/field-feedback';
import {
  amountError,
  dateError,
  endDateError,
  monthError,
  percentError,
} from '@/utils/form-validation';
import { uuid } from 'expo';
import { useFocusEffect } from 'expo-router';
import {
  budgetThresholds,
  today,
  validateDate,
} from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import { BudgetInputSchema, type BudgetInput } from '@pfm/contracts';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { haveFieldsChanged, requestGuardLeave } from '@/utils/unsaved-changes';
import {
  BackHandler,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Button,
  Divider,
  ProgressBar,
  Switch,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import MaterialCommunityIcons from '@/components/platform-icon';
import {
  EmptyStateCard,
  IconBadge,
  Screen,
  StatusPill,
  styles,
} from '@/components/screen';
import {
  AppleMenuPicker,
  DateField,
  MoneyInput,
  MonthField,
  SegmentedOptionPicker,
} from '@/components/ui';
import { DesignSpacing, useFinancePalette } from '@/constants/theme';
import { useTabBarScroll } from '@/hooks/use-tab-bar-scroll';
import { withDatabase } from '@/data/connection';
import type { Database } from '@/data/migrate';
import {
  createBudget,
  updateBudget,
  setBudgetActive,
  readBudgetMonth,
  type BudgetRow,
} from '@/data/budgets';
import {
  listCategories,
  orderCategoriesByParent,
  type CategoryRow,
} from '@/data/categories';
import { vi } from '@/messages/vi';
import { displayCategoryName } from '@/messages/seed-labels';
import { useApp } from '@/state/app';
import { usePreferences } from '@/state/preferences';
import { formatDisplayDate, formatDisplayMonth } from '@/utils/display';
import {
  formatAmountInput,
  parseAmountInput,
} from '@/features/transactions/form';
import { checkBudgetAlerts } from './mobile';

type Mode =
  { type: 'list' } | { type: 'form'; row: BudgetRow | null; id: string };

/**
 * Splits budget rows into active in-period budgets for the current month and
 * paused or out-of-period budgets shown in the collapsible inactive section.
 */
export function partitionBudgetsByActivity(rows: readonly BudgetRow[]): {
  activeRows: BudgetRow[];
  inactiveRows: BudgetRow[];
} {
  const activeRows: BudgetRow[] = [];
  const inactiveRows: BudgetRow[] = [];
  for (const row of rows) {
    if (row.is_active && row.in_period) {
      activeRows.push(row);
    } else {
      inactiveRows.push(row);
    }
  }
  return { activeRows, inactiveRows };
}

export function BudgetManager({
  onSwitchToStats,
  onSwitchTab,
  onClose,
}: {
  onSwitchToStats?(): void;
  onSwitchTab?(tab: 'budgets' | 'goals' | 'stats'): void;
  onClose?(): void;
} = {}) {
  const currentDate = useCurrentDate();
  const currentMonth = currentDate.slice(0, 7);
  const [rows, setRows] = useState<BudgetRow[]>([]),
    [categories, setCategories] = useState<CategoryRow[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [mode, setMode] = useState<Mode>({ type: 'list' });
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useTransientState('');
  const working = useRef(false);
  const loadRequest = useRef(0);
  const hasLoadedOnce = useRef(false);
  const tabBarScroll = useTabBarScroll();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    if (!hasLoadedOnce.current) {
      setLoading(true);
    }
    setError('');
    try {
      const data = await withDatabase(async (db) => ({
        rows: await readBudgetMonth(db, currentMonth, undefined, currentDate),
        categories: await listCategories(db, true),
      }));
      if (request !== loadRequest.current) return;
      hasLoadedOnce.current = true;
      setRows(data.rows);
      setCategories(data.categories);
      void checkBudgetAlerts();
    } catch {
      if (request === loadRequest.current) setError(vi.budgetLoadError);
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [currentDate, currentMonth]);
  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(() => {
        void load();
      });
      return () => cancelAnimationFrame(frame);
    }, [load]),
  );
  const leaveForm = useCallback(() => {
    if (working.current) return;
    setMode({ type: 'list' });
    setError('');
  }, []);
  const back = useCallback(() => {
    if (working.current) return;
    if (mode.type === 'form') {
      requestGuardLeave('budget-form', leaveForm);
      return;
    }
    leaveForm();
    onClose?.();
  }, [mode.type, leaveForm, onClose]);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') return;
      const listener = BackHandler.addEventListener('hardwareBackPress', () => {
        if (mode.type === 'list' && !onClose) return false;
        back();
        return true;
      });
      return () => listener.remove();
    }, [mode.type, back, onClose]),
  );
  const mutate = useCallback(
    async (action: (db: Database) => Promise<void>) => {
      if (working.current) return;
      working.current = true;
      const request = ++loadRequest.current;
      setBusy(true);
      setError('');
      setNotice('');
      let committed = false;
      try {
        const next = await withDatabase(async (db) => {
          await action(db);
          committed = true;
          return readBudgetMonth(db, currentMonth, undefined, currentDate);
        });
        if (request === loadRequest.current) setRows(next);
        setMode({ type: 'list' });
        setNotice(vi.budgetSaved);
        useApp.setState((s) => ({ recurringVersion: s.recurringVersion + 1 }));
        void checkBudgetAlerts();
      } catch {
        if (committed) setMode({ type: 'list' });
        setError(committed ? vi.walletSavedRefreshFailed : vi.saveError);
      } finally {
        working.current = false;
        setBusy(false);
        if (request === loadRequest.current) setLoading(false);
      }
    },
    [currentDate, currentMonth, setNotice],
  );
  const { activeRows, inactiveRows } = useMemo(
    () => partitionBudgetsByActivity(rows),
    [rows],
  );
  const edit = useCallback(
    (row: BudgetRow) => {
      setMode({ type: 'form', row, id: row.id });
      setError('');
      setNotice('');
    },
    [setNotice],
  );
  const toggle = useCallback(
    (row: BudgetRow) => {
      void mutate((db) =>
        setBudgetActive(db, row.id, !row.is_active, new Date().toISOString()),
      );
    },
    [mutate],
  );
  const renderItem = useCallback(
    ({ item }: { item: BudgetRow }) => (
      <BudgetItem
        row={item}
        categories={categories}
        busy={busy || loading}
        onEdit={edit}
        onToggle={toggle}
      />
    ),
    [busy, loading, edit, toggle, categories],
  );
  if (mode.type === 'form')
    return (
      <BudgetForm
        row={mode.row}
        month={currentMonth}
        categories={categories}
        busy={busy || loading}
        error={error}
        onBack={leaveForm}
        onSave={(input) =>
          mutate((db) =>
            mode.row
              ? updateBudget(db, mode.id, input, new Date().toISOString())
              : createBudget(db, mode.id, input, new Date().toISOString()),
          )
        }
      />
    );
  return (
    <Screen
      title={vi.budgets}
      onBack={onClose ? back : undefined}
      backDisabled={busy}
      scroll={false}
    >
      {(!!onSwitchTab || !!onSwitchToStats) && mode.type === 'list' && (
        <SegmentedButtons
          value="budgets"
          density="small"
          onValueChange={(value) => {
            if (onSwitchTab) {
              onSwitchTab(value as 'budgets' | 'goals' | 'stats');
            } else if (value === 'stats' && onSwitchToStats) {
              onSwitchToStats();
            }
          }}
          buttons={[
            {
              value: 'stats',
              label: vi.statsTabTitle,
              showSelectedCheck: false,
              labelStyle: localStyles.segmentLabel,
            },
            {
              value: 'budgets',
              label: vi.budgetsTabTitle,
              showSelectedCheck: false,
              labelStyle: localStyles.segmentLabel,
            },
            {
              value: 'goals',
              label: vi.goals,
              showSelectedCheck: false,
              labelStyle: localStyles.segmentLabel,
            },
          ]}
        />
      )}
      <View
        style={[
          localStyles.monthBar,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        <View style={localStyles.monthLabelGroup}>
          <MaterialCommunityIcons
            name="calendar-month-outline"
            size={18}
            color={palette.primaryInk}
          />
          <Text
            variant="titleMedium"
            style={[styles.number, { fontWeight: '700' }]}
          >
            {vi.budgetCurrentMonthLabel.replace(
              '{month}',
              formatDisplayMonth(currentMonth),
            )}
          </Text>
        </View>
        <StatusPill
          label={vi.budgetActiveCount.replace(
            '{count}',
            String(activeRows.length),
          )}
          bg={palette.primarySoft}
          fg={palette.primaryInk}
        />
      </View>

      <Button
        hitSlop={4}
        mode="contained"
        icon="plus"
        contentStyle={styles.button}
        disabled={busy || loading}
        onPress={() => {
          setMode({ type: 'form', row: null, id: uuid.v4() });
          setError('');
          setNotice('');
        }}
      >
        {vi.addBudget}
      </Button>

      {!!notice && (
        <View
          style={[
            styles.subtlePanel,
            {
              backgroundColor: palette.incomeSoft,
              borderColor: palette.income,
            },
          ]}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: palette.incomeInk, fontWeight: '600' }}
          >
            {notice}
          </Text>
        </View>
      )}
      {!!error && (
        <View
          style={[
            styles.subtlePanel,
            {
              backgroundColor: palette.dangerSoft,
              borderColor: palette.danger,
            },
          ]}
        >
          <Text accessibilityRole="alert" style={{ color: colors.error }}>
            {error}
          </Text>
          <Button hitSlop={4} disabled={loading || busy} onPress={load}>
            {vi.retry}
          </Button>
        </View>
      )}
      {loading ? (
        <View style={{ paddingVertical: 28, alignItems: 'center' }}>
          <ActivityIndicator size="large" accessibilityLabel={vi.loading} />
        </View>
      ) : (
        <FlatList
          style={styles.fill}
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          onScroll={tabBarScroll.onScroll}
          scrollEventThrottle={tabBarScroll.scrollEventThrottle}
          data={activeRows}
          keyExtractor={(row) => row.id}
          renderItem={renderItem}
          contentContainerStyle={{
            gap: 14,
            paddingBottom: DesignSpacing.bottomTabClearance + insets.bottom,
          }}
          ListEmptyComponent={
            <EmptyStateCard
              icon="chart-arc"
              message={
                inactiveRows.length > 0 ? vi.budgetNoActive : vi.budgetEmpty
              }
            />
          }
          ListFooterComponent={
            inactiveRows.length > 0 ? (
              <View style={localStyles.inactiveSection}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showInactive }}
                  accessibilityLabel={vi.budgetInactiveToggle.replace(
                    '{count}',
                    String(inactiveRows.length),
                  )}
                  onPress={() => setShowInactive((prev) => !prev)}
                  style={({ pressed }) => [
                    localStyles.inactiveToggle,
                    {
                      backgroundColor: palette.surfaceMuted,
                      borderColor: palette.border,
                    },
                    pressed && { opacity: 0.78 },
                  ]}
                >
                  <Text
                    variant="labelLarge"
                    style={{
                      color: palette.textMuted,
                      fontWeight: '700',
                      flex: 1,
                    }}
                  >
                    {vi.budgetInactiveToggle.replace(
                      '{count}',
                      String(inactiveRows.length),
                    )}
                  </Text>
                  <MaterialCommunityIcons
                    name={showInactive ? 'chevron-up' : 'chevron-down'}
                    size={20}
                    color={palette.textMuted}
                  />
                </Pressable>
                {showInactive && (
                  <View style={localStyles.inactiveList}>
                    {inactiveRows.map((item) => (
                      <BudgetItem
                        key={item.id}
                        row={item}
                        categories={categories}
                        busy={busy || loading}
                        onEdit={edit}
                        onToggle={toggle}
                      />
                    ))}
                  </View>
                )}
              </View>
            ) : undefined
          }
        />
      )}
    </Screen>
  );
}

const BudgetItem = memo(function BudgetItem({
  row,
  categories,
  busy,
  onEdit,
  onToggle,
}: {
  row: BudgetRow;
  categories: CategoryRow[];
  busy: boolean;
  onEdit(row: BudgetRow): void;
  onToggle(row: BudgetRow): void;
}) {
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const thresholds =
    row.is_active && row.in_period
      ? budgetThresholds(row.spent, row.amount, row.warn_percent)
      : [];
  const pct = row.amount > 0 ? Math.round((row.spent / row.amount) * 100) : 0;
  const category = categories.find((c) => c.id === row.category_id);
  const icon =
    category?.icon || (row.category_id ? 'tag-outline' : 'chart-donut');
  const catColor = category?.color;

  const badgeBg = thresholds.includes(100)
    ? palette.dangerSoft
    : thresholds.length
      ? palette.warningSoft
      : catColor
        ? `${catColor}20`
        : palette.primarySoft;

  const badgeFg = thresholds.includes(100)
    ? palette.dangerInk
    : thresholds.length
      ? palette.warningInk
      : catColor || palette.primaryInk;

  const periodSubtitle =
    row.period_type === 'custom' && row.start_date
      ? row.end_date
        ? `Từ ${formatDisplayDate(row.start_date)} đến ${formatDisplayDate(row.end_date)}`
        : `${vi.budgetStartDate} ${formatDisplayDate(row.start_date)} · ${vi.budgetNoEndDate}`
      : `${formatDisplayMonth(row.start_month)}${row.end_month ? ` → ${formatDisplayMonth(row.end_month)}` : ' (Tự động reset)'}`;

  return (
    <View
      style={[
        styles.panel,
        { backgroundColor: palette.surface, borderColor: palette.border },
      ]}
    >
      <View style={styles.row}>
        <View style={[styles.inlineRow, { flex: 1 }]}>
          <IconBadge icon={icon} bg={badgeBg} fg={badgeFg} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="titleMedium" style={{ fontWeight: '700' }}>
              {row.category_name
                ? displayCategoryName(row.category_name)
                : vi.budgetOverall}
              {row.category_archived
                ? ` · ${vi.transactionArchivedReference}`
                : ''}
            </Text>
            <Text variant="bodySmall" style={{ color: palette.textMuted }}>
              {periodSubtitle}
            </Text>
          </View>
        </View>
        {!row.is_active ? (
          <StatusPill
            icon="pause-circle-outline"
            label={vi.budgetPaused}
            bg={palette.surfaceMuted}
            fg={palette.textMuted}
          />
        ) : row.in_period ? (
          <StatusPill
            label={`${pct}%`}
            bg={
              thresholds.includes(100)
                ? palette.dangerSoft
                : thresholds.length
                  ? palette.warningSoft
                  : palette.primarySoft
            }
            fg={
              thresholds.includes(100)
                ? palette.dangerInk
                : thresholds.length
                  ? palette.warningInk
                  : palette.primaryInk
            }
          />
        ) : null}
      </View>

      {!row.in_period ? (
        <Text variant="bodySmall" style={{ color: palette.textMuted }}>
          {vi.budgetOutsidePeriod}
        </Text>
      ) : (
        <>
          <View style={styles.row}>
            <Text variant="bodyMedium" style={styles.number}>
              {row.period_type === 'custom'
                ? vi.budgetDailySpent
                : vi.budgetSpent}
              :{' '}
              <Text style={{ fontWeight: '700' }}>{formatVnd(row.spent)}</Text>
            </Text>
            <Text
              variant="bodyMedium"
              style={[styles.number, { color: palette.textMuted }]}
            >
              {row.period_type === 'custom'
                ? vi.budgetDailyLimit
                : vi.budgetLimit}
              : {formatVnd(row.amount)}
            </Text>
          </View>
          {row.spent > row.amount && (
            <Text
              variant="bodySmall"
              style={[styles.number, { color: palette.dangerInk }]}
            >
              {vi.budgetOver.replace(
                '{amount}',
                formatVnd(row.spent - row.amount),
              )}
            </Text>
          )}
          <ProgressBar
            progress={Math.min(1, row.spent / row.amount)}
            color={
              thresholds.includes(100)
                ? colors.error
                : thresholds.length
                  ? palette.warning
                  : colors.primary
            }
            style={{ height: 8, borderRadius: 4 }}
            accessibilityLabel={vi.budgetSpent}
            accessibilityValue={{
              min: 0,
              max: row.amount,
              now: Math.min(row.spent, row.amount),
            }}
          />
          {!!thresholds.length && (
            <View
              style={[
                styles.subtlePanel,
                {
                  backgroundColor: thresholds.includes(100)
                    ? palette.dangerSoft
                    : palette.warningSoft,
                  borderColor: thresholds.includes(100)
                    ? palette.danger
                    : palette.warning,
                  padding: 10,
                },
              ]}
            >
              <Text
                accessibilityRole="alert"
                variant="bodySmall"
                style={{
                  color: thresholds.includes(100)
                    ? palette.dangerInk
                    : palette.warningInk,
                  fontWeight: '600',
                }}
              >
                {thresholds.includes(100)
                  ? vi.budgetReached
                  : vi.budgetWarning.replace(
                      '{percent}',
                      String(row.warn_percent),
                    )}
              </Text>
            </View>
          )}
        </>
      )}

      <Divider style={{ backgroundColor: palette.borderSubtle }} />
      <View style={[styles.row, { justifyContent: 'flex-end' }]}>
        <Button
          hitSlop={4}
          compact
          mode="contained-tonal"
          icon="pencil-outline"
          disabled={busy}
          onPress={() => onEdit(row)}
        >
          {vi.editBudget}
        </Button>
        <Button
          hitSlop={4}
          compact
          mode="outlined"
          icon={row.is_active ? 'pause' : 'play'}
          disabled={busy}
          onPress={() => onToggle(row)}
        >
          {row.is_active ? vi.budgetPause : vi.budgetResume}
        </Button>
      </View>
    </View>
  );
});

interface BudgetFields {
  amount: string;
  warnPercent: string;
  periodType: 'monthly' | 'custom';
  startMonth: string;
  endMonth: string;
  startDate: string;
  endDate: string;
  categoryId: string;
}

function BudgetForm({
  row,
  month,
  categories,
  busy,
  error,
  onBack,
  onSave,
}: {
  row: BudgetRow | null;
  month: string;
  categories: CategoryRow[];
  busy: boolean;
  error: string;
  onBack(): void;
  onSave(input: BudgetInput): Promise<void>;
}) {
  const todayStr = today({
    now: () => new Date(),
    timeZone: 'Asia/Ho_Chi_Minh',
  });
  const [initialValues] = useState<BudgetFields>(() => ({
    amount: row ? formatAmountInput(String(row.amount)) : '',
    warnPercent: String(row?.warn_percent ?? 80),
    periodType: row?.period_type ?? 'monthly',
    startMonth: row?.start_month ?? month,
    endMonth: row?.end_month ?? '',
    startDate: row?.start_date ?? todayStr,
    endDate: row?.period_type === 'custom' ? (row.end_date ?? '') : todayStr,
    categoryId: row?.category_id ?? '',
  }));
  const {
    control,
    handleSubmit,
    getValues,
    setValue,
    formState: { isSubmitting },
  } = useForm<BudgetFields>({
    defaultValues: initialValues,
  });
  const watched = useWatch({ control });
  const currentValues: BudgetFields = {
    amount: watched.amount ?? initialValues.amount,
    warnPercent: watched.warnPercent ?? initialValues.warnPercent,
    periodType: watched.periodType ?? initialValues.periodType,
    startMonth: watched.startMonth ?? initialValues.startMonth,
    endMonth: watched.endMonth ?? initialValues.endMonth,
    startDate: watched.startDate ?? initialValues.startDate,
    endDate: watched.endDate ?? initialValues.endDate,
    categoryId: watched.categoryId ?? initialValues.categoryId,
  };
  const periodType = currentValues.periodType;
  const [formError, setFormError] = useState('');
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const disabled = busy || isSubmitting;
  const relevantKeys: (keyof BudgetFields)[] =
    periodType === 'custom'
      ? [
          'amount',
          'warnPercent',
          'periodType',
          'startDate',
          'endDate',
          'categoryId',
        ]
      : [
          'amount',
          'warnPercent',
          'periodType',
          'startMonth',
          'endMonth',
          'categoryId',
        ];
  const dirty = haveFieldsChanged(initialValues, currentValues, {
    moneyKeys: ['amount'],
    keys: relevantKeys,
  });
  const { requestLeave, runGuardedSave } = useUnsavedChangesGuard({
    id: 'budget-form',
    scope: 'tab',
    routeKey: 'budgets',
    dirty,
    saving: disabled,
    hasError: !!formError || !!error,
    changeSignature: JSON.stringify(currentValues),
    onDiscard: onBack,
  });

  const language = usePreferences((state) => state.language);
  const categoryOptions = useMemo(
    () => [
      {
        value: '',
        label: vi.budgetOverall,
        icon: 'chart-donut',
        iconBg: palette.primarySoft,
        iconColor: palette.primaryInk,
      },
      ...orderCategoriesByParent(
        categories.filter(
          (c) =>
            c.kind === 'expense' &&
            (!c.is_archived || c.id === row?.category_id),
        ),
      ).map((c) => {
        const parent = c.parent_id
          ? categories.find((p) => p.id === c.parent_id)
          : null;
        return {
          value: c.id,
          label: displayCategoryName(c.name),
          icon: c.icon || 'tag-outline',
          iconBg: palette.expenseSoft,
          iconColor: c.color || palette.expenseInk,
          subtitle: parent
            ? `${language === 'en' ? 'Under' : 'Thu\u1ed9c'}: ${displayCategoryName(parent.name)}`
            : undefined,
        };
      }),
    ],
    [categories, row?.category_id, palette, language],
  );

  const footer = (
    <>
      {(!!formError || !!error) && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {formError || error}
        </Text>
      )}

      <Button
        hitSlop={4}
        mode="contained"
        icon="check"
        contentStyle={styles.button}
        disabled={disabled}
        loading={disabled}
        onPress={() => {
          void handleSubmit(async (values) => {
            let input: BudgetInput;
            try {
              if (!/^\d+$/.test(values.warnPercent)) {
                setFormError(vi.budgetInvalid);
                return;
              }
              const warnNum = Number(values.warnPercent);
              if (warnNum < 1 || warnNum > 100) {
                setFormError(vi.budgetInvalid);
                return;
              }

              if (values.periodType === 'custom') {
                try {
                  validateDate(values.startDate);
                  if (values.endDate) validateDate(values.endDate);
                } catch {
                  setFormError(vi.budgetDateRangeInvalid);
                  return;
                }
                if (values.endDate && values.endDate < values.startDate) {
                  setFormError(vi.budgetDateRangeInvalid);
                  return;
                }
              }

              input = BudgetInputSchema.parse({
                amount: parseAmountInput(values.amount),
                warnPercent: warnNum,
                periodType: values.periodType,
                startDate:
                  values.periodType === 'custom' ? values.startDate : null,
                endDate:
                  values.periodType === 'custom'
                    ? values.endDate || null
                    : null,
                startMonth:
                  values.periodType === 'custom'
                    ? values.startDate.slice(0, 7)
                    : values.startMonth,
                endMonth:
                  values.periodType === 'custom'
                    ? values.endDate
                      ? values.endDate.slice(0, 7)
                      : null
                    : values.endMonth || null,
                categoryId: values.categoryId || null,
              });
            } catch {
              setFormError(vi.budgetInvalid);
              return;
            }
            setFormError('');
            await runGuardedSave(() => onSave(input));
          })();
        }}
      >
        {vi.saveBudget}
      </Button>
    </>
  );

  return (
    <Screen
      title={row ? vi.editBudget : vi.addBudget}
      onBack={requestLeave}
      backDisabled={disabled}
      footer={footer}
    >
      <View
        style={[
          styles.panel,
          {
            backgroundColor: palette.surface,
            borderColor: palette.border,
            gap: 14,
          },
        ]}
      >
        <Controller
          control={control}
          name="categoryId"
          render={({ field, fieldState }) => (
            <FieldFeedback
              fieldRef={field.ref}
              message={fieldState.error?.message}
            >
              <AppleMenuPicker
                label={vi.transactionCategory}
                value={field.value}
                options={categoryOptions}
                disabled={disabled}
                onSelect={field.onChange}
              />
            </FieldFeedback>
          )}
        />

        <SegmentedOptionPicker
          label={vi.budgetPeriodType}
          value={periodType}
          disabled={disabled}
          onSelect={(val) => setValue('periodType', val)}
          options={[
            { value: 'monthly', label: vi.budgetPeriodMonthly },
            { value: 'custom', label: vi.budgetPeriodCustom },
          ]}
        />

        {periodType === 'custom' ? (
          <>
            <Controller
              control={control}
              name="startDate"
              rules={{
                validate: (value) =>
                  getValues('periodType') !== 'custom' || dateError(value),
              }}
              render={({ field, fieldState }) => (
                <FieldFeedback
                  fieldRef={field.ref}
                  message={fieldState.error?.message}
                >
                  <DateField
                    error={!!fieldState.error}
                    label={vi.budgetStartDate}
                    value={field.value}
                    onChange={field.onChange}
                    disabled={disabled}
                  />
                </FieldFeedback>
              )}
            />
            <View style={styles.row}>
              <Text style={{ flex: 1 }}>{vi.budgetNoEndDate}</Text>
              <Switch
                accessibilityLabel={vi.budgetNoEndDate}
                disabled={disabled}
                value={!currentValues.endDate}
                onValueChange={(unlimited) =>
                  setValue(
                    'endDate',
                    unlimited
                      ? ''
                      : currentValues.startDate > todayStr
                        ? currentValues.startDate
                        : todayStr,
                  )
                }
              />
            </View>
            {!!currentValues.endDate && (
              <Controller
                control={control}
                name="endDate"
                rules={{
                  validate: (value) =>
                    getValues('periodType') !== 'custom' ||
                    endDateError(value, getValues('startDate'), true),
                }}
                render={({ field, fieldState }) => (
                  <FieldFeedback
                    fieldRef={field.ref}
                    message={fieldState.error?.message}
                  >
                    <DateField
                      error={!!fieldState.error}
                      label={vi.budgetEndDate}
                      value={field.value}
                      onChange={field.onChange}
                      disabled={disabled}
                    />
                  </FieldFeedback>
                )}
              />
            )}
            <Text variant="bodySmall" style={{ color: palette.textMuted }}>
              {vi.budgetDailyResetHint}
            </Text>
          </>
        ) : (
          <>
            <Controller
              control={control}
              name="startMonth"
              rules={{
                validate: (value) =>
                  getValues('periodType') !== 'monthly' || monthError(value),
              }}
              render={({ field, fieldState }) => (
                <FieldFeedback
                  fieldRef={field.ref}
                  message={fieldState.error?.message}
                >
                  <MonthField
                    error={!!fieldState.error}
                    label={vi.budgetStart}
                    value={field.value}
                    onChange={field.onChange}
                    disabled={disabled}
                  />
                </FieldFeedback>
              )}
            />
            <Controller
              control={control}
              name="endMonth"
              rules={{
                validate: (value) =>
                  getValues('periodType') !== 'monthly' ||
                  (monthError(value, true) !== true
                    ? monthError(value, true)
                    : !value ||
                      value >= getValues('startMonth') ||
                      vi.formEndMonthBeforeStart),
              }}
              render={({ field, fieldState }) => (
                <FieldFeedback
                  fieldRef={field.ref}
                  message={fieldState.error?.message}
                >
                  <MonthField
                    error={!!fieldState.error}
                    label={vi.budgetEnd}
                    value={field.value}
                    onChange={field.onChange}
                    disabled={disabled}
                    allowClear
                  />
                </FieldFeedback>
              )}
            />
            <Text variant="bodySmall" style={{ color: palette.textMuted }}>
              {vi.budgetMonthlyHint}
            </Text>
          </>
        )}

        <Divider style={{ backgroundColor: palette.borderSubtle }} />

        <Controller
          control={control}
          name="amount"
          rules={{ validate: (value) => amountError(value) }}
          render={({ field, fieldState }) => (
            <FieldFeedback
              fieldRef={field.ref}
              message={fieldState.error?.message}
            >
              <MoneyInput
                error={!!fieldState.error}
                label={
                  periodType === 'custom'
                    ? vi.budgetDailyAmount
                    : vi.budgetAmount
                }
                accessibilityLabel={
                  periodType === 'custom'
                    ? vi.budgetDailyAmount
                    : vi.budgetAmount
                }
                value={field.value}
                onBlur={field.onBlur}
                disabled={disabled}
                left={<TextInput.Icon icon="cash" />}
                onChangeText={field.onChange}
              />
            </FieldFeedback>
          )}
        />

        <Controller
          control={control}
          name="warnPercent"
          rules={{ validate: percentError }}
          render={({ field, fieldState }) => (
            <FieldFeedback
              fieldRef={field.ref}
              message={fieldState.error?.message}
            >
              <TextInput
                error={!!fieldState.error}
                mode="outlined"
                label={vi.budgetWarnPercent}
                accessibilityLabel={vi.budgetWarnPercent}
                value={field.value}
                onBlur={field.onBlur}
                disabled={disabled}
                left={<TextInput.Icon icon="percent-outline" />}
                keyboardType="number-pad"
                onChangeText={field.onChange}
              />
            </FieldFeedback>
          )}
        />
      </View>
    </Screen>
  );
}

const localStyles = StyleSheet.create({
  monthBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 44,
    borderRadius: 16,
    borderWidth: 1,
  },
  monthLabelGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  inactiveSection: {
    gap: 12,
    marginTop: 4,
  },
  inactiveToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
  },
  inactiveList: {
    gap: 14,
  },
  segmentLabel: {
    fontSize: 13,
    fontWeight: '700',
  },
});
