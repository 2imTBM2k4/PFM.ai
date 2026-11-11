import { uuid } from 'expo';
import { useFocusEffect } from 'expo-router';
import {
  addMonths,
  budgetThresholds,
  monthKey,
  today,
  validateDate,
} from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import { BudgetInputSchema, type BudgetInput } from '@pfm/contracts';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { BackHandler, FlatList, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Divider,
  IconButton,
  ProgressBar,
  SegmentedButtons,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import {
  EmptyStateCard,
  IconBadge,
  Screen,
  StatusPill,
  styles,
} from '@/components/screen';
import { AppleMenuPicker, DateField, MoneyInput, MonthField } from '@/components/ui';
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
import { listCategories, type CategoryRow } from '@/data/categories';
import { vi } from '@/messages/vi';
import { displayCategoryName } from '@/messages/seed-labels';
import { useApp } from '@/state/app';
import { formatDisplayDate, formatDisplayMonth } from '@/utils/display';
import {
  formatAmountInput,
  parseAmountInput,
} from '@/features/transactions/form';
import { checkBudgetAlerts } from './mobile';

type Mode =
  { type: 'list' } | { type: 'form'; row: BudgetRow | null; id: string };

export function BudgetManager({
  onSwitchToStats,
  onSwitchTab,
}: {
  onSwitchToStats?(): void;
  onSwitchTab?(tab: 'budgets' | 'goals' | 'stats'): void;
} = {}) {
  const [month, setMonth] = useState(() =>
    monthKey(today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' })),
  );
  const [rows, setRows] = useState<BudgetRow[]>([]),
    [categories, setCategories] = useState<CategoryRow[]>([]);
  const [mode, setMode] = useState<Mode>({ type: 'list' });
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const working = useRef(false);
  const hasLoadedOnce = useRef(false);
  const tabBarScroll = useTabBarScroll();
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const load = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    if (!hasLoadedOnce.current) {
      setLoading(true);
    }
    setError('');
    try {
      const data = await withDatabase(async (db) => ({
        rows: await readBudgetMonth(db, month),
        categories: await listCategories(db, true),
      }));
      hasLoadedOnce.current = true;
      setRows(data.rows);
      setCategories(data.categories);
      void checkBudgetAlerts();
    } catch {
      setError(vi.budgetLoadError);
    } finally {
      working.current = false;
      setLoading(false);
    }
  }, [month]);
  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(() => {
        void load();
      });
      return () => cancelAnimationFrame(frame);
    }, [load]),
  );
  const back = useCallback(() => {
    if (!working.current) {
      setMode({ type: 'list' });
      setError('');
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      const listener = BackHandler.addEventListener('hardwareBackPress', () => {
        if (mode.type === 'list') return false;
        back();
        return true;
      });
      return () => listener.remove();
    }, [mode.type, back]),
  );
  const mutate = useCallback(
    async (action: (db: Database) => Promise<void>) => {
      if (working.current) return;
      working.current = true;
      setBusy(true);
      setError('');
      setNotice('');
      let committed = false;
      try {
        const next = await withDatabase(async (db) => {
          await action(db);
          committed = true;
          return readBudgetMonth(db, month);
        });
        setRows(next);
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
      }
    },
    [month],
  );
  const edit = useCallback((row: BudgetRow) => {
    setMode({ type: 'form', row, id: row.id });
    setError('');
    setNotice('');
  }, []);
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
        month={month}
        categories={categories}
        busy={busy || loading}
        error={error}
        onBack={back}
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
    <Screen title={vi.budgets} scroll={false}>
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
        <IconButton
          icon="chevron-left"
          size={20}
          accessibilityLabel={vi.budgetPreviousMonth}
          style={{ margin: 0 }}
          disabled={busy || loading || month === '0001-01'}
          onPress={() => setMonth(monthKey(addMonths(`${month}-01`, -1)))}
        />
        <Text
          variant="titleMedium"
          style={[styles.number, { fontWeight: '700' }]}
        >
          {formatDisplayMonth(month)}
        </Text>
        <IconButton
          icon="chevron-right"
          size={20}
          accessibilityLabel={vi.budgetNextMonth}
          style={{ margin: 0 }}
          disabled={busy || loading || month === '9999-12'}
          onPress={() => setMonth(monthKey(addMonths(`${month}-01`, 1)))}
        />
      </View>

      <Button
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
          <Button disabled={loading || busy} onPress={load}>
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
          data={rows}
          keyExtractor={(row) => row.id}
          renderItem={renderItem}
          contentContainerStyle={{
            gap: 14,
            paddingBottom: DesignSpacing.bottomTabClearance,
          }}
          ListEmptyComponent={
            <EmptyStateCard icon="chart-arc" message={vi.budgetEmpty} />
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
  const icon = category?.icon || (row.category_id ? 'tag-outline' : 'chart-donut');
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
    row.period_type === 'custom' && row.start_date && row.end_date
      ? `Từ ${formatDisplayDate(row.start_date)} đến ${formatDisplayDate(row.end_date)}`
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
          <IconBadge
            icon={icon}
            bg={badgeBg}
            fg={badgeFg}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="titleMedium" style={{ fontWeight: '700' }}>
              {row.category_name ? displayCategoryName(row.category_name) : vi.budgetOverall}
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
              {vi.budgetSpent}:{' '}
              <Text style={{ fontWeight: '700' }}>{formatVnd(row.spent)}</Text>
            </Text>
            <Text
              variant="bodyMedium"
              style={[styles.number, { color: palette.textMuted }]}
            >
              {vi.budgetLimit}: {formatVnd(row.amount)}
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
          compact
          mode="contained-tonal"
          icon="pencil-outline"
          disabled={busy}
          onPress={() => onEdit(row)}
        >
          {vi.editBudget}
        </Button>
        <Button
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
  const todayStr = today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' });
  const {
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { isSubmitting },
  } = useForm<BudgetFields>({
    defaultValues: {
      amount: row ? formatAmountInput(String(row.amount)) : '',
      warnPercent: String(row?.warn_percent ?? 80),
      periodType: row?.period_type ?? 'monthly',
      startMonth: row?.start_month ?? month,
      endMonth: row?.end_month ?? '',
      startDate: row?.start_date ?? todayStr,
      endDate: row?.end_date ?? todayStr,
      categoryId: row?.category_id ?? '',
    },
  });
  const periodType = watch('periodType');
  const [formError, setFormError] = useState('');
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const disabled = busy || isSubmitting;

  const categoryOptions = useMemo(
    () => [
      {
        value: '',
        label: vi.budgetOverall,
        icon: 'chart-donut',
        iconBg: palette.primarySoft,
        iconColor: palette.primaryInk,
      },
      ...categories
        .filter(
          (c) =>
            c.kind === 'expense' &&
            (!c.is_archived || c.id === row?.category_id),
        )
        .map((c) => {
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
              ? `Thuộc: ${displayCategoryName(parent.name)}`
              : undefined,
          };
        }),
    ],
    [categories, row?.category_id, palette],
  );

  return (
    <Screen
      title={row ? vi.editBudget : vi.addBudget}
      onBack={onBack}
      backDisabled={disabled}
    >
      <View
        style={[
          styles.panel,
          { backgroundColor: palette.surface, borderColor: palette.border, gap: 14 },
        ]}
      >
        <Controller
          control={control}
          name="categoryId"
          render={({ field }) => (
            <AppleMenuPicker
              label={vi.transactionCategory}
              value={field.value}
              options={categoryOptions}
              disabled={disabled}
              onSelect={field.onChange}
            />
          )}
        />

        <View style={{ gap: 6 }}>
          <Text
            variant="labelMedium"
            style={{ color: palette.textMuted, fontWeight: '600' }}
          >
            {vi.budgetPeriodType}
          </Text>
          <SegmentedButtons
            value={periodType}
            density="small"
            onValueChange={(val) =>
              setValue('periodType', val as 'monthly' | 'custom')
            }
            buttons={[
              {
                value: 'monthly',
                label: vi.budgetPeriodMonthly,
                showSelectedCheck: false,
                labelStyle: localStyles.segmentLabel,
              },
              {
                value: 'custom',
                label: vi.budgetPeriodCustom,
                showSelectedCheck: false,
                labelStyle: localStyles.segmentLabel,
              },
            ]}
          />
        </View>

        {periodType === 'custom' ? (
          <>
            <Controller
              control={control}
              name="startDate"
              render={({ field }) => (
                <DateField
                  label={vi.budgetStartDate}
                  value={field.value}
                  onChange={field.onChange}
                  disabled={disabled}
                />
              )}
            />
            <Controller
              control={control}
              name="endDate"
              render={({ field }) => (
                <DateField
                  label={vi.budgetEndDate}
                  value={field.value}
                  onChange={field.onChange}
                  disabled={disabled}
                />
              )}
            />
            <Text variant="bodySmall" style={{ color: palette.textMuted }}>
              {vi.budgetCustomHint}
            </Text>
          </>
        ) : (
          <>
            <Controller
              control={control}
              name="startMonth"
              render={({ field }) => (
                <MonthField
                  label={vi.budgetStart}
                  value={field.value}
                  onChange={field.onChange}
                  disabled={disabled}
                />
              )}
            />
            <Controller
              control={control}
              name="endMonth"
              render={({ field }) => (
                <MonthField
                  label={vi.budgetEnd}
                  value={field.value}
                  onChange={field.onChange}
                  disabled={disabled}
                  allowClear
                />
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
          render={({ field }) => (
            <MoneyInput
              label={vi.budgetAmount}
              accessibilityLabel={vi.budgetAmount}
              value={field.value}
              onBlur={field.onBlur}
              disabled={disabled}
              left={<TextInput.Icon icon="cash" />}
              onChangeText={field.onChange}
            />
          )}
        />

        <Controller
          control={control}
          name="warnPercent"
          render={({ field }) => (
            <TextInput
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
          )}
        />
      </View>

      {(!!formError || !!error) && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {formError || error}
        </Text>
      )}

      <Button
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
                  validateDate(values.endDate);
                } catch {
                  setFormError(vi.budgetDateRangeInvalid);
                  return;
                }
                if (values.endDate < values.startDate) {
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
                endDate: values.periodType === 'custom' ? values.endDate : null,
                startMonth:
                  values.periodType === 'custom'
                    ? values.startDate.slice(0, 7)
                    : values.startMonth,
                endMonth:
                  values.periodType === 'custom'
                    ? values.endDate.slice(0, 7)
                    : values.endMonth || null,
                categoryId: values.categoryId || null,
              });
            } catch {
              setFormError(vi.budgetInvalid);
              return;
            }
            setFormError('');
            await onSave(input);
          })();
        }}
      >
        {vi.saveBudget}
      </Button>
    </Screen>
  );
}

const localStyles = StyleSheet.create({
  monthBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 16,
    borderWidth: 1,
  },
  segmentLabel: {
    fontSize: 13,
    fontWeight: '700',
  },
});
