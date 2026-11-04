import { useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  Button,
  HelperText,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import { Pressable, View } from 'react-native';
import { MAX_AMOUNT_VND } from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import { IconBadge, Screen, styles } from '@/components/screen';
import { useFinancePalette } from '@/constants/theme';
import { vi } from '@/messages/vi';
import { useApp } from '@/state/app';
import { PinSettings } from '@/features/lock/pin-controls';

const PRESET_BALANCES = [0, 1_500_000, 5_000_000, 10_000_000] as const;

export function Onboarding() {
  const {
    control,
    setValue,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm({ defaultValues: { balance: '' } });
  const [error, setError] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const complete = useApp((state) => state.completeOnboarding);
  const theme = useTheme();
  const palette = useFinancePalette();
  const saving = useRef(false);
  async function save(balance: number) {
    if (saving.current) return;
    saving.current = true;
    setError(false);
    try {
      await complete(balance);
    } catch {
      setError(true);
    } finally {
      saving.current = false;
    }
  }
  return (
    <Screen title={vi.welcome} subtitle={vi.welcomeDescription}>
      <View
        style={[
          styles.panel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        <View style={styles.inlineRow}>
          <IconBadge
            icon="wallet-plus-outline"
            bg={palette.primarySoft}
            fg={palette.primaryInk}
            size={44}
            iconSize={22}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="titleMedium" style={{ fontWeight: '700' }}>
              {vi.startingBalance}
            </Text>
            <Text variant="bodySmall" style={{ color: palette.textMuted }}>
              {vi.balanceHint}
            </Text>
          </View>
        </View>

        <Controller
          control={control}
          name="balance"
          rules={{
            validate: (value) =>
              value === '' ||
              (/^\d+$/.test(value) && Number(value) <= MAX_AMOUNT_VND) ||
              vi.invalidAmount,
          }}
          render={({ field: { value, onChange, onBlur }, fieldState }) => (
            <View style={{ gap: 8 }}>
              <TextInput
                mode="outlined"
                label={vi.startingBalance}
                accessibilityLabel={vi.startingBalance}
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                keyboardType="number-pad"
                maxLength={12}
                error={!!fieldState.error}
                disabled={isSubmitting || skipping}
                left={<TextInput.Icon icon="cash" />}
              />
              {!!fieldState.error && (
                <HelperText type="error">{fieldState.error.message}</HelperText>
              )}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {PRESET_BALANCES.map((preset) => {
                  const selected = value === String(preset);
                  return (
                    <Pressable
                      key={preset}
                      disabled={isSubmitting || skipping}
                      onPress={() =>
                        setValue('balance', String(preset), {
                          shouldValidate: true,
                        })
                      }
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: selected
                          ? palette.primary
                          : palette.border,
                        backgroundColor: selected
                          ? palette.primarySoft
                          : palette.surfaceMuted,
                      }}
                    >
                      <Text
                        variant="labelMedium"
                        style={[
                          styles.number,
                          {
                            color: selected ? palette.primaryInk : palette.text,
                            fontWeight: '600',
                          },
                        ]}
                      >
                        {formatVnd(preset)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}
        />
      </View>

      <View
        style={[
          styles.subtlePanel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        <View style={styles.inlineRow}>
          <IconBadge
            icon="shield-check-outline"
            bg={palette.tealSoft}
            fg={palette.tealInk}
            size={38}
            iconSize={20}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="titleSmall" style={{ fontWeight: '700' }}>
              {vi.previewTitle}
            </Text>
            <Text variant="bodySmall" style={{ color: palette.textMuted }}>
              {vi.previewDescription}
            </Text>
          </View>
        </View>
      </View>

      <View
        style={[
          styles.subtlePanel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        <PinSettings />
      </View>

      {error && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.error }}>
          {vi.saveError}
        </Text>
      )}
      <Button
        mode="contained"
        icon="arrow-right"
        contentStyle={[styles.button, { flexDirection: 'row-reverse' }]}
        loading={isSubmitting}
        disabled={isSubmitting || skipping}
        onPress={() => {
          void handleSubmit(({ balance }) => save(Number(balance || '0')))();
        }}
      >
        {vi.start}
      </Button>
      <Button
        mode="outlined"
        contentStyle={styles.button}
        disabled={isSubmitting || skipping}
        loading={skipping}
        onPress={async () => {
          setSkipping(true);
          try {
            await save(0);
          } finally {
            setSkipping(false);
          }
        }}
      >
        {vi.skip}
      </Button>
    </Screen>
  );
}
