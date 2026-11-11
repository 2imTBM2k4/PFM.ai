import { FieldFeedback } from '@/components/field-feedback';
import { amountError, dateError } from '@/utils/form-validation';
import { uuid } from 'expo';
import { useFocusEffect } from 'expo-router';
import { goalProgress, today } from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import { GoalInputSchema, type GoalInput } from '@pfm/contracts';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { haveFieldsChanged, requestGuardLeave } from '@/utils/unsaved-changes';
import { BackHandler, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Divider,
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
import { AppleMenuPicker, DateField, MoneyInput } from '@/components/ui';
import { useFinancePalette, walletKindVisual } from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import {
  archiveGoal,
  restoreGoal,
  listGoals,
  saveGoal,
  type GoalRow,
} from '@/data/goals';
import { listWallets, type WalletRow } from '@/data/repository';
import type { Database } from '@/data/migrate';
import {
  formatAmountInput,
  parseAmountInput,
} from '@/features/transactions/form';
import { vi } from '@/messages/vi';
import { displayWalletName } from '@/messages/seed-labels';
import { formatDisplayDate } from '@/utils/display';
import { useApp } from '@/state/app';

export function GoalManager({
  onClose,
  onSwitchTab,
  guardRouteKey = 'budgets',
}: {
  onClose?(): void;
  onSwitchTab?(tab: 'budgets' | 'goals' | 'stats'): void;
  guardRouteKey?: string;
} = {}) {
  const [rows, setRows] = useState<GoalRow[]>([]);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [editing, setEditing] = useState<GoalRow | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [archived, setArchived] = useState(false);
  const working = useRef(false),
    newId = useRef('');
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const recurringVersion = useApp((state) => state.recurringVersion);
  const refresh = useCallback(async () => {
    return withDatabase(async (db) => ({
      goals: await listGoals(db),
      wallets: await listWallets(db, true),
    }));
  }, []);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setLoading(true);
      refresh()
        .then((next) => {
          if (!cancelled) {
            setRows(next.goals);
            setWallets(next.wallets);
            setError('');
          }
        })
        .catch(() => {
          if (!cancelled) setError(vi.goalLoadError);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Automatic entries can change the linked wallet balance.
    }, [refresh, recurringVersion]),
  );
  const leaveForm = useCallback(() => {
    if (working.current) return;
    setError('');
    setEditing(undefined);
  }, []);
  const back = useCallback(() => {
    if (working.current) return;
    if (editing !== undefined) {
      requestGuardLeave('goal-form', leaveForm);
      return;
    }
    setError('');
    onClose?.();
  }, [editing, leaveForm, onClose]);
  useFocusEffect(
    useCallback(() => {
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
      const next = await withDatabase(async (db) => {
        await action(db);
        committed = true;
        return {
          goals: await listGoals(db),
          wallets: await listWallets(db, true),
        };
      });
      setRows(next.goals);
      setWallets(next.wallets);
      setEditing(undefined);
    } catch {
      setError(committed ? vi.goalRefreshError : vi.saveError);
      if (committed) setEditing(undefined);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  if (editing !== undefined)
    return (
      <GoalForm
        key={editing?.id ?? 'new'}
        row={editing}
        wallets={wallets}
        busy={busy}
        error={error}
        guardRouteKey={guardRouteKey}
        onBack={leaveForm}
        onSave={(input) =>
          mutate((db) =>
            saveGoal(
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
  const date = today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' });
  const visibleGoals = rows.filter(
    (row) => (row.status === 'archived') === archived,
  );
  return (
    <Screen
      title={vi.goals}
      onBack={editing !== undefined || onClose ? back : undefined}
      backDisabled={busy}
      headerRight={
        editing === undefined ? (
          <Button
            mode="contained"
            icon="plus"
            disabled={busy || loading}
            contentStyle={styles.compactButton}
            onPress={() => {
              newId.current = uuid.v4();
              setError('');
              setEditing(null);
            }}
          >
            {vi.addGoal}
          </Button>
        ) : undefined
      }
    >
      {!!onSwitchTab && editing === undefined && (
        <SegmentedButtons
          value="goals"
          density="small"
          onValueChange={(value) =>
            onSwitchTab(value as 'budgets' | 'goals' | 'stats')
          }
          buttons={[
            {
              value: 'stats',
              label: vi.statsTabTitle,
              showSelectedCheck: false,
              labelStyle: { fontSize: 13, fontWeight: '700' },
            },
            {
              value: 'budgets',
              label: vi.budgetsTabTitle,
              showSelectedCheck: false,
              labelStyle: { fontSize: 13, fontWeight: '700' },
            },
            {
              value: 'goals',
              label: vi.goals,
              showSelectedCheck: false,
              labelStyle: { fontSize: 13, fontWeight: '700' },
            },
          ]}
        />
      )}
      <SegmentedButtons
        value={archived ? 'archived' : 'active'}
        onValueChange={(value) => setArchived(value === 'archived')}
        buttons={[
          { value: 'active', label: vi.goalShowActive, disabled: busy },
          { value: 'archived', label: vi.goalShowArchived, disabled: busy },
        ]}
      />

      {loading && (
        <View style={{ paddingVertical: 28, alignItems: 'center' }}>
          <ActivityIndicator size="large" />
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
          <Button
            disabled={busy || loading}
            onPress={() => {
              setLoading(true);
              refresh()
                .then((next) => {
                  setRows(next.goals);
                  setWallets(next.wallets);
                  setError('');
                })
                .catch(() => setError(vi.goalLoadError))
                .finally(() => setLoading(false));
            }}
          >
            {vi.retry}
          </Button>
        </View>
      )}

      {!loading && !visibleGoals.length && (
        <EmptyStateCard icon="bullseye-arrow" message={vi.goalEmpty} />
      )}

      {visibleGoals.map((row) => {
        const progress = goalProgress(
          row.target_amount,
          row.progress,
          date,
          row.deadline_on,
        );
        const ratio = Math.max(
          0,
          Math.min(1, row.progress / row.target_amount),
        );
        const pct = Math.round(ratio * 100);
        return (
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
                  icon={progress.achieved ? 'trophy-outline' : 'bullseye-arrow'}
                  bg={progress.achieved ? palette.incomeSoft : palette.tealSoft}
                  fg={progress.achieved ? palette.incomeInk : palette.tealInk}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="titleMedium" style={{ fontWeight: '700' }}>
                    {row.name}
                  </Text>
                  <Text
                    variant="bodySmall"
                    style={{ color: palette.textMuted }}
                  >
                    {row.wallet_name
                      ? `${vi.goalWallet}: ${row.wallet_name}`
                      : vi.goalManual}
                  </Text>
                </View>
              </View>
              <StatusPill
                icon={progress.achieved ? 'check-circle' : undefined}
                label={progress.achieved ? vi.goalAchieved : `${pct}%`}
                bg={
                  progress.achieved ? palette.incomeSoft : palette.primarySoft
                }
                fg={progress.achieved ? palette.incomeInk : palette.primaryInk}
              />
            </View>

            <View style={styles.row}>
              <Text
                variant="titleMedium"
                style={[styles.number, { fontWeight: '700' }]}
              >
                {formatVnd(row.progress)}
              </Text>
              <Text
                variant="bodyMedium"
                style={[styles.number, { color: palette.textMuted }]}
              >
                / {formatVnd(row.target_amount)}
              </Text>
            </View>

            <ProgressBar
              progress={ratio}
              color={progress.achieved ? palette.income : colors.primary}
              style={{ height: 8, borderRadius: 4 }}
              accessibilityLabel={vi.goalProgress}
            />

            <View style={styles.row}>
              {row.deadline_on && (
                <Text variant="bodySmall" style={{ color: palette.textMuted }}>
                  {vi.goalDeadline}: {formatDisplayDate(row.deadline_on)}
                </Text>
              )}
              {!progress.achieved && (
                <Text
                  variant="bodySmall"
                  style={{ color: palette.textMuted, fontWeight: '500' }}
                >
                  {progress.requiredPerMonth === null
                    ? vi.goalNoDeadline
                    : `${vi.goalMonthly}: ${formatVnd(progress.requiredPerMonth)}`}
                </Text>
              )}
            </View>

            <Divider style={{ backgroundColor: palette.borderSubtle }} />

            {archived ? (
              <Button
                mode="contained-tonal"
                icon="restore"
                disabled={busy}
                contentStyle={styles.button}
                onPress={() =>
                  void mutate((db) =>
                    restoreGoal(db, row.id, new Date().toISOString()),
                  )
                }
              >
                {vi.restoreGoal}
              </Button>
            ) : (
              <View style={[styles.row, { justifyContent: 'flex-end' }]}>
                <Button
                  compact
                  mode="contained-tonal"
                  icon="pencil-outline"
                  disabled={busy}
                  onPress={() => {
                    setError('');
                    setEditing(row);
                  }}
                >
                  {vi.editGoal}
                </Button>
                <Button
                  compact
                  mode="text"
                  icon="archive-arrow-down-outline"
                  disabled={busy}
                  onPress={() =>
                    void mutate((db) =>
                      archiveGoal(db, row.id, new Date().toISOString()),
                    )
                  }
                >
                  {vi.archiveGoal}
                </Button>
              </View>
            )}
          </View>
        );
      })}
    </Screen>
  );
}

interface Fields {
  name: string;
  target: string;
  manual: string;
  deadline: string;
  wallet: string;
}
function GoalForm({
  row,
  wallets,
  busy,
  error,
  guardRouteKey,
  onBack,
  onSave,
}: {
  row: GoalRow | null;
  wallets: WalletRow[];
  busy: boolean;
  error: string;
  guardRouteKey: string;
  onBack(): void;
  onSave(input: GoalInput): Promise<void>;
}) {
  const [initialValues] = useState<Fields>(() => ({
    name: row?.name ?? '',
    target: row ? formatAmountInput(String(row.target_amount)) : '',
    manual: formatAmountInput(String(row?.manual_saved_amount ?? 0)),
    deadline: row?.deadline_on ?? '',
    wallet: row?.funding_wallet_id ?? '',
  }));
  const {
    control,
    handleSubmit,
    getValues,
    formState: { isSubmitting },
  } = useForm<Fields>({
    defaultValues: initialValues,
  });
  const [invalid, setInvalid] = useState(false);
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const sourceOptions = useMemo(
    () => [
      {
        value: '',
        label: vi.goalManual,
        icon: 'piggy-bank-outline',
        iconBg: palette.primarySoft,
        iconColor: palette.primaryInk,
      },
      ...wallets
        .filter(
          (wallet) =>
            !wallet.is_archived || wallet.id === row?.funding_wallet_id,
        )
        .map((wallet) => {
          const visual = walletKindVisual(wallet.kind, palette);
          return {
            value: wallet.id,
            label: displayWalletName(wallet.name),
            icon: visual.icon,
            iconBg: visual.bg,
            iconColor: visual.fg,
          };
        }),
    ],
    [wallets, row?.funding_wallet_id, palette],
  );
  const watched = useWatch({ control });
  const currentValues: Fields = {
    name: watched.name ?? initialValues.name,
    target: watched.target ?? initialValues.target,
    manual: watched.manual ?? initialValues.manual,
    deadline: watched.deadline ?? initialValues.deadline,
    wallet: watched.wallet ?? initialValues.wallet,
  };
  const walletId = currentValues.wallet,
    disabled = busy || isSubmitting;
  const relevantKeys: (keyof Fields)[] = walletId
    ? ['name', 'target', 'deadline', 'wallet']
    : ['name', 'target', 'manual', 'deadline', 'wallet'];
  const dirty = haveFieldsChanged(initialValues, currentValues, {
    moneyKeys: ['target', 'manual'],
    keys: relevantKeys,
  });
  const { requestLeave, runGuardedSave } = useUnsavedChangesGuard({
    id: 'goal-form',
    scope: 'tab',
    routeKey: guardRouteKey,
    dirty,
    saving: disabled,
    hasError: invalid || !!error,
    changeSignature: JSON.stringify(currentValues),
    onDiscard: onBack,
  });
  const footer = (
    <>
      {(invalid || error) && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error || vi.goalInvalid}
        </Text>
      )}
      <Button
        mode="contained"
        icon="check"
        contentStyle={styles.button}
        loading={disabled}
        disabled={disabled}
        onPress={() =>
          void handleSubmit(async (fields) => {
            let input: GoalInput;
            try {
              input = GoalInputSchema.parse({
                name: fields.name,
                targetAmount: parseAmountInput(fields.target),
                manualSavedAmount: fields.wallet
                  ? (row?.manual_saved_amount ?? 0)
                  : fields.manual === '0'
                    ? 0
                    : parseAmountInput(fields.manual),
                fundingWalletId: fields.wallet || null,
                deadlineOn: fields.deadline.trim() || null,
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
        {vi.saveGoal}
      </Button>
    </>
  );
  return (
    <Screen
      title={row ? vi.editGoal : vi.addGoal}
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
        {(
          [
            { name: 'name', label: vi.goalName, icon: 'bullseye-arrow' },
            { name: 'target', label: vi.goalTarget, icon: 'cash' },
            { name: 'deadline', label: vi.goalDeadline, icon: 'calendar' },
          ] as const
        ).map((item) => (
          <Controller
            key={item.name}
            control={control}
            name={item.name}
            rules={{
              validate: (value) =>
                item.name === 'name'
                  ? !!value.trim() || vi.formRequired
                  : item.name === 'target'
                    ? amountError(value)
                    : dateError(value, true),
            }}
            render={({ field, fieldState }) => (
              <FieldFeedback
                fieldRef={field.ref}
                message={fieldState.error?.message}
              >
                {item.name === 'deadline' ? (
                  <DateField
                    error={!!fieldState.error}
                    label={item.label}
                    value={field.value}
                    onChange={field.onChange}
                    disabled={disabled}
                    allowClear
                  />
                ) : item.name === 'target' ? (
                  <MoneyInput
                    error={!!fieldState.error}
                    label={item.label}
                    accessibilityLabel={item.label}
                    value={field.value}
                    disabled={disabled}
                    onBlur={field.onBlur}
                    left={<TextInput.Icon icon={item.icon} />}
                    onChangeText={field.onChange}
                  />
                ) : (
                  <TextInput
                    error={!!fieldState.error}
                    mode="outlined"
                    label={item.label}
                    accessibilityLabel={item.label}
                    value={field.value}
                    disabled={disabled}
                    onBlur={field.onBlur}
                    left={<TextInput.Icon icon={item.icon} />}
                    keyboardType="default"
                    onChangeText={field.onChange}
                  />
                )}
              </FieldFeedback>
            )}
          />
        ))}
        <Text variant="bodySmall" style={{ color: palette.textMuted }}>
          {vi.goalDeadlineHint}
        </Text>
      </View>

      <View
        style={[
          styles.panel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        <Controller
          control={control}
          name="wallet"
          render={({ field, fieldState }) => (
            <FieldFeedback
              fieldRef={field.ref}
              message={fieldState.error?.message}
            >
              <AppleMenuPicker
                label={vi.goalSource}
                value={field.value}
                options={sourceOptions}
                disabled={disabled}
                onSelect={field.onChange}
              />
            </FieldFeedback>
          )}
        />
        {!walletId && (
          <Controller
            control={control}
            name="manual"
            rules={{
              validate: (value) =>
                !!getValues('wallet') || amountError(value, { zero: true }),
            }}
            render={({ field, fieldState }) => (
              <FieldFeedback
                fieldRef={field.ref}
                message={fieldState.error?.message}
              >
                <MoneyInput
                    error={!!fieldState.error}
                    label={vi.goalManual}
                    accessibilityLabel={vi.goalManual}
                    value={field.value}
                    disabled={disabled}
                    onBlur={field.onBlur}
                    left={<TextInput.Icon icon="piggy-bank-outline" />}
                    onChangeText={field.onChange}
                  />
              </FieldFeedback>
            )}
          />
        )}
        <Text variant="bodySmall" style={{ color: palette.textMuted }}>
          {vi.goalSourceHint}
        </Text>
      </View>


    </Screen>
  );
}
