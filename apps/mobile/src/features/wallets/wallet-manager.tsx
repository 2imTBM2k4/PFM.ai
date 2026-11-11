import { uuid } from 'expo';
import { useFocusEffect } from 'expo-router';
import { MAX_AMOUNT_VND } from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import type { WalletInput } from '@pfm/contracts';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { haveFieldsChanged, requestGuardLeave } from '@/utils/unsaved-changes';
import { BackHandler, FlatList, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Divider,
  HelperText,
  SegmentedButtons,
  Switch,
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
import { AppleMenuPicker, MoneyInput } from '@/components/ui';
import { useFinancePalette, walletKindVisual } from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import type { Database } from '@/data/migrate';
import { listWallets, type WalletRow } from '@/data/repository';
import {
  createWallet,
  updateWallet,
  setWalletArchived,
} from '@/data/wallets';
import { vi } from '@/messages/vi';
import { displayWalletName } from '@/messages/seed-labels';
import { useApp } from '@/state/app';

const KINDS = [
  { value: 'cash', label: vi.walletCash },
  { value: 'bank', label: vi.walletBank },
  { value: 'ewallet', label: vi.walletEwallet },
  { value: 'credit_card', label: vi.walletCredit },
  { value: 'savings', label: vi.walletSavings },
  { value: 'other', label: vi.walletOther },
] as const;

export function WalletManager({ onClose }: { onClose(): void }) {
  const [rows, setRows] = useState<WalletRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<WalletRow | null | undefined>(
    undefined,
  );
  const newId = useRef<string | null>(null);
  const working = useRef(false);
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const recurringVersion = useApp((state) => state.recurringVersion);
  const showRows = useCallback((next: WalletRow[]) => {
    setRows(next);
    useApp.setState({ wallets: next.filter((wallet) => !wallet.is_archived) });
  }, []);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      withDatabase((db) => listWallets(db, true))
        .then((next) => {
          if (cancelled) return;
          showRows(next);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setError(vi.walletsLoadError);
          setLoading(false);
        });
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Catch-up on resume changes balances in this focused list.
    }, [showRows, recurringVersion]),
  );
  const leaveForm = useCallback(() => {
    if (working.current) return;
    setEditing(undefined);
    setError('');
  }, []);
  const back = useCallback(() => {
    if (working.current) return;
    if (editing !== undefined) {
      requestGuardLeave('wallet-form', leaveForm);
    } else onClose();
  }, [editing, leaveForm, onClose]);
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener(
        'hardwareBackPress',
        () => {
          back();
          return true;
        },
      );
      return () => subscription.remove();
    }, [back]),
  );
  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      showRows(await withDatabase((db) => listWallets(db, true)));
    } catch {
      setError(vi.walletsLoadError);
    } finally {
      setLoading(false);
    }
  }, [showRows]);
  const mutate = useCallback(
    async (action: (db: Database) => Promise<void>) => {
      if (working.current) return false;
      working.current = true;
      setBusy(true);
      setError('');
      setSaved(false);
      let committed = false;
      try {
        await withDatabase(async (db) => {
          await action(db);
          committed = true;
        });
        await useApp.getState().refreshRecurring(true);
        showRows(await withDatabase((db) => listWallets(db, true)));
        setSaved(true);
        return true;
      } catch {
        setError(committed ? vi.walletSavedRefreshFailed : vi.saveError);
        // Avoid resubmitting an already committed creation after a failed refresh.
        if (committed) setEditing(undefined);
        return false;
      } finally {
        working.current = false;
        setBusy(false);
      }
    },
    [showRows],
  );
  const archive = useCallback(
    (wallet: WalletRow) =>
      mutate((db) =>
        setWalletArchived(
          db,
          wallet.id,
          !wallet.is_archived,
          new Date().toISOString(),
        ),
      ),
    [mutate],
  );
  const visibleRows = rows.filter(
    (wallet) => !!wallet.is_archived === archived,
  );
  const renderWallet = useCallback(
    ({ item }: { item: WalletRow }) => (
      <WalletItem
        wallet={item}
        busy={busy}
        onEdit={setEditing}
        onArchive={archive}
      />
    ),
    [archive, busy],
  );

  if (editing !== undefined)
    return (
      <WalletForm
        wallet={editing}
        busy={busy}
        error={error}
        onBack={leaveForm}
        onSave={async (input) => {
          const id = editing?.id ?? newId.current;
          if (!id) return;
          const timestamp = new Date().toISOString();
          const success = await mutate((db) =>
            editing
              ? updateWallet(db, id, input, timestamp)
              : createWallet(db, id, input, timestamp),
          );
          if (success) setEditing(undefined);
        }}
      />
    );
  return (
    <Screen
      title={vi.manageWallets}
      onBack={back}
      backDisabled={busy}
      scroll={false}
      headerRight={
        <Button
          mode="contained"
          icon="plus"
          contentStyle={styles.compactButton}
          disabled={busy || loading}
          onPress={() => {
            newId.current = uuid.v4();
            setEditing(null);
            setError('');
            setSaved(false);
          }}
        >
          {vi.addWallet}
        </Button>
      }
    >
      <SegmentedButtons
        value={archived ? 'archived' : 'active'}
        onValueChange={(value) => setArchived(value === 'archived')}
        buttons={[
          { value: 'active', label: vi.walletActive },
          { value: 'archived', label: vi.walletArchived },
        ]}
      />
      {saved && (
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
            {vi.walletSaved}
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
          <Button disabled={busy || loading} onPress={reload}>
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
          data={visibleRows}
          keyExtractor={(item) => item.id}
          renderItem={renderWallet}
          showsVerticalScrollIndicator={false}
          style={styles.fill}
          contentContainerStyle={{ gap: 14, paddingBottom: 24 }}
          ListEmptyComponent={
            <EmptyStateCard
              icon="wallet-outline"
              message={archived ? vi.archivedWalletsEmpty : vi.noWallet}
            />
          }
        />
      )}
    </Screen>
  );
}

