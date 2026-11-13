import { FieldFeedback } from '@/components/field-feedback';
import {
  amountError,
  dateError,
  endDateError,
  amountRangeError,
} from '@/utils/form-validation';
import {
  TransactionFiltersSchema,
  type TransactionFilters,
} from '@pfm/contracts';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { haveFieldsChanged } from '@/utils/unsaved-changes';
import { View } from 'react-native';
import { Button, Text, TextInput, useTheme } from 'react-native-paper';
import { AppleMenuPicker, DateField, MoneyInput } from '@/components/ui';
import { Screen, styles } from '@/components/screen';
import { useFinancePalette } from '@/constants/theme';
import type { WalletRow } from '@/data/repository';
import { orderCategoriesByParent, type CategoryRow } from '@/data/categories';
import { vi } from '@/messages/vi';
import { displayCategoryName, displayWalletName } from '@/messages/seed-labels';
import { formatAmountInput, parseAmountInput } from './form';

interface Fields {
  text: string;
  from: string;
  to: string;
  kind: string;
  walletId: string;
  categoryId: string;
  minAmount: string;
  maxAmount: string;
}

export function TransactionFilterForm({
  filters,
  wallets,
  categories,
  busy,
  onApply,
  onBack,
}: {
  filters: TransactionFilters;
  wallets: WalletRow[];
  categories: CategoryRow[];
  busy: boolean;
  onApply(filters: TransactionFilters): void;
  onBack(): void;
}) {
  const [initialValues] = useState<Fields>(() => ({
    text: filters.text ?? '',
    from: filters.from ?? '',
    to: filters.to ?? '',
    kind: filters.kind ?? '',
    walletId: filters.walletId ?? '',
    categoryId: filters.categoryId ?? '',
    minAmount:
      filters.minAmount === undefined
        ? ''
        : formatAmountInput(String(filters.minAmount)),
    maxAmount:
      filters.maxAmount === undefined
        ? ''
        : formatAmountInput(String(filters.maxAmount)),
  }));
  const {
    control,
    handleSubmit,
    getValues,
    setValue,
    formState: { isSubmitting },
  } = useForm<Fields>({
    defaultValues: initialValues,
  });
  const [error, setError] = useState('');
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const disabled = busy || isSubmitting;
  const watched = useWatch({ control });
  const currentValues: Fields = {
    text: watched.text ?? initialValues.text,
    from: watched.from ?? initialValues.from,
    to: watched.to ?? initialValues.to,
    kind: watched.kind ?? initialValues.kind,
    walletId: watched.walletId ?? initialValues.walletId,
    categoryId: watched.categoryId ?? initialValues.categoryId,
    minAmount: watched.minAmount ?? initialValues.minAmount,
    maxAmount: watched.maxAmount ?? initialValues.maxAmount,
  };
  const dirty = haveFieldsChanged(initialValues, currentValues, {
    moneyKeys: ['minAmount', 'maxAmount'],
  });
  const { requestLeave, runGuardedSave } = useUnsavedChangesGuard({
    id: 'transaction-filter-form',
    scope: 'tab',
    routeKey: 'transactions',
    dirty,
    saving: disabled,
    hasError: !!error,
    changeSignature: JSON.stringify(currentValues),
    onDiscard: onBack,
  });
  const fields = [
    { name: 'text', label: vi.filterText, icon: 'magnify' },
    { name: 'minAmount', label: vi.filterMinAmount, icon: 'cash-minus' },
    { name: 'maxAmount', label: vi.filterMaxAmount, icon: 'cash-plus' },
  ] as const;
  const footer = (
    <>
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button
          hitSlop={4}
          mode="outlined"
          icon="filter-remove-outline"
          contentStyle={styles.compactButton}
          style={{ flex: 1 }}
          disabled={disabled}
          onPress={() => onApply({})}
        >
          {vi.filterClear}
        </Button>
        <Button
          hitSlop={4}
          contentStyle={styles.compactButton}
          style={{ flex: 1 }}
          mode="contained"
          icon="check"
          disabled={disabled}
          onPress={() => {
            void handleSubmit((values) => {
              try {
                const amount = (value: string) =>
                  value === ''
                    ? undefined
                    : value === '0'
                      ? 0
                      : parseAmountInput(value);
                const parsed = TransactionFiltersSchema.parse({
                  text: values.text,
                  from: values.from || undefined,
                  to: values.to || undefined,
                  kind: values.kind || undefined,
                  walletId: values.walletId || undefined,
                  categoryId: values.categoryId || undefined,
                  minAmount: amount(values.minAmount),
                  maxAmount: amount(values.maxAmount),
                });
                void runGuardedSave(async () => {
                  onApply(parsed);
                });
              } catch {
                setError(vi.filterInvalid);
              }
            })();
          }}
        >
          {vi.filterApply}
        </Button>
      </View>
    </>
  );
  return (
    <Screen
      title={vi.transactionFilters}
      subtitle={vi.filterTextHint}
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
        {fields.map((item) => (
          <Controller
            key={item.name}
            control={control}
            name={item.name}
            rules={{
              validate: (value) =>
                item.name === 'text'
                  ? true
                  : item.name === 'minAmount'
                    ? amountError(value, { zero: true, optional: true })
                    : amountRangeError(value, getValues('minAmount')),
            }}
            render={({ field, fieldState }) => (
              <FieldFeedback
                fieldRef={field.ref}
                message={fieldState.error?.message}
              >
                {item.name.includes('Amount') ? (
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
        {(['from', 'to'] as const).map((name) => (
          <Controller
            key={name}
            control={control}
            name={name}
            rules={{
              validate: (value) =>
                name === 'from'
                  ? dateError(value, true)
                  : endDateError(value, getValues('from'), true),
            }}
            render={({ field, fieldState }) => (
              <FieldFeedback
                fieldRef={field.ref}
                message={fieldState.error?.message}
              >
                <DateField
                  error={!!fieldState.error}
                  label={name === 'from' ? vi.filterFrom : vi.filterTo}
                  value={field.value}
                  onChange={field.onChange}
                  disabled={disabled}
                  allowClear
                />
              </FieldFeedback>
            )}
          />
        ))}
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
          render={({ field, fieldState }) => (
            <FieldFeedback
              fieldRef={field.ref}
              message={fieldState.error?.message}
            >
              <AppleMenuPicker
                label={vi.transactionKind}
                value={field.value}
                disabled={disabled}
                onSelect={(value) => {
                  field.onChange(value);
                  setValue('categoryId', '');
                }}
                options={[
                  { value: '', label: vi.filterAll },
                  { value: 'expense', label: vi.transactionExpense },
                  { value: 'income', label: vi.transactionIncome },
                  { value: 'transfer', label: vi.transactionTransfer },
                ]}
              />
            </FieldFeedback>
          )}
        />
        <Controller
          control={control}
          name="walletId"
          render={({ field, fieldState }) => (
            <FieldFeedback
              fieldRef={field.ref}
              message={fieldState.error?.message}
            >
              <AppleMenuPicker
                label={vi.transactionWallet}
                value={field.value}
                disabled={disabled}
                onSelect={field.onChange}
                options={[
                  { value: '', label: vi.filterAll },
                  ...wallets.map((w) => ({
                    value: w.id,
                    label: `${displayWalletName(w.name)}${w.is_archived ? ` · ${vi.transactionArchivedReference}` : ''}`,
                  })),
                ]}
              />
            </FieldFeedback>
          )}
        />
        <Text variant="bodySmall" style={{ color: palette.textMuted }}>
          {vi.filterCategoryHint}
        </Text>
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
                disabled={disabled}
                onSelect={field.onChange}
                options={[
                  { value: '', label: vi.filterAll },
                  ...orderCategoriesByParent(categories).map((c) => ({
                    value: c.id,
                    label: `${c.parent_id ? `${displayCategoryName(categories.find((p) => p.id === c.parent_id)?.name)} › ` : ''}${displayCategoryName(c.name)}${c.is_archived ? ` · ${vi.transactionArchivedReference}` : ''}`,
                  })),
                ]}
              />
            </FieldFeedback>
          )}
        />
      </View>
    </Screen>
  );
}
