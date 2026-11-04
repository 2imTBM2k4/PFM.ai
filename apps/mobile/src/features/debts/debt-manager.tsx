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
import { useCallback, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Alert, BackHandler, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Divider,
  IconButton,
  List,
  RadioButton,
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
import { DateField } from '@/components/ui';
import { useFinancePalette } from '@/constants/theme';
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
import {
  formatAmountInput,
  isFutureDate,
  parseAmountInput,
} from '@/features/transactions/form';
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
    [undo, setUndo] = useState<TransactionRow | null>(null);
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
    }, [load]),
  );
  const back = useCallback(() => {
    if (working.current) return;
    setError('');
    setUndo(null);
    if (editing) setEditing(null);
    else if (selected) setSelected(null);
    else onClose();
  }, [editing, selected, onClose]);
  useFocusEffect(
    useCallback(() => {
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
        onBack={back}
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
        onBack={back}
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
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<Fields>({
    defaultValues: {
      name: debt?.counterparty_label ?? '',
      direction: debt?.direction ?? 'borrowed',
      amount: '',
      wallet: wallets.find((wallet) => !wallet.is_archived)?.id ?? '',
      date: today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' }),
      due: debt?.due_on ?? '',
      note: mode === 'metadata' ? (debt?.note ?? '') : '',
    },
  });
  const [invalid, setInvalid] = useState(false),
    [expanded, setExpanded] = useState(false);
  const date = useWatch({ control, name: 'date' });
  const disabled = busy || isSubmitting,
    { colors } = useTheme(),
    palette = useFinancePalette();
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
  return (
    <Screen
      title={
        mode === 'create'
          ? vi.debtAdd
          : mode === 'metadata'
            ? vi.debtEdit
            : vi.debtRepayment
      }
      onBack={onBack}
      backDisabled={disabled}
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
            render={({ field }) => (
              <SegmentedButtons
                value={field.value}
                onValueChange={field.onChange}
                buttons={[
                  { value: 'borrowed', label: vi.debtBorrowed, disabled },
                  { value: 'lent', label: vi.debtLent, disabled },
                ]}
              />
            )}
          />
        )}
        {mode !== 'metadata' && (
          <Controller
            control={control}
            name="wallet"
            render={({ field }) => (
              <List.Accordion
                title={vi.transactionWallet}
                description={
                  wallets.find((wallet) => wallet.id === field.value)?.name ??
                  vi.noWallet
                }
                expanded={expanded}
                onPress={() => setExpanded(!expanded)}
                style={{
                  backgroundColor: palette.surfaceMuted,
                  borderRadius: 12,
                }}
              >
                <RadioButton.Group
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value);
                    setExpanded(false);
                  }}
                >
                  {wallets
                    .filter((wallet) => !wallet.is_archived)
                    .map((wallet) => (
                      <RadioButton.Item
                        key={wallet.id}
                        value={wallet.id}
                        label={displayWalletName(wallet.name)}
                        disabled={disabled}
                      />
                    ))}
                </RadioButton.Group>
              </List.Accordion>
            )}
          />
        )}
        {fields.map((item) => (
          <Controller
            key={item.name}
            control={control}
            name={item.name}
            render={({ field }) =>
              item.name === 'due' ? (
                <DateField
                  label={vi.debtDue}
                  value={field.value}
                  onChange={field.onChange}
                  disabled={disabled}
                  allowClear
                />
              ) : (
                <TextInput
                  mode="outlined"
                  label={item.label}
                  value={field.value}
                  disabled={disabled}
                  onBlur={field.onBlur}
                  left={<TextInput.Icon icon={item.icon} />}
                  keyboardType={
                    item.name === 'amount' ? 'number-pad' : 'default'
                  }
                  onChangeText={(value) =>
                    field.onChange(
                      item.name === 'amount'
                        ? formatAmountInput(value, field.value)
                        : value,
                    )
                  }
                />
              )
            }
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
      {(invalid || error) && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error || vi.debtFormInvalid}
        </Text>
      )}
      <Button
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
            await onSave(submission);
          })()
        }
      >
        {vi.debtSave}
      </Button>
    </Screen>
  );
}
