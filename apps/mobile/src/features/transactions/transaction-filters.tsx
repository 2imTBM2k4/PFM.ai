import {
  TransactionFiltersSchema,
  type TransactionFilters,
} from '@pfm/contracts';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';
import { Button, Text, TextInput, useTheme } from 'react-native-paper';
import { AppleMenuPicker, DateField, MoneyInput } from '@/components/ui';
import { Screen, styles } from '@/components/screen';
import { useFinancePalette } from '@/constants/theme';
import type { WalletRow } from '@/data/repository';
import type { CategoryRow } from '@/data/categories';
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
  const {
    control,
    handleSubmit,
    setValue,
    formState: { isSubmitting },
  } = useForm<Fields>({
    defaultValues: {
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
    },
  });
  const [error, setError] = useState('');
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const disabled = busy || isSubmitting;
  const fields = [
    { name: 'text', label: vi.filterText, icon: 'magnify' },
    { name: 'minAmount', label: vi.filterMinAmount, icon: 'cash-minus' },
    { name: 'maxAmount', label: vi.filterMaxAmount, icon: 'cash-plus' },
  ] as const;
  return (
    <Screen
      title={vi.transactionFilters}
      subtitle={vi.filterTextHint}
      onBack={onBack}
      backDisabled={disabled}
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
            render={({ field }) =>
              item.name.includes('Amount') ? (
                <MoneyInput
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
              )
            }
          />
        ))}
        {(['from', 'to'] as const).map((name) => (
          <Controller
            key={name}
            control={control}
            name={name}
            render={({ field }) => (
              <DateField
                label={name === 'from' ? vi.filterFrom : vi.filterTo}
                value={field.value}
                onChange={field.onChange}
                disabled={disabled}
                allowClear
              />
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
          render={({ field }) => (
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
          )}
        />
        <Controller
          control={control}
          name="walletId"
          render={({ field }) => (
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
          )}
        />
        <Text variant="bodySmall" style={{ color: palette.textMuted }}>
          {vi.filterCategoryHint}
        </Text>
        <Controller
          control={control}
          name="categoryId"
          render={({ field }) => (
            <AppleMenuPicker
              label={vi.transactionCategory}
              value={field.value}
              disabled={disabled}
              onSelect={field.onChange}
              options={[
                { value: '', label: vi.filterAll },
                ...categories.map((c) => ({
                  value: c.id,
                  label: `${c.parent_id ? `${displayCategoryName(categories.find((p) => p.id === c.parent_id)?.name)} › ` : ''}${displayCategoryName(c.name)}${c.is_archived ? ` · ${vi.transactionArchivedReference}` : ''}`,
                })),
              ]}
            />
          )}
        />
      </View>

      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}
      <Button
        contentStyle={styles.button}
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
              onApply(parsed);
            } catch {
              setError(vi.filterInvalid);
            }
          })();
        }}
      >
        {vi.filterApply}
      </Button>
      <Button
        mode="outlined"
        icon="filter-remove-outline"
        contentStyle={styles.button}
        disabled={disabled}
        onPress={() => onApply({})}
      >
        {vi.filterClear}
      </Button>
    </Screen>
  );
}
