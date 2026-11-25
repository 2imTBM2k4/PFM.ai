import {
  FieldFeedback,
  FocusAwareTextInput,
} from '@/components/field-feedback';
import { amountError } from '@/utils/form-validation';
import { uuid } from 'expo';
import { useFocusEffect } from 'expo-router';
import { addDays, daysInMonth, today } from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import { RecurringInputSchema, type RecurringInput } from '@pfm/contracts';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { haveFieldsChanged, requestGuardLeave } from '@/utils/unsaved-changes';
import { Alert, BackHandler, Platform, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Divider,
  IconButton,
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
import {
  AppleMenuPicker,

  MoneyInput,
  SegmentedOptionPicker,
} from '@/components/ui';
import { useFinancePalette, walletKindVisual } from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import {
  deleteRecurringRule,
  listRecurringRules,
  saveRecurringRule,
  setRecurringActive,
  type RecurringRow,
} from '@/data/recurring';
import { listWallets, type WalletRow } from '@/data/repository';
import {
  listCategories,
  orderCategoriesByParent,
  type CategoryRow,
} from '@/data/categories';
import type { Database } from '@/data/migrate';
import {
  formatAmountInput,
  parseAmountInput,
} from '@/features/transactions/form';
import { useApp } from '@/state/app';
import { vi } from '@/messages/vi';
import { displayCategoryName, displayWalletName } from '@/messages/seed-labels';
import { requestRecurringNotifications, useRecurringStatus } from './mobile';

const FREQUENCIES = [
  { value: 'daily', label: vi.recurringDaily },
  { value: 'weekly', label: vi.recurringWeekly },
  { value: 'monthly', label: vi.recurringMonthly },
  { value: 'yearly', label: vi.recurringYearly },
] as const;
const KINDS = [
  { value: 'expense', label: vi.transactionExpense },
  { value: 'income', label: vi.transactionIncome },
  { value: 'transfer', label: vi.transactionTransfer },
] as const;
const localDate = () =>
  today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' });

const WEEKDAYS = [
  { value: '1', label: 'Thứ 2' },
  { value: '2', label: 'Thứ 3' },
  { value: '3', label: 'Thứ 4' },
  { value: '4', label: 'Thứ 5' },
  { value: '5', label: 'Thứ 6' },
  { value: '6', label: 'Thứ 7' },
  { value: '7', label: 'Chủ nhật' },
] as const;

const MONTHS = Array.from({ length: 12 }, (_, index) => ({
  value: String(index + 1),
  label: `Tháng ${index + 1}`,
}));

function isoWeekdayOfDate(dateStr: string): number {
  const jsDay = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

function parseScheduleParts(dateStr: string): {
  dayOfWeek: string;
  dayOfMonth: string;
  monthOfYear: string;
} {
  const [, monthStr = '1', dayStr = '1'] = dateStr.split('-');
  return {
    dayOfWeek: String(isoWeekdayOfDate(dateStr)),
    dayOfMonth: String(Number(dayStr) || 1),
    monthOfYear: String(Number(monthStr) || 1),
  };
}

function computeStartOnFromSchedule(
  frequency: RecurringInput['frequency'],
  dayOfWeekStr: string,
  dayOfMonthStr: string,
  monthOfYearStr: string,
  referenceDate: string,
): string {
  if (frequency === 'daily') return referenceDate;
  if (frequency === 'weekly') {
    const targetDow = Math.min(7, Math.max(1, Number(dayOfWeekStr) || 1));
    const currentDow = isoWeekdayOfDate(referenceDate);
    const diff = (targetDow - currentDow + 7) % 7;
    return addDays(referenceDate, diff);
  }
  const [refYear, refMonth] = referenceDate.split('-').map(Number);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  if (frequency === 'monthly') {
    const targetDay = Math.min(31, Math.max(1, Number(dayOfMonthStr) || 1));
    const currentMonthDay = Math.min(targetDay, daysInMonth(refYear, refMonth));
    const currentCandidate = `${refYear}-${pad2(refMonth)}-${pad2(currentMonthDay)}`;
    if (currentCandidate >= referenceDate && currentMonthDay === targetDay) {
      return currentCandidate;
    }
    let nextYear = refYear;
    let nextMonth = refMonth + (currentCandidate >= referenceDate ? 0 : 1);
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear += 1;
    }
    const clampedDay = Math.min(targetDay, daysInMonth(nextYear, nextMonth));
    return `${nextYear}-${pad2(nextMonth)}-${pad2(clampedDay)}`;
  }
  const targetMonth = Math.min(12, Math.max(1, Number(monthOfYearStr) || 1));
  const targetDay = Math.min(31, Math.max(1, Number(dayOfMonthStr) || 1));
  const thisYearDay = Math.min(targetDay, daysInMonth(refYear, targetMonth));
  const thisYearCandidate = `${refYear}-${pad2(targetMonth)}-${pad2(thisYearDay)}`;
  if (thisYearCandidate >= referenceDate) {
    return thisYearCandidate;
  }
  const nextYear = refYear + 1;
  const nextYearDay = Math.min(targetDay, daysInMonth(nextYear, targetMonth));
  return `${nextYear}-${pad2(targetMonth)}-${pad2(nextYearDay)}`;
}

function formatRecurringSummary(row: RecurringRow): string {
  const freqLabel =
    FREQUENCIES.find((f) => f.value === row.frequency)?.label ?? row.frequency;
  const parts = parseScheduleParts(row.start_on);
  if (row.frequency === 'daily') return freqLabel;
  if (row.frequency === 'weekly') {
    const dowLabel =
      WEEKDAYS.find((d) => d.value === parts.dayOfWeek)?.label ?? '';
    return `${freqLabel} · ${dowLabel}`;
  }
  if (row.frequency === 'monthly') {
    return `${freqLabel} · Ngày ${parts.dayOfMonth}`;
  }
  return `${freqLabel} · ${parts.dayOfMonth.padStart(2, '0')}/${parts.monthOfYear.padStart(2, '0')}`;
}

export function RecurringManager({ onClose }: { onClose(): void }) {
  const [rows, setRows] = useState<RecurringRow[]>([]),
    [wallets, setWallets] = useState<WalletRow[]>([]),
    [categories, setCategories] = useState<CategoryRow[]>([]);
  const [editing, setEditing] = useState<RecurringRow | null | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const working = useRef(false),
    newId = useRef('');
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const status = useRecurringStatus();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await withDatabase(async (db) => ({
        rows: await listRecurringRules(db),
        wallets: await listWallets(db, true),
        categories: await listCategories(db, true),
      }));
      setRows(next.rows);
      setWallets(next.wallets);
      setCategories(next.categories);
      setError('');
    } catch {
      setError(vi.recurringLoadError);
    } finally {
      setLoading(false);
    }
  }, []);
  const reload = useCallback(async () => {
    setLoading(true);
    await useApp.getState().refreshRecurring();
    await load();
  }, [load]);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  const leaveForm = useCallback(() => {
    if (working.current) return;
    setError('');
    setEditing(undefined);
  }, []);
  const back = useCallback(() => {
    if (working.current) return;
    if (editing !== undefined) {
      requestGuardLeave('recurring-form', leaveForm);
      return;
    }
    setError('');
    onClose();
  }, [editing, leaveForm, onClose]);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') return;
      const listener = BackHandler.addEventListener('hardwareBackPress', () => {
        back();
        return true;
      });
      return () => listener.remove();
    }, [back]),
  );
  async function mutate(action: (db: Database) => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    let committed = false;
    try {
      await withDatabase(async (db) => {
        await action(db);
        committed = true;
      });
      setEditing(undefined);
      useApp.setState((s) => ({ recurringVersion: s.recurringVersion + 1 }));
      await useApp.getState().refreshRecurring(true);
      await load();
    } catch {
      setError(committed ? vi.walletSavedRefreshFailed : vi.saveError);
      if (committed) setEditing(undefined);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  if (editing !== undefined)
    return (
      <RecurringForm
        key={editing?.id ?? 'new'}
        row={editing}
        wallets={wallets}
        categories={categories}
        busy={busy}
        error={error}
        onBack={leaveForm}
        onSave={(input) =>
          mutate((db) =>
            saveRecurringRule(
              db,
              editing?.id ?? newId.current,
              input,
              new Date().toISOString(),
              !!editing,
            ),
          )
        }
      />
    );
  return (
    <Screen
      title={vi.recurringTitle}
      subtitle={vi.recurringDescription}
      onBack={back}
      backDisabled={busy}
      headerRight={
        <IconButton
          icon="refresh"
          mode="contained-tonal"
          size={20}
          accessibilityLabel={vi.refresh}
          disabled={busy || loading}
          onPress={() => void reload()}
        />
      }
    >
      <Button
        hitSlop={4}
        mode="contained"
        icon="plus"
        contentStyle={styles.button}
        disabled={busy || loading}
        onPress={() => {
          newId.current = uuid.v4();
          setError('');
          setEditing(null);
        }}
      >
        {vi.recurringAdd}
      </Button>

      <View
        style={[
          styles.subtlePanel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        <View style={styles.row}>
          <View style={[styles.inlineRow, { flex: 1 }]}>
            <IconBadge
              icon="bell-ring-outline"
              bg={palette.tealSoft}
              fg={palette.tealInk}
              size={36}
              iconSize={18}
            />
            <Text
              variant="bodySmall"
              style={{ color: palette.textMuted, flex: 1 }}
            >
              {vi.recurringReminderHint}
            </Text>
          </View>
        </View>
        {status.permission === 'denied' && (
          <Text variant="bodySmall" style={{ color: palette.warningInk }}>
            {vi.recurringNotificationDenied}
          </Text>
        )}
        {status.permission === 'granted' && (
          <StatusPill
            icon="check-circle-outline"
            label={vi.recurringNotificationGranted}
            bg={palette.incomeSoft}
            fg={palette.incomeInk}
          />
        )}
        <Button
          hitSlop={4}
          compact
          mode="contained-tonal"
          disabled={busy || loading}
          onPress={async () => {
            if (working.current) return;
            working.current = true;
            setBusy(true);
            try {
              await requestRecurringNotifications();
            } finally {
              working.current = false;
              setBusy(false);
            }
          }}
        >
          {vi.recurringEnableNotifications}
        </Button>
      </View>

      {status.hasMore && (
        <Text variant="bodySmall" style={{ color: palette.warningInk }}>
          {vi.recurringMore}
        </Text>
      )}
      {(error || status.error) && (
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
            {error || vi.recurringRunError}
          </Text>
          <Button
            hitSlop={4}
            disabled={loading || busy}
            onPress={() => void reload()}
          >
            {vi.retry}
          </Button>
        </View>
      )}
      {loading && (
        <View style={{ paddingVertical: 28, alignItems: 'center' }}>
          <ActivityIndicator size="large" />
        </View>
      )}
      {!loading && !rows.length && (
        <EmptyStateCard
          icon="calendar-sync-outline"
          message={vi.recurringEmpty}
        />
      )}
      {rows.map((row) => (
        <View
          key={row.id}
          style={[
            styles.panel,
            { backgroundColor: palette.surface, borderColor: palette.border },
          ]}
        >
          <View style={styles.row}>
            <View style={[styles.inlineRow, { flex: 1 }]}>
              <IconBadge
                icon="calendar-sync-outline"
                bg={
                  !row.is_active
                    ? palette.surfaceMuted
                    : row.blocked
                      ? palette.warningSoft
                      : palette.tealSoft
                }
                fg={
                  !row.is_active
                    ? palette.textMuted
                    : row.blocked
                      ? palette.warningInk
                      : palette.tealInk
                }
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="titleMedium" style={{ fontWeight: '700' }}>
                  {row.note ||
                    KINDS.find((kind) => kind.value === row.kind)?.label}
                </Text>
                <Text variant="bodySmall" style={{ color: palette.textMuted }}>
                  {formatRecurringSummary(row)}
                </Text>
              </View>
            </View>
            <Text
              variant="titleMedium"
              style={[styles.number, { fontWeight: '700' }]}
            >
              {formatVnd(row.amount)}
            </Text>
          </View>

          <View style={styles.row}>
            <Text variant="bodySmall" style={{ color: palette.textMuted }}>
              {displayWalletName(
                wallets.find((wallet) => wallet.id === row.wallet_id)?.name,
              )}
              {row.to_wallet_id
                ? ` → ${wallets.find((wallet) => wallet.id === row.to_wallet_id)?.name ?? ''}`
                : ''}
            </Text>
            <StatusPill
              label={
                !row.is_active
                  ? vi.recurringPaused
                  : row.blocked
                    ? vi.recurringBlocked
                    : vi.recurringActive
              }
              bg={
                !row.is_active
                  ? palette.surfaceMuted
                  : row.blocked
                    ? palette.warningSoft
                    : palette.incomeSoft
              }
              fg={
                !row.is_active
                  ? palette.textMuted
                  : row.blocked
                    ? palette.warningInk
                    : palette.incomeInk
              }
            />
          </View>

          <Divider style={{ backgroundColor: palette.borderSubtle }} />

          <View style={[styles.row, { justifyContent: 'flex-end' }]}>
            <Button
              hitSlop={4}
              compact
              mode="contained-tonal"
              icon="pencil-outline"
              disabled={busy || loading}
              onPress={() => {
                setError('');
                setEditing(row);
              }}
            >
              {vi.recurringEdit}
            </Button>
            <Button
              hitSlop={4}
              compact
              mode="outlined"
              icon={row.is_active ? 'pause' : 'play'}
              disabled={busy || loading}
              onPress={() =>
                void mutate((db) =>
                  setRecurringActive(
                    db,
                    row.id,
                    !row.is_active,
                    localDate(),
                    new Date().toISOString(),
                  ),
                )
              }
            >
              {row.is_active ? vi.recurringPause : vi.recurringResume}
            </Button>
            <Button
              hitSlop={4}
              compact
              mode="text"
              textColor={colors.error}
              icon="trash-can-outline"
              accessibilityLabel={vi.recurringDelete}
              disabled={busy || loading}
              onPress={() => {
                const runDelete = () =>
                  void mutate((db) => deleteRecurringRule(db, row.id));
                if (Platform.OS === 'web') {
                  if (window.confirm(vi.recurringDeleteConfirm)) runDelete();
                  return;
                }
                Alert.alert(vi.recurringDelete, vi.recurringDeleteConfirm, [
                  { text: vi.cancel, style: 'cancel' },
                  {
                    text: vi.deleteTransaction,
                    style: 'destructive',
                    onPress: runDelete,
                  },
                ]);
              }}
            >
              {vi.deleteTransaction}
            </Button>
          </View>
        </View>
      ))}
    </Screen>
  );
}

interface Fields {
  kind: RecurringInput['kind'];
  amount: string;
  wallet: string;
  destination: string;
  category: string;
  note: string;
  frequency: RecurringInput['frequency'];
  dayOfWeek: string;
  dayOfMonth: string;
  monthOfYear: string;
}
function RecurringForm({
  row,
  wallets,
  categories,
  busy,
  error,
  onBack,
  onSave,
}: {
  row: RecurringRow | null;
  wallets: WalletRow[];
  categories: CategoryRow[];
  busy: boolean;
  error: string;
  onBack(): void;
  onSave(input: RecurringInput): Promise<void>;
}) {
  const [initialValues] = useState<Fields>(() => {
    const baseParts = parseScheduleParts(row?.start_on ?? localDate());
    return {
      kind: row?.kind ?? 'expense',
      amount: row ? formatAmountInput(String(row.amount)) : '',
      wallet: row?.wallet_id ?? wallets.find((w) => !w.is_archived)?.id ?? '',
      destination: row?.to_wallet_id ?? '',
      category: row?.category_id ?? '',
      note: row?.note ?? '',
      frequency: row?.frequency ?? 'monthly',
      dayOfWeek: baseParts.dayOfWeek,
      dayOfMonth: baseParts.dayOfMonth,
      monthOfYear: baseParts.monthOfYear,
    };
  });
  const {
    control,
    handleSubmit,
    getValues,
    setValue,
    formState: { isSubmitting },
  } = useForm<Fields>({
    defaultValues: initialValues,
  });
  const watched = useWatch({ control });
  const currentValues: Fields = {
    kind: watched.kind ?? initialValues.kind,
    amount: watched.amount ?? initialValues.amount,
    wallet: watched.wallet ?? initialValues.wallet,
    destination: watched.destination ?? initialValues.destination,
    category: watched.category ?? initialValues.category,
    note: watched.note ?? initialValues.note,
    frequency: watched.frequency ?? initialValues.frequency,
    dayOfWeek: watched.dayOfWeek ?? initialValues.dayOfWeek,
    dayOfMonth: watched.dayOfMonth ?? initialValues.dayOfMonth,
    monthOfYear: watched.monthOfYear ?? initialValues.monthOfYear,
  };
  const kind = currentValues.kind;
  const frequency = currentValues.frequency;
  const [invalid, setInvalid] = useState(false);
  const disabled = busy || isSubmitting;
  const relevantKeys: (keyof Fields)[] =
    kind === 'transfer'
      ? [
          'kind',
          'amount',
          'wallet',
          'destination',
          'note',
          'frequency',
          'dayOfWeek',
          'dayOfMonth',
          'monthOfYear',
        ]
      : [
          'kind',
          'amount',
          'wallet',
          'category',
          'note',
          'frequency',
          'dayOfWeek',
          'dayOfMonth',
          'monthOfYear',
        ];
  const dirty = haveFieldsChanged(initialValues, currentValues, {
    moneyKeys: ['amount'],
    keys: relevantKeys,
  });
  const { requestLeave, runGuardedSave } = useUnsavedChangesGuard({
    id: 'recurring-form',
    scope: 'tab',
    routeKey: 'transactions',
    dirty,
    saving: disabled,
    hasError: invalid || !!error,
    changeSignature: JSON.stringify(currentValues),
    onDiscard: onBack,
  });
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const walletOptions = useMemo(
    () =>
      wallets
        .filter((w) => !w.is_archived || w.id === row?.wallet_id)
        .map((w) => {
          const visual = walletKindVisual(w.kind, palette);
          return {
            value: w.id,
            label: displayWalletName(w.name),
            icon: visual.icon,
            iconBg: visual.bg,
            iconColor: visual.fg,
          };
        }),
    [wallets, row?.wallet_id, palette],
  );
  const destinationOptions = useMemo(
    () =>
      wallets
        .filter(
          (w) =>
            w.id !== currentValues.wallet &&
            (!w.is_archived || w.id === row?.to_wallet_id),
        )
        .map((w) => {
          const visual = walletKindVisual(w.kind, palette);
          return {
            value: w.id,
            label: displayWalletName(w.name),
            icon: visual.icon,
            iconBg: visual.bg,
            iconColor: visual.fg,
          };
        }),
    [wallets, currentValues.wallet, row?.to_wallet_id, palette],
  );
  const categoryOptions = useMemo(
    () => [
      {
        value: '',
        label: vi.recurringUncategorized,
        icon: 'help-circle-outline',
        iconBg: palette.surfaceMuted,
        iconColor: palette.textMuted,
      },
      ...orderCategoriesByParent(
        categories.filter(
          (c) =>
            c.kind === kind && (!c.is_archived || c.id === row?.category_id),
        ),
      ).map((c) => {
        const isExpense = c.kind === 'expense';
        const parent = c.parent_id
          ? categories.find((p) => p.id === c.parent_id)
          : null;
        return {
          value: c.id,
          label: displayCategoryName(c.name),
          icon: c.icon || 'tag-outline',
          iconBg: isExpense ? palette.expenseSoft : palette.incomeSoft,
          iconColor:
            c.color || (isExpense ? palette.expenseInk : palette.incomeInk),
          subtitle: parent ? displayCategoryName(parent.name) : undefined,
        };
      }),
    ],
    [categories, kind, row?.category_id, palette],
  );
  const frequencyOptions = useMemo(
    () =>
      FREQUENCIES.map((freq) => ({
        value: freq.value,
        label: freq.label,
        icon: 'repeat',
        iconBg: palette.primarySoft,
        iconColor: palette.primaryInk,
      })),
    [palette],
  );
  const footer = <></>;
  return (
    <Screen
      title={row ? vi.recurringEdit : vi.recurringAdd}
      onBack={requestLeave}
      backDisabled={disabled}
      footer={footer}
    >
      <View
        style={[
          styles.panel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        <Controller
          control={control}
          name="kind"
          render={({ field }) => (
            <SegmentedOptionPicker
              label={vi.transactionKind}
              value={field.value}
              disabled={disabled}
              options={KINDS}
              onSelect={(value) => {
                field.onChange(value);
                setValue('category', '');
                setValue('destination', '');
              }}
            />
          )}
        />
        <Controller
          control={control}
          name="wallet"
          rules={{
            validate: (value) => !!value || vi.transactionWalletRequired,
          }}
          render={({ field, fieldState }) => (
            <FieldFeedback
              fieldRef={field.ref}
              message={fieldState.error?.message}
            >
              <AppleMenuPicker
                label={
                  kind === 'transfer'
                    ? vi.transactionSourceWallet
                    : vi.transactionWallet
                }
                value={field.value}
                options={walletOptions}
                disabled={disabled}
                placeholder={vi.recurringChoose}
                onSelect={(value) => {
                  field.onChange(value);
                  if (getValues('destination') === value) {
                    setValue('destination', '');
                  }
                }}
              />
            </FieldFeedback>
          )}
        />
        {kind === 'transfer' ? (
          <Controller
            control={control}
            name="destination"
            rules={{
              validate: (value) =>
                getValues('kind') !== 'transfer' ||
                (!!value && value !== getValues('wallet')) ||
                vi.formDestinationInvalid,
            }}
            render={({ field, fieldState }) => (
              <FieldFeedback
                fieldRef={field.ref}
                message={fieldState.error?.message}
              >
                <AppleMenuPicker
                  label={vi.transactionDestination}
                  value={field.value}
                  options={destinationOptions}
                  disabled={disabled}
                  placeholder={vi.recurringChoose}
                  onSelect={field.onChange}
                />
              </FieldFeedback>
            )}
          />
        ) : (
          <Controller
            control={control}
            name="category"
            render={({ field }) => (
              <AppleMenuPicker
                label={vi.transactionCategory}
                value={field.value}
                options={categoryOptions}
                disabled={disabled}
                placeholder={vi.recurringChoose}
                onSelect={field.onChange}
              />
            )}
          />
        )}
        <Controller
          control={control}
          name="frequency"
          render={({ field }) => (
            <AppleMenuPicker
              label={vi.recurringFrequency}
              value={field.value}
              options={frequencyOptions}
              disabled={disabled}
              onSelect={field.onChange}
            />
          )}
        />
      </View>

      <View
        style={[
          styles.panel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
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
                label={vi.transactionAmount}
                accessibilityLabel={vi.transactionAmount}
                value={field.value}
                onBlur={field.onBlur}
                disabled={disabled}
                left={<TextInput.Icon icon="cash" />}
                onChangeText={field.onChange}
              />
            </FieldFeedback>
          )}
        />
        {frequency === 'weekly' && (
          <Controller
            control={control}
            name="dayOfWeek"
            render={({ field }) => (
              <AppleMenuPicker
                label={vi.recurringDayOfWeek}
                value={field.value}
                options={WEEKDAYS.map((item) => ({
                  value: item.value,
                  label: item.label,
                  icon: 'calendar-week',
                  iconBg: palette.primarySoft,
                  iconColor: palette.primaryInk,
                }))}
                disabled={disabled}
                onSelect={field.onChange}
              />
            )}
          />
        )}
        {frequency === 'monthly' && (
          <Controller
            control={control}
            name="dayOfMonth"
            render={({ field }) => (
              <AppleMenuPicker
                label={vi.recurringDayOfMonth}
                value={field.value}
                options={Array.from({ length: 31 }, (_, index) => ({
                  value: String(index + 1),
                  label: `Ngày ${index + 1}`,
                  icon: 'calendar-month',
                  iconBg: palette.primarySoft,
                  iconColor: palette.primaryInk,
                }))}
                disabled={disabled}
                onSelect={field.onChange}
              />
            )}
          />
        )}
        {frequency === 'yearly' && (
          <View style={{ gap: 12 }}>
            <Controller
              control={control}
              name="monthOfYear"
              render={({ field }) => (
                <AppleMenuPicker
                  label={vi.recurringMonthOfYear}
                  value={field.value}
                  options={MONTHS.map((item) => ({
                    value: item.value,
                    label: item.label,
                    icon: 'calendar',
                    iconBg: palette.primarySoft,
                    iconColor: palette.primaryInk,
                  }))}
                  disabled={disabled}
                  onSelect={(nextMonth) => {
                    field.onChange(nextMonth);
                    const maxDay = daysInMonth(2024, Number(nextMonth) || 1);
                    if (Number(getValues('dayOfMonth')) > maxDay) {
                      setValue('dayOfMonth', String(maxDay));
                    }
                  }}
                />
              )}
            />
            <Controller
              control={control}
              name="dayOfMonth"
              render={({ field }) => {
                const maxDay = daysInMonth(
                  2024,
                  Number(currentValues.monthOfYear) || 1,
                );
                return (
                  <AppleMenuPicker
                    label={vi.recurringDayOfMonth}
                    value={field.value}
                    options={Array.from({ length: maxDay }, (_, index) => ({
                      value: String(index + 1),
                      label: `Ngày ${index + 1}`,
                      icon: 'calendar-today',
                      iconBg: palette.primarySoft,
                      iconColor: palette.primaryInk,
                    }))}
                    disabled={disabled}
                    onSelect={field.onChange}
                  />
                );
              }}
            />
          </View>
        )}
        <Controller
          control={control}
          name="note"
          render={({ field }) => (
            <FocusAwareTextInput
              mode="outlined"
              label={vi.transactionNote}
              accessibilityLabel={vi.transactionNote}
              value={field.value}
              onBlur={field.onBlur}
              disabled={disabled}
              left={<TextInput.Icon icon="note-text-outline" />}
              keyboardType="default"
              onChangeText={field.onChange}
            />
          )}
        />
        {row && row.interval_count > 1 && (
          <Text variant="bodySmall" style={{ color: palette.textMuted }}>
            {vi.recurringLegacyHint}: {row.interval_count}{' '}
            {vi.recurringLegacyInterval}
          </Text>
        )}
      </View>

      {(invalid || error) && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error || vi.recurringInvalid}
        </Text>
      )}
      <Button
        hitSlop={4}
        mode="contained"
        icon="check"
        contentStyle={styles.button}
        disabled={disabled}
        loading={disabled}
        onPress={() =>
          void handleSubmit(async (fields) => {
            let input: RecurringInput;
            try {
              input = RecurringInputSchema.parse({
                kind: fields.kind,
                amount: parseAmountInput(fields.amount),
                walletId: fields.wallet,
                toWalletId:
                  fields.kind === 'transfer' ? fields.destination : null,
                categoryId:
                  fields.kind === 'transfer' ? null : fields.category || null,
                note: fields.note,
                frequency: fields.frequency,
                intervalCount: row?.interval_count ?? 1,
                startOn: computeStartOnFromSchedule(
                  fields.frequency,
                  fields.dayOfWeek,
                  fields.dayOfMonth,
                  fields.monthOfYear,
                  localDate(),
                ),
                endOn: null,
              });
            } catch {
              setInvalid(true);
              return;
            }
            setInvalid(false);
            await runGuardedSave(() => onSave(input));
          })()
        }
      >
        {vi.recurringSave}
      </Button>
    </Screen>
  );
}
