import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import {
  Button,
  HelperText,
  IconButton,
  Text,
  TextInput,
} from 'react-native-paper';
import {
  createSoftShadow,
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
} from '@/constants/theme';
import { vi } from '@/messages/vi';
import {
  formatHourMinute,
  parseHourMinuteInputs,
  parseReminderTime,
} from './time-field-helpers';

export interface TimeFieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  accessibilityLabel?: string;
}

/**
 * Android and web time picker trigger backed by an editable HH:MM modal with 1-minute steppers
 * so any arbitrary time (such as 07:10) can be chosen cleanly.
 */
export function TimeField({
  label,
  value,
  onChange,
  disabled = false,
  accessibilityLabel,
}: TimeFieldProps) {
  const theme = useDesignTheme();
  const [open, setOpen] = useState(false);
  const [hourText, setHourText] = useState('20');
  const [minuteText, setMinuteText] = useState('00');
  const [error, setError] = useState('');

  const openModal = () => {
    if (disabled) return;
    const parsed = parseReminderTime(value);
    setHourText(String(parsed.hour).padStart(2, '0'));
    setMinuteText(String(parsed.minute).padStart(2, '0'));
    setError('');
    setOpen(true);
  };

  const stepValues = (deltaHour: number, deltaMinute: number) => {
    const valid = parseHourMinuteInputs(hourText, minuteText);
    const base = valid ? parseReminderTime(valid) : parseReminderTime(value);
    const formatted = formatHourMinute(
      base.hour + deltaHour,
      base.minute + deltaMinute,
    );
    const [nextHour, nextMinute] = formatted.split(':');
    setHourText(nextHour ?? '20');
    setMinuteText(nextMinute ?? '00');
    setError('');
  };

  const handleConfirm = () => {
    const parsed = parseHourMinuteInputs(hourText, minuteText);
    if (!parsed) {
      setError(vi.timePickerInvalid);
      return;
    }
    onChange(parsed);
    setOpen(false);
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled, expanded: open }}
        accessibilityLabel={(accessibilityLabel ?? label) + ': ' + value}
        disabled={disabled}
        onPress={openModal}
        style={[
          styles.triggerPill,
          {
            backgroundColor: theme.card.surfaceSubtle,
            borderColor: theme.card.border,
            opacity: disabled ? 0.55 : 1,
          },
        ]}
      >
        <MaterialCommunityIcons
          name="clock-outline"
          size={18}
          color={theme.text.secondary}
        />
        <Text
          variant="titleMedium"
          style={[styles.triggerText, { color: theme.text.primary }]}
        >
          {value}
        </Text>
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={vi.close}
            style={StyleSheet.absoluteFill}
            onPress={() => setOpen(false)}
          />
          <View
            style={[
              styles.sheet,
              createSoftShadow(theme.mode, 'lg'),
              {
                backgroundColor: theme.card.surfaceElevated,
                borderColor: theme.card.border,
              },
            ]}
          >
            <Text
              variant="titleMedium"
              style={{ color: theme.text.primary, fontWeight: '700' }}
            >
              {label}
            </Text>

            <View style={styles.inputsRow}>
              <View style={styles.unitColumn}>
                <IconButton
                  icon="chevron-up"
                  size={20}
                  accessibilityLabel={vi.timePickerHour}
                  onPress={() => stepValues(1, 0)}
                />
                <TextInput
                  mode="outlined"
                  label={vi.timePickerHour}
                  accessibilityLabel={vi.timePickerHour}
                  value={hourText}
                  onChangeText={(next) => {
                    setHourText(next.replace(/[^0-9]/g, '').slice(0, 2));
                    setError('');
                  }}
                  keyboardType="number-pad"
                  maxLength={2}
                  error={!!error}
                  style={styles.numberInput}
                />
                <IconButton
                  icon="chevron-down"
                  size={20}
                  accessibilityLabel={vi.timePickerHour}
                  onPress={() => stepValues(-1, 0)}
                />
              </View>

              <Text
                variant="headlineMedium"
                style={{ color: theme.text.primary, fontWeight: '700' }}
              >
                :
              </Text>

              <View style={styles.unitColumn}>
                <IconButton
                  icon="chevron-up"
                  size={20}
                  accessibilityLabel={vi.timePickerMinute}
                  onPress={() => stepValues(0, 1)}
                />
                <TextInput
                  mode="outlined"
                  label={vi.timePickerMinute}
                  accessibilityLabel={vi.timePickerMinute}
                  value={minuteText}
                  onChangeText={(next) => {
                    setMinuteText(next.replace(/[^0-9]/g, '').slice(0, 2));
                    setError('');
                  }}
                  keyboardType="number-pad"
                  maxLength={2}
                  error={!!error}
                  style={styles.numberInput}
                />
                <IconButton
                  icon="chevron-down"
                  size={20}
                  accessibilityLabel={vi.timePickerMinute}
                  onPress={() => stepValues(0, -1)}
                />
              </View>
            </View>

            {!!error && <HelperText type="error">{error}</HelperText>}

            <View style={styles.actions}>
              <Button mode="text" onPress={() => setOpen(false)}>
                {vi.cancel}
              </Button>
              <Button mode="contained" onPress={handleConfirm}>
                {vi.done}
              </Button>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  triggerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
    minHeight: 44,
  },
  triggerText: {
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: DesignSpacing.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 340,
    borderRadius: DesignRadius.lg,
    borderWidth: 1,
    padding: DesignSpacing.md,
    gap: DesignSpacing.sm,
  },
  inputsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  unitColumn: {
    alignItems: 'center',
    width: 92,
  },
  numberInput: {
    width: 84,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
});
