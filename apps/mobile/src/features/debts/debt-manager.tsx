import SegmentedButtons from '@/components/ui/native-segmented-buttons';
import { useTransientState } from '@/hooks/use-transient-state';
import {
  FieldFeedback,
  FocusAwareTextInput,
} from '@/components/field-feedback';
import { dateError, repaymentError } from '@/utils/form-validation';
import { uuid } from 'expo';
import { useFocusEffect } from 'expo-router';
import { today } from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import {
  DebtChangesSchema,
  DebtInputSchema,
  DebtRepaymentSchema,
  type DebtChanges,
  type DebtInput,
  type DebtRepayment,
} from '@pfm/contracts';
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
  DateField,
  MoneyInput,
  SegmentedOptionPicker,
} from '@/components/ui';
import { useFinancePalette, walletKindVisual } from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import {
  createDebt,
  listDebts,
  repayDebt,
  updateDebt,
  type DebtRow,
} from '@/data/debts';
import { listWallets, type WalletRow } from '@/data/repository';
import {
  deleteTransaction,
  listTransactions,
  undoDeleteTransaction,
  updateTransaction,
  type TransactionRow,
} from '@/data/transactions';
import type { Database } from '@/data/migrate';
import { TransactionForm } from '@/features/transactions/transaction-manager';
import { isFutureDate, parseAmountInput } from '@/features/transactions/form';
import {
  requestRecurringNotifications,
  useRecurringStatus,
} from '@/features/recurring/mobile';
import { vi } from '@/messages/vi';
import { displayWalletName } from '@/messages/seed-labels';
import { formatDisplayDate } from '@/utils/display';
import { useApp } from '@/state/app';
import { DEBT_KIND_LABELS } from './labels';

type Submission =
  | { type: 'create'; value: DebtInput }
  | { type: 'metadata'; value: DebtChanges }
  | { type: 'repay'; value: DebtRepayment };