const WalletItem = memo(function WalletItem({
  wallet,
  busy,
  onEdit,
  onArchive,
}: {
  wallet: WalletRow;
  busy: boolean;
  onEdit(wallet: WalletRow): void;
  onArchive(wallet: WalletRow): Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const palette = useFinancePalette();
  const visual = walletKindVisual(wallet.kind, palette);
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
            icon={visual.icon}
            bg={visual.bg}
            fg={visual.fg}
            size={44}
            iconSize={22}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="titleMedium" style={{ fontWeight: '700' }}>
              {displayWalletName(wallet.name)}
            </Text>
            <Text variant="bodySmall" style={{ color: palette.textMuted }}>
              {KINDS.find(({ value }) => value === wallet.kind)?.label}
            </Text>
          </View>
        </View>
        <Text
          variant="titleLarge"
          style={[styles.number, { fontWeight: '700', color: palette.text }]}
        >
          {formatVnd(wallet.balance)}
        </Text>
      </View>

      {!!wallet.is_goal_funding && (
        <StatusPill
          icon="bullseye-arrow"
          label={vi.walletGoalFunding}
          bg={palette.tealSoft}
          fg={palette.tealInk}
        />
      )}

      <Divider style={{ backgroundColor: palette.borderSubtle }} />

      {confirming ? (
        <View
          style={[
            styles.subtlePanel,
            {
              backgroundColor: palette.warningSoft,
              borderColor: palette.warning,
            },
          ]}
        >
          <Text variant="bodySmall" style={{ color: palette.warningInk }}>
            {vi.walletArchiveDescription}
          </Text>
          <View style={styles.row}>
            <Button
              mode="contained-tonal"
              disabled={busy}
              onPress={async () => {
                if (await onArchive(wallet)) setConfirming(false);
              }}
            >
              {vi.archiveWallet}
            </Button>
            <Button
              mode="text"
              disabled={busy}
              onPress={() => setConfirming(false)}
            >
              {vi.cancel}
            </Button>
          </View>
        </View>
      ) : wallet.is_archived ? (
        <Button
          mode="contained-tonal"
          icon="restore"
          contentStyle={styles.button}
          disabled={busy}
          onPress={() => onArchive(wallet)}
        >
          {vi.restoreWallet}
        </Button>
      ) : (
        <View style={styles.row}>
          <View style={styles.inlineRow}>
            <Button
              compact
              mode="contained-tonal"
              icon="pencil-outline"
              disabled={busy}
              onPress={() => onEdit(wallet)}
            >
              {vi.editWallet}
            </Button>
            <Button
              compact
              mode="text"
              icon="archive-arrow-down-outline"
              disabled={busy}
              onPress={() => setConfirming(true)}
            >
              {vi.archiveWallet}
            </Button>
          </View>
        </View>
      )}
    </View>
  );
});

interface WalletFields {
  name: string;
  kind: WalletInput['kind'];
  balance: string;
  isGoalFunding: boolean;
}

