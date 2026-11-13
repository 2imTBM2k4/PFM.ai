import {
  FieldFeedback,
  FocusAwareTextInput,
} from '@/components/field-feedback';
import { quickEntryErrors } from './validation';
import { useMemo, useState } from 'react';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { areEntryDraftsChanged } from '@/utils/unsaved-changes';
import { Modal, View } from 'react-native';
import {
  Controller,
  useFieldArray,
  useForm,
  useFormState,
  useWatch,
  type Control,
  type ResolverResult,
  type UseFormSetValue,
} from 'react-hook-form';
import { Button, Checkbox, HelperText, Text } from 'react-native-paper';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  CONFIDENCE_HIGH,
  type ParseResult,
  type ParsedEntry,
  type ParseWarning,
} from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import { Screen, styles } from '@/components/screen';
import { AppleMenuPicker, DateField, MoneyInput } from '@/components/ui';
import { orderCategoriesByParent } from '@/data/categories';
import { useFinancePalette, walletKindVisual } from '@/constants/theme';
import { vi } from '@/messages/vi';
import { displayCategoryName, displayWalletName } from '@/messages/seed-labels';
import { usePreferences } from '@/state/preferences';
import { formatDisplayDate } from '@/utils/display';
import { isFutureDate } from '../transactions/form';
import type { EntryDraft, EntryReferences } from './draft';

export const ENTRY_KINDS = [
  { value: 'expense', label: vi.transactionExpense },
  { value: 'income', label: vi.transactionIncome },
  { value: 'transfer', label: vi.transactionTransfer },
  { value: 'debt_borrow', label: vi.debtBorrow },
  { value: 'debt_lend', label: vi.debtLend },
  { value: 'debt_repay_paid', label: vi.debtRepayPaid },
  { value: 'debt_repay_received', label: vi.debtRepayReceived },
] as const;
const WARNINGS: Record<ParseWarning, string> = {
  ASSUMED_THOUSANDS: vi.quickAssumed,
  NON_INTEGER_VND: vi.quickFraction,
  ZERO_AMOUNT: vi.quickZero,
  AMOUNT_TOO_LARGE: vi.quickLarge,
  INVALID_DATE: vi.quickInvalidDate,
  FUTURE_DATE: vi.quickFuture,
  MULTIPLE_AMOUNTS: vi.quickMultiple,
  NO_AMOUNT: vi.quickNoAmount,
  AMBIGUOUS_KIND: vi.quickAmbiguous,
};
export function entryKindLabel(kind: ParsedEntry['kind']) {
  return (
    ENTRY_KINDS.find((item) => item.value === kind)?.label ?? vi.quickUnknown
  );
}

interface Fields {
  entries: EntryDraft[];
}