export function DebtManager({ onClose }: { onClose(): void }) {
  const [rows, setRows] = useState<DebtRow[]>([]),
    [wallets, setWallets] = useState<WalletRow[]>([]),
    [history, setHistory] = useState<TransactionRow[]>([]);
  const [selected, setSelected] = useState<DebtRow | null>(null),
    [editing, setEditing] = useState<
      Submission['type'] | TransactionRow | null
    >(null);
  const [loading, setLoading] = useState(true),
    [more, setMore] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [closed, setClosed] = useState(false),
    [undo, setUndo] = useTransientState<TransactionRow | null>(null);
  const working = useRef(false),
    focused = useRef(false),
    request = useRef(0),
    ids = useRef({ debt: '', transaction: '' });
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const status = useRecurringStatus();
  const selectedId = selected?.id;
  const load = useCallback(async () => {
    const token = ++request.current;
    setLoading(true);
    try {
      const next = await withDatabase(async (db) => ({
        debts: await listDebts(db),
        wallets: await listWallets(db, true),
        history: selectedId
          ? await listTransactions(db, undefined, { debtId: selectedId })
          : [],
      }));
      if (token !== request.current) return;
      setRows(next.debts);
      setWallets(next.wallets);
      setHistory(next.history);
      setMore(next.history.length === 50);
      if (selectedId)
        setSelected(next.debts.find((row) => row.id === selectedId) ?? null);
    } catch {
      if (token === request.current) setError(vi.debtLoadError);
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, [selectedId]);
  async function loadMore() {
    const token = request.current;
    if (working.current || loading || !selectedId || !history.length) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const page = await withDatabase((db) =>
        listTransactions(db, history.at(-1), { debtId: selectedId }),
      );
      if (token !== request.current) return;
      setHistory((current) => [
        ...current,
        ...page.filter((row) => !current.some((old) => old.id === row.id)),
      ]);
      setMore(page.length === 50);
    } catch {
      setError(vi.debtLoadError);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void load();
      return () => {
        focused.current = false;
        request.current++;
        setUndo(null);
      };
    }, [load, setUndo]),
  );
  const leaveEditForm = useCallback(() => {
    if (working.current) return;
    setError('');
    setUndo(null);
    setEditing(null);
  }, [setUndo]);
  const back = useCallback(() => {
    if (working.current) return;
    if (editing && typeof editing === 'object') {
      requestGuardLeave('transaction-form', leaveEditForm);
      return;
    }
    if (typeof editing === 'string') {
      requestGuardLeave('debt-form', leaveEditForm);
      return;
    }
    setError('');
    setUndo(null);
    if (selected) setSelected(null);
    else onClose();
  }, [editing, leaveEditForm, selected, onClose, setUndo]);
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
  async function mutate(
    action: (db: Database) => Promise<TransactionRow | void>,
  ) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    let committed = false;
    try {
      const deleted = await withDatabase(async (db) => {
        const result = await action(db);
        committed = true;
        return result;
      });
      setUndo(focused.current ? (deleted ?? null) : null);
      setEditing(null);
      useApp.setState((s) => ({ recurringVersion: s.recurringVersion + 1 }));
      await useApp.getState().refreshRecurring(true);
      await load();
    } catch (failure) {
      setError(
        committed
          ? vi.walletSavedRefreshFailed
          : failure instanceof Error && failure.message.startsWith('DEBT_')
            ? vi.debtInvalidBalance
            : failure instanceof Error && failure.message.startsWith('WALLET_')
              ? vi.transactionReferencesInvalid
              : vi.saveError,
      );
      if (committed) setEditing(null);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  if (editing && typeof editing === 'object')
    return (
      <TransactionForm
        row={editing}
        wallets={wallets}
        categories={[]}
        busy={busy}
        error={error}
        onBack={leaveEditForm}
        onSave={(input) =>
          mutate((db) =>
            updateTransaction(
              db,
              editing.id,
              input,
              new Date().toISOString(),
              editing.updated_at,
            ),
          )
        }
      />
    );
  if (typeof editing === 'string')
    return (
      <DebtForm
        key={editing}
        mode={editing}
        debt={selected}
        wallets={wallets}
        busy={busy}
        error={error}
        onBack={leaveEditForm}
        onSave={(submission) =>
          mutate((db) => {
            const timestamp = new Date().toISOString();
            if (submission.type === 'create')
              return createDebt(
                db,
                ids.current.debt,
                ids.current.transaction,
                submission.value,
                timestamp,
              );
            if (!selected) throw new Error('DEBT_NOT_FOUND');
            return submission.type === 'metadata'
              ? updateDebt(db, selected.id, submission.value, timestamp)
              : repayDebt(
                  db,
                  selected.id,
                  ids.current.transaction,
                  submission.value,
                  timestamp,
                );
          })
        }
      />
    );

  const visibleDebts = rows.filter(
    (row) => (row.status === 'closed') === closed,
  );

  return (
    <Screen
      title={selected ? selected.counterparty_label : vi.debtsTitle}
      subtitle={!selected ? vi.debtDescription : undefined}
      onBack={back}
      backDisabled={busy}
      headerRight={
        <IconButton
          icon="refresh"
          mode="contained-tonal"
          size={20}
          accessibilityLabel={vi.refresh}
          disabled={loading || busy}
          onPress={() => {
            setError('');
            void load();
          }}
        />
      }
    >
      {loading && (
        <View style={{ paddingVertical: 24, alignItems: 'center' }}>
          <ActivityIndicator size="large" />
        </View>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}
      {undo && (
        <View
          style={[
            styles.subtlePanel,
            {
              backgroundColor: palette.warningSoft,
              borderColor: palette.warning,
            },
          ]}
        >
          <Button
            hitSlop={4}
            mode="contained-tonal"
            disabled={busy || loading}
            onPress={() => void mutate((db) => undoDeleteTransaction(db, undo))}
          >
            {vi.transactionUndo}
          </Button>
        </View>
      )}
      {selected ? (
        <>
          <View
            style={[
              styles.panel,
              { backgroundColor: palette.surface, borderColor: palette.border },
            ]}
          >
            <View style={styles.row}>
              <StatusPill
                icon="handshake-outline"
                label={
                  selected.direction === 'borrowed'
                    ? vi.debtBorrowed
                    : vi.debtLent
                }
                bg={
                  selected.direction === 'borrowed'
                    ? palette.warningSoft
                    : palette.primarySoft
                }
                fg={
                  selected.direction === 'borrowed'
                    ? palette.warningInk
                    : palette.primaryInk
                }
              />
              <StatusPill
                label={
                  selected.status === 'closed' ? vi.debtClosed : vi.debtOpen
                }
                bg={
                  selected.status === 'closed'
                    ? palette.incomeSoft
                    : palette.surfaceMuted
                }
                fg={
                  selected.status === 'closed'
                    ? palette.incomeInk
                    : palette.textMuted
                }
              />
            </View>

            <View style={{ gap: 4 }}>
              <Text variant="labelLarge" style={{ color: palette.textMuted }}>
                {vi.debtOutstanding}
              </Text>
              <Text
                variant="headlineMedium"
                style={[styles.number, { fontWeight: '700' }]}
              >
                {formatVnd(selected.outstanding)}
              </Text>
            </View>

            <Text
              variant="bodyMedium"
              style={[styles.number, { color: palette.textMuted }]}
            >
              {vi.debtPrincipal}: {formatVnd(selected.principal)} ·{' '}
              {vi.debtRepaid}: {formatVnd(selected.repaid)}
            </Text>

            {selected.due_on && (
              <Text variant="bodySmall" style={{ color: palette.textMuted }}>
                {vi.debtDue}: {formatDisplayDate(selected.due_on)}
              </Text>
            )}
            {!!selected.note && <Text>{selected.note}</Text>}

            <Divider style={{ backgroundColor: palette.borderSubtle }} />

            <View style={styles.row}>
              <Button
                hitSlop={4}
                mode="outlined"
                icon="pencil-outline"
                contentStyle={styles.compactButton}
                disabled={busy || loading}
                onPress={() => {
                  setError('');
                  setEditing('metadata');
                }}
              >
                {vi.debtEdit}
              </Button>
              <Button
                hitSlop={4}
                mode="contained"
                icon="cash-check"
                contentStyle={styles.compactButton}
                disabled={busy || loading || selected.outstanding <= 0}
                onPress={() => {
                  ids.current.transaction = uuid.v4();
                  setError('');
                  setEditing('repay');
                }}
              >
                {selected.direction === 'borrowed'
                  ? vi.debtRepayPaid
                  : vi.debtRepayReceived}
              </Button>
            </View>
          </View>

          <Text
            accessibilityRole="header"
            variant="titleMedium"
            style={{ fontWeight: '700' }}
          >
            {vi.debtHistory}
          </Text>
          {history.map((row) => (
            <View
              key={row.id}
              style={[
                styles.panel,
                {
                  backgroundColor: palette.surface,
                  borderColor: palette.border,
                  padding: 16,
                },
              ]}
            >
              <View style={styles.row}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="titleSmall" style={{ fontWeight: '700' }}>
                    {DEBT_KIND_LABELS[row.kind]}
                  </Text>
                  <Text
                    variant="bodySmall"
                    style={{ color: palette.textMuted }}
                  >
                    {formatDisplayDate(row.occurred_on)} ·{' '}
                    {
                      wallets.find((wallet) => wallet.id === row.wallet_id)
                        ?.name
                    }
                  </Text>
                </View>
                <Text
                  variant="titleMedium"
                  style={[styles.number, { fontWeight: '700' }]}
                >
                  {formatVnd(row.amount)}
                </Text>
              </View>
              {!!row.note && <Text>{row.note}</Text>}
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
                  {vi.editTransaction}
                </Button>
                <Button
                  hitSlop={4}
                  compact
                  mode="text"
                  textColor={palette.danger}
                  icon="trash-can-outline"
                  disabled={busy || loading}
                  onPress={() =>
                    Alert.alert(
                      vi.deleteTransaction,
                      vi.transactionDeleteConfirm,
                      [
                        { text: vi.cancel, style: 'cancel' },
                        {
                          text: vi.deleteTransaction,
                          style: 'destructive',
                          onPress: () =>
                            void mutate((db) =>
                              deleteTransaction(db, row.id, row.updated_at),
                            ),
                        },
                      ],
                    )
                  }
                >
                  {vi.deleteTransaction}
                </Button>
              </View>
            </View>
          ))}
          {more && (
            <Button
              hitSlop={4}
              mode="outlined"
              disabled={busy || loading}
              contentStyle={styles.button}
              onPress={() => void loadMore()}
            >
              {vi.transactionMore}
            </Button>
          )}
        </>
      ) : (
        <>
          <Button
            hitSlop={4}
            mode="contained"
            icon="plus"
            disabled={
              busy || loading || !wallets.some((wallet) => !wallet.is_archived)
            }
            contentStyle={styles.button}
            onPress={() => {
              ids.current = { debt: uuid.v4(), transaction: uuid.v4() };
              setError('');
              setEditing('create');
            }}
          >
            {vi.debtAdd}
          </Button>

          <SegmentedButtons
            value={closed ? 'closed' : 'open'}
            onValueChange={(value) => setClosed(value === 'closed')}
            buttons={[
              { value: 'open', label: vi.debtShowOpen, disabled: busy },
              { value: 'closed', label: vi.debtShowClosed, disabled: busy },
            ]}
          />

          <View
            style={[
              styles.subtlePanel,
              { backgroundColor: palette.surface, borderColor: palette.border },
            ]}
          >
            <View style={styles.inlineRow}>
              <IconBadge
                icon="bell-ring-outline"
                bg={palette.purpleSoft}
                fg={palette.purpleInk}
                size={36}
                iconSize={18}
              />
              <Text
                variant="bodySmall"
                style={{ color: palette.textMuted, flex: 1 }}
              >
                {vi.debtReminderHint}
              </Text>
            </View>
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
            {status.permission === 'denied' && (
              <Text variant="bodySmall" style={{ color: palette.warningInk }}>
                {vi.recurringNotificationDenied}
              </Text>
            )}
            {status.error && (
              <Text accessibilityRole="alert" style={{ color: colors.error }}>
                {vi.debtNotificationError}
              </Text>
            )}
          </View>

          {!loading && !visibleDebts.length && (
            <EmptyStateCard icon="handshake-outline" message={vi.debtEmpty} />
          )}
          {visibleDebts.map((row) => (
            <View
              key={row.id}
              style={[
                styles.panel,
                {
                  backgroundColor: palette.surface,
                  borderColor: palette.border,
                },
              ]}
            >
              <View style={styles.row}>
                <View style={[styles.inlineRow, { flex: 1 }]}>
                  <IconBadge
                    icon="handshake-outline"
                    bg={
                      row.direction === 'borrowed'
                        ? palette.warningSoft
                        : palette.primarySoft
                    }
                    fg={
                      row.direction === 'borrowed'
                        ? palette.warningInk
                        : palette.primaryInk
                    }
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="titleMedium" style={{ fontWeight: '700' }}>
                      {row.counterparty_label}
                    </Text>
                    <Text
                      variant="bodySmall"
                      style={{ color: palette.textMuted }}
                    >
                      {row.direction === 'borrowed'
                        ? vi.debtBorrowed
                        : vi.debtLent}
                      {row.due_on
                        ? ` · ${vi.debtDue}: ${formatDisplayDate(row.due_on)}`
                        : ''}
                    </Text>
                  </View>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text
                    variant="labelSmall"
                    style={{ color: palette.textMuted }}
                  >
                    {vi.debtOutstanding}
                  </Text>
                  <Text
                    variant="titleMedium"
                    style={[styles.number, { fontWeight: '700' }]}
                  >
                    {formatVnd(row.outstanding)}
                  </Text>
                </View>
              </View>
              <Button
                hitSlop={4}
                mode="contained-tonal"
                icon="chevron-right"
                contentStyle={[
                  styles.compactButton,
                  { flexDirection: 'row-reverse' },
                ]}
                disabled={busy || loading}
                onPress={() => {
                  setError('');
                  setUndo(null);
                  setSelected(row);
                }}
              >
                {vi.debtDetails}
              </Button>
            </View>
          ))}
        </>
      )}
    </Screen>
  );
}

interface Fields {
  name: string;
  direction: 'borrowed' | 'lent';
  amount: string;
  wallet: string;
  date: string;
  due: string;
  note: string;
}
function DebtForm({
  mode,
  debt,
  wallets,
  busy,
  error,
  onBack,
  onSave,
}: {
  mode: Submission['type'];
  debt: DebtRow | null;
  wallets: WalletRow[];
  busy: boolean;
  error: string;
  onBack(): void;
  onSave(submission: Submission): Promise<void>;
}) {
  const [initialValues] = useState<Fields>(() => ({
    name: debt?.counterparty_label ?? '',
    direction: debt?.direction ?? 'borrowed',
    amount: '',
    wallet: wallets.find((wallet) => !wallet.is_archived)?.id ?? '',
    date: today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' }),
    due: debt?.due_on ?? '',
    note: mode === 'metadata' ? (debt?.note ?? '') : '',
  }));
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<Fields>({
    defaultValues: initialValues,
  });
  const [invalid, setInvalid] = useState(false);
  const watched = useWatch({ control });
  const currentValues: Fields = {
    name: watched.name ?? initialValues.name,
    direction: watched.direction ?? initialValues.direction,
    amount: watched.amount ?? initialValues.amount,
    wallet: watched.wallet ?? initialValues.wallet,
    date: watched.date ?? initialValues.date,
    due: watched.due ?? initialValues.due,
    note: watched.note ?? initialValues.note,
  };
  const date = currentValues.date;
  const disabled = busy || isSubmitting,
    { colors } = useTheme(),
    palette = useFinancePalette();
  const walletOptions = useMemo(
    () =>
      wallets
        .filter((wallet) => !wallet.is_archived)
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
    [wallets, palette],
  );
  const relevantKeys: (keyof Fields)[] =
    mode === 'metadata'
      ? ['name', 'due', 'note']
      : mode === 'repay'
        ? ['amount', 'wallet', 'date', 'note']
        : ['name', 'direction', 'amount', 'wallet', 'date', 'due', 'note'];
  const dirty = haveFieldsChanged(initialValues, currentValues, {
    moneyKeys: ['amount'],
    keys: relevantKeys,
  });
  const { requestLeave, runGuardedSave } = useUnsavedChangesGuard({
    id: 'debt-form',
    scope: 'tab',
    routeKey: 'transactions',
    dirty,
    saving: disabled,
    hasError: invalid || !!error,
    changeSignature: JSON.stringify(currentValues),
    onDiscard: onBack,
  });
  let future = false;
  try {
    future = isFutureDate(date, new Date());
  } catch {
    /* Partial date. */
  }
  const fields = [
    ...(mode !== 'repay'
      ? [
          {
            name: 'name' as const,
            label: vi.debtCounterparty,
            icon: 'account-outline',
          },
          {
            name: 'due' as const,
            label: vi.debtDueInput,
            icon: 'calendar-clock-outline',
          },
        ]
      : []),
    ...(mode !== 'metadata'
      ? [
          {
            name: 'amount' as const,
            label: vi.transactionAmount,
            icon: 'cash',
          },
          {
            name: 'date' as const,
            label: vi.transactionDate,
            icon: 'calendar',
          },
        ]
      : []),
    {
      name: 'note' as const,
      label: vi.transactionNote,
      icon: 'note-text-outline',
    },
  ];
  const isLongForm = mode !== 'metadata';
  const saveSection = (
    <>
      {(invalid || error) && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error || vi.debtFormInvalid}
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
            let submission: Submission;
            try {
              if (mode === 'metadata')
                submission = {
                  type: 'metadata',
                  value: DebtChangesSchema.parse({
                    counterpartyLabel: fields.name,
                    dueOn: fields.due.trim() || null,
                    note: fields.note,
                  }),
                };
              else if (mode === 'repay')
                submission = {
                  type: 'repay',
                  value: DebtRepaymentSchema.parse({
                    amount: parseAmountInput(fields.amount),
                    walletId: fields.wallet,
                    occurredOn: fields.date.trim(),
                    note: fields.note,
                  }),
                };
              else
                submission = {
                  type: 'create',
                  value: DebtInputSchema.parse({
                    counterpartyLabel: fields.name,
                    direction: fields.direction,
                    amount: parseAmountInput(fields.amount),
                    walletId: fields.wallet,
                    occurredOn: fields.date.trim(),
                    dueOn: fields.due.trim() || null,
                    note: fields.note,
                  }),
                };
            } catch {
              setInvalid(true);
              return;
            }
            setInvalid(false);
            await runGuardedSave(() => onSave(submission));
          })()
        }
      >
        {vi.debtSave}
      </Button>
    </>
  );
  return (
    <Screen
      title={
        mode === 'create'
          ? vi.debtAdd
          : mode === 'metadata'
            ? vi.debtEdit
            : vi.debtRepayment
      }
      onBack={requestLeave}
      backDisabled={disabled}
      footer={isLongForm ? saveSection : undefined}
    >
      {debt && (
        <View
          style={[
            styles.subtlePanel,
            { backgroundColor: palette.surface, borderColor: palette.border },
          ]}
        >
          <Text variant="titleMedium" style={{ fontWeight: '700' }}>
            {debt.counterparty_label} · {vi.debtOutstanding}:{' '}
            {formatVnd(debt.outstanding)}
          </Text>
        </View>
      )}
      <View
        style={[
          styles.panel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        {mode === 'create' && (
          <Controller
            control={control}
            name="direction"
            render={({ field, fieldState }) => (
              <FieldFeedback
                fieldRef={field.ref}
                message={fieldState.error?.message}
              >
                <SegmentedOptionPicker
                  value={field.value}
                  disabled={disabled}
                  accessibilityLabel={vi.transactionKind}
                  onSelect={field.onChange}
                  options={[
                    { value: 'borrowed', label: vi.debtBorrowed },
                    { value: 'lent', label: vi.debtLent },
                  ]}
                />
              </FieldFeedback>
            )}
          />
        )}
        {mode !== 'metadata' && (
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
                  label={vi.transactionWallet}
                  value={field.value}
                  options={walletOptions}
                  disabled={disabled}
                  placeholder={vi.noWallet}
                  onSelect={field.onChange}
                />
              </FieldFeedback>
            )}
          />
        )}
        {fields.map((item) => (
          <Controller
            key={item.name}
            control={control}
            name={item.name}
            rules={{
              validate: (value) =>
                item.name === 'name'
                  ? !!value.trim() || vi.formRequired
                  : item.name === 'due'
                    ? dateError(value, true)
                    : item.name === 'date'
                      ? dateError(value)
                      : item.name === 'amount'
                        ? repaymentError(
                            value,
                            mode === 'repay' ? debt?.outstanding : undefined,
                          )
                        : true,
            }}
            render={({ field, fieldState }) => (
              <FieldFeedback
                fieldRef={field.ref}
                message={fieldState.error?.message}
              >
                {item.name === 'due' || item.name === 'date' ? (
                  <DateField
                    error={!!fieldState.error}
                    label={item.name === 'due' ? vi.debtDue : item.label}
                    value={field.value}
                    onChange={field.onChange}
                    disabled={disabled}
                    allowClear={item.name === 'due'}
                  />
                ) : item.name === 'amount' ? (
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
                  <FocusAwareTextInput
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
      </View>

      {future && mode !== 'metadata' && (
        <View
          style={[
            styles.subtlePanel,
            {
              backgroundColor: palette.warningSoft,
              borderColor: palette.warning,
            },
          ]}
        >
          <Text accessibilityRole="alert" style={{ color: palette.warningInk }}>
            {vi.transactionFutureWarning}
          </Text>
        </View>
      )}
      {!isLongForm && saveSection}
    </Screen>
  );
}