function WalletForm({
  wallet,
  busy,
  error,
  onSave,
  onBack,
}: {
  wallet: WalletRow | null;
  busy: boolean;
  error: string;
  onSave(input: WalletInput): Promise<void>;
  onBack(): void;
}) {
  const [initialValues] = useState<WalletFields>(() => ({
    name: wallet?.name ?? '',
    kind: wallet?.kind ?? 'cash',
    balance: String(wallet?.initial_balance ?? 0),
    isGoalFunding: !!wallet?.is_goal_funding,
  }));
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<WalletFields>({
    defaultValues: initialValues,
  });
  const watched = useWatch({ control });
  const currentValues: WalletFields = {
    name: watched.name ?? initialValues.name,
    kind: watched.kind ?? initialValues.kind,
    balance: watched.balance ?? initialValues.balance,
    isGoalFunding: watched.isGoalFunding ?? initialValues.isGoalFunding,
  };
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const kindOptions = useMemo(
    () =>
      KINDS.map((kind) => {
        const visual = walletKindVisual(kind.value, palette);
        return {
          value: kind.value,
          label: kind.label,
          icon: visual.icon,
          iconBg: visual.bg,
          iconColor: visual.fg,
        };
      }),
    [palette],
  );
  const disabled = busy || isSubmitting;
  const dirty = haveFieldsChanged(initialValues, currentValues, {
    moneyKeys: ['balance'],
  });
  const { requestLeave, runGuardedSave } = useUnsavedChangesGuard({
    id: 'wallet-form',
    scope: 'tab',
    routeKey: 'index',
    dirty,
    saving: disabled,
    hasError: !!error,
    changeSignature: JSON.stringify(currentValues),
    onDiscard: onBack,
  });
  return (
    <Screen
      title={wallet ? vi.editWallet : vi.addWallet}
      onBack={requestLeave}
      backDisabled={disabled}
    >
      <View
        style={[
          styles.panel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        <Controller
          control={control}
          name="name"
          rules={{
            validate: (value) => !!value.trim() || vi.walletNameRequired,
          }}
          render={({ field, fieldState }) => (
            <View>
              <TextInput
                mode="outlined"
                label={vi.walletName}
                accessibilityLabel={vi.walletName}
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={!!fieldState.error}
                disabled={disabled}
                left={<TextInput.Icon icon="wallet-outline" />}
              />
              {!!fieldState.error && (
                <HelperText type="error">{fieldState.error.message}</HelperText>
              )}
            </View>
          )}
        />
        <Controller
          control={control}
          name="balance"
          rules={{
            validate: (value) =>
              value === '' ||
              (/^-?\d+$/.test(value) &&
                Number.isSafeInteger(Number(value)) &&
                Math.abs(Number(value)) <= MAX_AMOUNT_VND) ||
              vi.initialBalanceInvalid,
          }}
          render={({ field, fieldState }) => (
            <View>
              <MoneyInput
                allowNegative
                label={vi.initialBalance}
                accessibilityLabel={vi.initialBalance}
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={!!fieldState.error}
                disabled={disabled}
                left={<TextInput.Icon icon="cash" />}
              />
              <HelperText type={fieldState.error ? 'error' : 'info'}>
                {fieldState.error?.message ?? vi.initialBalanceHint}
              </HelperText>
            </View>
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
          name="kind"
          render={({ field }) => (
            <AppleMenuPicker
              label={vi.walletKind}
              value={field.value}
              options={kindOptions}
              disabled={disabled}
              onSelect={field.onChange}
            />
          )}
        />
        <Divider style={{ backgroundColor: palette.borderSubtle }} />
        <Controller
          control={control}
          name="isGoalFunding"
          render={({ field }) => (
            <View style={styles.row}>
              <Text style={{ flex: 1, fontWeight: '500' }}>
                {vi.walletGoalFunding}
              </Text>
              <Switch
                value={field.value}
                onValueChange={field.onChange}
                accessibilityLabel={vi.walletGoalFunding}
                disabled={disabled}
              />
            </View>
          )}
        />
      </View>

      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}
      <Button
        mode="contained"
        icon="check"
        contentStyle={styles.button}
        disabled={disabled}
        loading={disabled}
        onPress={() => {
          void handleSubmit((values) =>
            runGuardedSave(() =>
              onSave({
                name: values.name,
                kind: values.kind,
                initialBalance: Number(values.balance || '0'),
                isGoalFunding: values.isGoalFunding,
              }),
            ),
          )();
        }}
      >
        {vi.saveWallet}
      </Button>
    </Screen>
  );
}