// A native sheet owns its scrolling/keyboard area, independent of the bottom tab bar.
export function EntryConfirmation({
  result,
  drafts,
  refs,
  busy,
  error,
  onCancel,
  onSave,
}: {
  result: ParseResult;
  drafts: EntryDraft[];
  refs: EntryReferences;
  busy: boolean;
  error: string;
  onCancel(): void;
  onSave(drafts: EntryDraft[]): Promise<void>;
}) {
  const [initialDrafts] = useState<EntryDraft[]>(() =>
    drafts.map((entry) => ({ ...entry })),
  );
  const {
    control,
    setValue,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<Fields>({
    defaultValues: { entries: initialDrafts },
    resolver: (values): ResolverResult<Fields> => {
      const errors = quickEntryErrors(
        result,
        values.entries,
        refs,
        usePreferences.getState().exchangeRate,
      );
      return errors.some((entry) => Object.keys(entry).length > 0)
        ? { values: {}, errors: { entries: errors } }
        : { values, errors: {} };
    },
  });
  const { fields } = useFieldArray({ control, name: 'entries' });
  const values = useWatch({ control, name: 'entries' });
  const disabled = busy || isSubmitting;
  const palette = useFinancePalette();
  const dirty = areEntryDraftsChanged(initialDrafts, values);
  const { requestLeave, runGuardedSave } = useUnsavedChangesGuard({
    id: 'entry-confirmation',
    scope: 'modal',
    dirty,
    saving: disabled,
    hasError: !!error,
    changeSignature: JSON.stringify(values),
    onDiscard: onCancel,
  });
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal={false}
      onRequestClose={requestLeave}
    >
      <SafeAreaProvider>
        <SafeAreaView
          edges={['bottom']}
          style={[styles.fill, { backgroundColor: palette.ground }]}
        >
          <Screen
            title={vi.quickConfirmTitle}
            subtitle={vi.quickConfirmHint}
            onBack={requestLeave}
            backDisabled={disabled}
          >
            <Text selectable variant="bodyMedium">
              {result.raw}
            </Text>
            {result.warnings.map((warning) => (
              <Text
                key={warning}
                variant="bodySmall"
                style={{ color: palette.warningInk }}
              >
                {WARNINGS[warning]}
              </Text>
            ))}
            <Text>
              {vi.quickSelectedCount}:{' '}
              {values.filter((entry) => entry.selected).length} /{' '}
              {fields.length}
            </Text>
            {fields.map((field, index) => (
              <CandidateFields
                key={field.id}
                index={index}
                candidate={result.candidates[index]}
                control={control}
                setValue={setValue}
                refs={refs}
                disabled={disabled}
                expandedByDefault={fields.length === 1}
              />
            ))}
            {!!error && (
              <Text accessibilityRole="alert" style={{ color: palette.danger }}>
                {error}
              </Text>
            )}
            <Button
              hitSlop={4}
              mode="contained"
              contentStyle={styles.button}
              disabled={disabled || !values.some((entry) => entry.selected)}
              loading={disabled}
              onPress={() =>
                void handleSubmit((values) =>
                  runGuardedSave(() => onSave(values.entries)),
                )()
              }
            >
              {vi.quickSave}
            </Button>
            <Button
              hitSlop={4}
              contentStyle={styles.button}
              disabled={disabled}
              onPress={requestLeave}
            >
              {vi.cancel}
            </Button>
          </Screen>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function CandidateFields({
  index,
  candidate,
  control,
  setValue,
  refs,
  disabled,
  expandedByDefault,
}: {
  index: number;
  candidate: ParsedEntry;
  control: Control<Fields>;
  setValue: UseFormSetValue<Fields>;
  refs: EntryReferences;
  disabled: boolean;
  expandedByDefault: boolean;
}) {
  const draft = useWatch({ control, name: `entries.${index}` });
  const { errors } = useFormState({ control });
  const hasErrors =
    !!errors.entries?.[index] && Object.keys(errors.entries[index]!).length > 0;
  const [expanded, setExpanded] = useState(expandedByDefault);
  const palette = useFinancePalette();
  const path = `entries.${index}` as const;
  const language = usePreferences((state) => state.language);
  const financialCategory = draft.kind === 'income' || draft.kind === 'expense';
  const newLoan = draft.kind === 'debt_borrow' || draft.kind === 'debt_lend';
  const repayment =
    draft.kind === 'debt_repay_paid' || draft.kind === 'debt_repay_received';
  const wallets = refs.wallets.filter((wallet) => !wallet.is_archived);
  const categories = refs.categories.filter(
    (category) =>
      category.kind === draft.kind &&
      !category.is_archived &&
      (!category.parent_id ||
        refs.categories.some(
          (parent) => parent.id === category.parent_id && !parent.is_archived,
        )),
  );
  const debts = refs.debts.filter(
    (debt) =>
      debt.outstanding > 0 &&
      debt.direction ===
        (draft.kind === 'debt_repay_paid' ? 'borrowed' : 'lent'),
  );

  const kindOptions = useMemo(
    () => [
      {
        value: 'expense',
        label: vi.transactionExpense,
        icon: 'arrow-down-circle',
        iconBg: palette.expenseSoft,
        iconColor: palette.expenseInk,
      },
      {
        value: 'income',
        label: vi.transactionIncome,
        icon: 'arrow-up-circle',
        iconBg: palette.incomeSoft,
        iconColor: palette.incomeInk,
      },
      {
        value: 'transfer',
        label: vi.transactionTransfer,
        icon: 'swap-horizontal-circle',
        iconBg: palette.purpleSoft,
        iconColor: palette.purpleInk,
      },
      {
        value: 'debt_borrow',
        label: vi.debtBorrow,
        icon: 'handshake',
        iconBg: palette.warningSoft,
        iconColor: palette.warningInk,
      },
      {
        value: 'debt_lend',
        label: vi.debtLend,
        icon: 'cash-fast',
        iconBg: palette.tealSoft,
        iconColor: palette.tealInk,
      },
      {
        value: 'debt_repay_paid',
        label: vi.debtRepayPaid,
        icon: 'cash-minus',
        iconBg: palette.expenseSoft,
        iconColor: palette.expenseInk,
      },
      {
        value: 'debt_repay_received',
        label: vi.debtRepayReceived,
        icon: 'cash-plus',
        iconBg: palette.incomeSoft,
        iconColor: palette.incomeInk,
      },
    ],
    [palette],
  );

  const walletOptions = useMemo(
    () =>
      wallets.map((wallet) => {
        const visual = walletKindVisual(wallet.kind, palette);
        return {
          value: wallet.id,
          label: displayWalletName(wallet.name, language),
          icon: visual.icon,
          iconBg: visual.bg,
          iconColor: visual.fg,
        };
      }),
    [wallets, palette, language],
  );

  const toWalletOptions = useMemo(
    () =>
      wallets
        .filter((wallet) => wallet.id !== draft.walletId)
        .map((wallet) => {
          const visual = walletKindVisual(wallet.kind, palette);
          return {
            value: wallet.id,
            label: displayWalletName(wallet.name, language),
            icon: visual.icon,
            iconBg: visual.bg,
            iconColor: visual.fg,
          };
        }),
    [wallets, draft.walletId, palette, language],
  );

  const categoryOptions = useMemo(
    () => [
      {
        value: '',
        label: vi.transactionUncategorized,
        icon: 'help-circle-outline',
        iconBg: palette.surfaceMuted,
        iconColor: palette.textMuted,
      },
      ...orderCategoriesByParent(categories).map((category) => {
        const isExpense = category.kind === 'expense';
        const parent = category.parent_id
          ? refs.categories.find((p) => p.id === category.parent_id)
          : null;
        return {
          value: category.id,
          label: displayCategoryName(category.name, language),
          icon: category.icon || 'tag-outline',
          iconBg: isExpense ? palette.expenseSoft : palette.incomeSoft,
          iconColor:
            category.color ||
            (isExpense ? palette.expenseInk : palette.incomeInk),
          subtitle: parent
            ? `${language === 'en' ? 'Under' : 'Thuộc'}: ${displayCategoryName(parent.name, language)}`
            : undefined,
        };
      }),
    ],
    [categories, refs.categories, palette, language],
  );

  const debtOptions = useMemo(
    () =>
      debts.map((debt) => ({
        value: debt.id,
        label: debt.counterparty_label,
        subtitle: `${language === 'en' ? 'Outstanding' : 'Còn lại'}: ${formatVnd(debt.outstanding)}`,
        icon: debt.direction === 'borrowed' ? 'handshake' : 'cash-fast',
        iconBg:
          debt.direction === 'borrowed'
            ? palette.warningSoft
            : palette.tealSoft,
        iconColor:
          debt.direction === 'borrowed' ? palette.warningInk : palette.tealInk,
      })),
    [debts, palette, language],
  );
  const textField = (
    name: 'amount' | 'note' | 'counterpartyLabel',
    label: string,
    low = false,
  ) => (
    <Controller
      control={control}
      name={`${path}.${name}`}
      render={({ field, fieldState }) => (
        <FieldFeedback fieldRef={field.ref} message={fieldState.error?.message}>
          <View>
            {name === 'amount' ? (
              <MoneyInput
                currency={draft.currency}
                label={label}
                accessibilityLabel={label}
                value={field.value}
                disabled={disabled || !draft.selected}
                error={!!fieldState.error}
                onBlur={field.onBlur}
                outlineColor={low ? palette.warning : undefined}
                onChangeText={(value) => {
                  field.onChange(value);
                  setValue(`${path}.amountConfirmed`, false, {
                    shouldValidate: true,
                  });
                }}
              />
            ) : (
              <FocusAwareTextInput
                mode="outlined"
                label={label}
                accessibilityLabel={label}
                value={field.value}
                disabled={disabled || !draft.selected}
                keyboardType="default"
                multiline={name === 'note'}
                error={!!fieldState.error}
                onBlur={field.onBlur}
                outlineColor={low ? palette.warning : undefined}
                onChangeText={field.onChange}
              />
            )}
            {low && <HelperText type="info">{vi.quickCheckField}</HelperText>}
          </View>
        </FieldFeedback>
      )}
    />
  );
  const amountLabel = draft.amount || vi.quickNoAmount;
  const formDisabled = disabled || !draft.selected;
  const walletName =
    displayWalletName(
      refs.wallets.find((wallet) => wallet.id === draft.walletId)?.name,
    ) || '—';
  const toWalletName =
    displayWalletName(
      refs.wallets.find((wallet) => wallet.id === draft.toWalletId)?.name,
    ) || '—';
  const categoryName = displayCategoryName(
    refs.categories.find((category) => category.id === draft.categoryId)?.name,
  );
  const debtName = refs.debts.find(
    (debt) => debt.id === draft.debtId,
  )?.counterparty_label;
  const referenceLabel =
    draft.kind === 'transfer'
      ? `${walletName} → ${toWalletName}`
      : draft.kind === 'debt_borrow' || draft.kind === 'debt_lend'
        ? `${walletName} · ${draft.counterpartyLabel.trim() || vi.quickCounterpartyRequired}`
        : draft.kind === 'debt_repay_paid' ||
            draft.kind === 'debt_repay_received'
          ? `${walletName} · ${debtName ?? vi.quickDebtRequired}`
          : `${walletName} · ${categoryName ?? vi.transactionUncategorized}`;
  let future = false;
  try {
    future = isFutureDate(draft.date, new Date());
  } catch {
    /* An incomplete date is validated on save. */
  }
  return (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: palette.surface,
          borderColor: palette.border,
          padding: 14,
          gap: 8,
        },
      ]}
    >
      <Controller
        control={control}
        name={`${path}.selected`}
        render={({ field, fieldState }) => (
          <FieldFeedback
            fieldRef={field.ref}
            message={fieldState.error?.message}
          >
            <Checkbox.Item
              position="leading"
              label={`${index + 1}. ${vi.quickSelect}`}
              status={field.value ? 'checked' : 'unchecked'}
              onPress={() => field.onChange(!field.value)}
              disabled={disabled}
            />
          </FieldFeedback>
        )}
      />
      <Text variant="titleMedium" style={styles.number}>
        {amountLabel} {draft.currency === 'USD' ? '$' : '₫'} ·{' '}
        {entryKindLabel(draft.kind)}
      </Text>
      <Text variant="bodySmall" style={{ color: palette.textMuted }}>
        {referenceLabel}
      </Text>
      <Text variant="bodySmall" style={{ color: palette.textMuted }}>
        {formatDisplayDate(draft.date) || vi.quickInvalidDate}
      </Text>
      <Button
        hitSlop={4}
        mode="outlined"
        contentStyle={styles.compactButton}
        disabled={disabled}
        onPress={() => setExpanded(!expanded)}
      >
        {vi.quickDetails}
      </Button>
      <View
        style={{ display: expanded || hasErrors ? 'flex' : 'none', gap: 8 }}
      >
        <Controller
          control={control}
          name={`${path}.kind`}
          render={({ field, fieldState }) => (
            <FieldFeedback
              fieldRef={field.ref}
              message={fieldState.error?.message}
            >
              <AppleMenuPicker
                label={vi.transactionKind}
                value={draft.kind}
                options={kindOptions}
                disabled={formDisabled}
                helperText={
                  candidate.kindConfidence < CONFIDENCE_HIGH ||
                  draft.kind === 'unknown'
                    ? vi.quickCheckField
                    : undefined
                }
                onSelect={(value) => {
                  const choice = ENTRY_KINDS.find(
                    (kind) => kind.value === value,
                  );
                  if (!choice) return;
                  setValue(`${path}.kind`, choice.value, {
                    shouldValidate: true,
                  });
                  setValue(`${path}.categoryId`, '', { shouldValidate: true });
                  setValue(`${path}.toWalletId`, '', { shouldValidate: true });
                  setValue(`${path}.debtId`, '', { shouldValidate: true });
                }}
              />
            </FieldFeedback>
          )}
        />
        <Controller
          control={control}
          name={`${path}.currency`}
          render={({ field, fieldState }) => (
            <FieldFeedback
              fieldRef={field.ref}
              message={fieldState.error?.message}
            >
              <AppleMenuPicker
                label={vi.settingsCurrencyLabel}
                value={draft.currency}
                options={[
                  { value: 'VND', label: 'VND (₫)' },
                  { value: 'USD', label: 'USD ($)' },
                ]}
                disabled={formDisabled}
                onSelect={(value) => {
                  setValue(`${path}.currency`, value as 'VND' | 'USD', {
                    shouldValidate: true,
                  });
                  setValue(`${path}.amount`, '', { shouldValidate: true });
                  setValue(`${path}.amountConfirmed`, false, {
                    shouldValidate: true,
                  });
                }}
              />
            </FieldFeedback>
          )}
        />
        {textField(
          'amount',
          `${vi.transactionAmount.replace(' (₫)', '')} (${draft.currency})`,
          candidate.amount.confidence !== 'high',
        )}
        {candidate.explanation.includes('amount.assumed_thousands') && (
          <>
            <Text style={{ color: palette.warningInk }}>{vi.quickAssumed}</Text>
            <Controller
              control={control}
              name={`${path}.amountConfirmed`}
              render={({ field, fieldState }) => (
                <FieldFeedback
                  fieldRef={field.ref}
                  message={fieldState.error?.message}
                >
                  <Checkbox.Item
                    label={vi.quickAmountConfirm}
                    status={field.value ? 'checked' : 'unchecked'}
                    disabled={formDisabled}
                    onPress={() => field.onChange(!field.value)}
                  />
                </FieldFeedback>
              )}
            />
          </>
        )}
        <Controller
          control={control}
          name={`${path}.walletId`}
          render={({ field, fieldState }) => (
            <FieldFeedback
              fieldRef={field.ref}
              message={fieldState.error?.message}
            >
              <AppleMenuPicker
                label={
                  draft.kind === 'transfer'
                    ? vi.transactionSourceWallet
                    : vi.transactionWallet
                }
                value={draft.walletId}
                options={walletOptions}
                disabled={formDisabled}
                onSelect={(value) =>
                  setValue(`${path}.walletId`, value, { shouldValidate: true })
                }
              />
            </FieldFeedback>
          )}
        />
        {draft.kind === 'transfer' && (
          <Controller
            control={control}
            name={`${path}.toWalletId`}
            render={({ field, fieldState }) => (
              <FieldFeedback
                fieldRef={field.ref}
                message={fieldState.error?.message}
              >
                <AppleMenuPicker
                  label={vi.transactionDestination}
                  value={draft.toWalletId}
                  options={toWalletOptions}
                  disabled={formDisabled}
                  onSelect={(value) =>
                    setValue(`${path}.toWalletId`, value, {
                      shouldValidate: true,
                    })
                  }
                />
              </FieldFeedback>
            )}
          />
        )}
        {financialCategory && (
          <Controller
            control={control}
            name={`${path}.categoryId`}
            render={({ field, fieldState }) => (
              <FieldFeedback
                fieldRef={field.ref}
                message={fieldState.error?.message}
              >
                <AppleMenuPicker
                  label={vi.transactionCategory}
                  value={draft.categoryId}
                  options={categoryOptions}
                  disabled={formDisabled}
                  helperText={
                    candidate.categoryConfidence < CONFIDENCE_HIGH ||
                    (!!candidate.categoryKey && !draft.categoryId)
                      ? vi.quickCheckField
                      : undefined
                  }
                  onSelect={(value) =>
                    setValue(`${path}.categoryId`, value, {
                      shouldValidate: true,
                    })
                  }
                />
              </FieldFeedback>
            )}
          />
        )}
        {newLoan && (
          <>
            {textField('counterpartyLabel', vi.quickCounterparty)}
            <Text variant="bodySmall">{vi.quickNewDebtHint}</Text>
          </>
        )}
        {repayment && (
          <>
            <Controller
              control={control}
              name={`${path}.debtId`}
              render={({ field, fieldState }) => (
                <FieldFeedback
                  fieldRef={field.ref}
                  message={fieldState.error?.message}
                >
                  <AppleMenuPicker
                    label={vi.quickExistingDebt}
                    value={draft.debtId}
                    options={debtOptions}
                    disabled={formDisabled}
                    onSelect={(value) =>
                      setValue(`${path}.debtId`, value, {
                        shouldValidate: true,
                      })
                    }
                  />
                </FieldFeedback>
              )}
            />
            {!debts.length && <Text>{vi.quickNoDebt}</Text>}
          </>
        )}
        <Controller
          control={control}
          name={`${path}.date`}
          render={({ field, fieldState }) => (
            <FieldFeedback
              fieldRef={field.ref}
              message={fieldState.error?.message}
            >
              <DateField
                label={vi.transactionDate}
                value={field.value}
                onChange={field.onChange}
                disabled={formDisabled}
                error={candidate.date.confidence !== 'high' || !draft.date}
                helperText={
                  candidate.date.confidence !== 'high' || !draft.date
                    ? vi.quickCheckField
                    : undefined
                }
              />
            </FieldFeedback>
          )}
        />
        {textField('note', vi.transactionNote)}
        {!!candidate.amount.matchedText && (
          <Text variant="bodySmall">
            {vi.quickMatchedAmount}: “{candidate.amount.matchedText}”
          </Text>
        )}
      </View>
      {future && (
        <Text style={{ color: palette.warningInk }}>
          {vi.transactionFutureWarning}
        </Text>
      )}
    </View>
  );
}
