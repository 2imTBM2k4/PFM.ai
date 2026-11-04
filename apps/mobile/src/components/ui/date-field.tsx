import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useMemo, useState } from 'react';
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
import { activeLanguage } from '@/messages/language';
import { formatDisplayDate } from '@/utils/display';
import {
  calendarDays,
  calendarMonth,
  shiftCalendarMonth,
  vietnamToday,
  parseDisplayMonth,
  type CalendarMonth,
} from '@/utils/calendar';
import { validateDate } from '@pfm/domain';

const monthLabel = (month: CalendarMonth) =>
  `${String(month.month + 1).padStart(2, '0')}/${String(month.year).padStart(4, '0')}`;

export interface DateFieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  error?: boolean;
  helperText?: string;
  allowClear?: boolean;
}

/**
 * Tappable date field backed by a compact calendar sheet.
 * The stored value remains YYYY-MM-DD so existing parsers and contracts are unchanged.
 */
export function DateField({
  label,
  value,
  onChange,
  disabled = false,
  error = false,
  helperText,
  allowClear = false,
}: DateFieldProps) {
  const theme = useDesignTheme();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => calendarMonth(value));
  const [jump, setJump] = useState(() => monthLabel(calendarMonth(value)));
  const [jumpError, setJumpError] = useState(false);
  const days = useMemo(() => calendarDays(view), [view]);
  const today = vietnamToday();

  const openPicker = () => {
    const next = calendarMonth(value);
    setView(next);
    setJump(monthLabel(next));
    setJumpError(false);
    setOpen(true);
  };

  const choose = (date: string) => {
    if (date !== '' || !allowClear) validateDate(date);
    onChange(date);
    setOpen(false);
  };

  const shiftMonth = (delta: number) => {
    const next = shiftCalendarMonth(view, delta);
    setView(next);
    setJump(monthLabel(next));
    setJumpError(false);
  };

  const jumpToMonth = () => {
    const next = parseDisplayMonth(jump);
    setJumpError(!next);
    if (next) {
      setView(next);
      setJump(monthLabel(next));
    }
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value ? formatDisplayDate(value) : vi.datePickerChoose}`}
        disabled={disabled}
        onPress={openPicker}
        style={[
          styles.field,
          createSoftShadow(theme.mode, 'sm'),
          {
            backgroundColor: theme.card.surfaceElevated,
            borderColor: error ? theme.finance.expense : theme.card.border,
            opacity: disabled ? 0.55 : 1,
          },
        ]}
      >
        <MaterialCommunityIcons
          name="calendar-month-outline"
          size={20}
          color={error ? theme.finance.expense : theme.text.secondary}
        />
        <View style={styles.fieldText}>
          <Text variant="labelSmall" style={{ color: theme.text.secondary }}>
            {label}
          </Text>
          <Text
            variant="bodyLarge"
            style={{ color: theme.text.primary, fontWeight: '600' }}
          >
            {value ? formatDisplayDate(value) : vi.datePickerChoose}
          </Text>
        </View>
        <MaterialCommunityIcons
          name="chevron-down"
          size={20}
          color={theme.text.muted}
        />
      </Pressable>
      {!!helperText && (
        <HelperText type={error ? 'error' : 'info'} visible>
          {helperText}
        </HelperText>
      )}

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
            <View style={styles.sheetHeader}>
              <IconButton
                icon="chevron-left"
                size={22}
                accessibilityLabel={vi.budgetPreviousMonth}
                disabled={view.year === 1 && view.month === 0}
                onPress={() => shiftMonth(-1)}
              />
              <Text
                variant="titleMedium"
                style={{ color: theme.text.primary, fontWeight: '700' }}
              >
                {activeLanguage === 'en' ? 'Month' : 'Tháng'} {view.month + 1}/{view.year}
              </Text>
              <IconButton
                icon="chevron-right"
                size={22}
                accessibilityLabel={vi.budgetNextMonth}
                disabled={view.year === 9999 && view.month === 11}
                onPress={() => shiftMonth(1)}
              />
            </View>

            <View style={styles.jumpRow}>
              <TextInput
                mode="outlined"
                label={activeLanguage === 'en' ? 'Month/year (MM/YYYY)' : 'Tháng/năm (MM/YYYY)'}
                accessibilityLabel={activeLanguage === 'en' ? 'Go to month/year (MM/YYYY)' : 'Chuyển đến tháng/năm (MM/YYYY)'}
                value={jump}
                onChangeText={(next) => {
                  setJump(next);
                  setJumpError(false);
                }}
                onSubmitEditing={jumpToMonth}
                autoCorrect={false}
                keyboardType="numbers-and-punctuation"
                maxLength={7}
                error={jumpError}
                style={styles.jumpInput}
              />
              <Button onPress={jumpToMonth}>{activeLanguage === 'en' ? 'Go' : 'Đi đến'}</Button>
            </View>
            {jumpError && (
              <HelperText type="error">
                {activeLanguage === 'en' ? 'Enter month 01–12 and year 0001–9999.' : 'Nhập tháng 01–12 và năm 0001–9999.'}
              </HelperText>
            )}

            <View style={styles.weekRow}>
              {['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map((day) => (
                <Text
                  key={day}
                  variant="labelSmall"
                  style={[styles.weekday, { color: theme.text.muted }]}
                >
                  {day}
                </Text>
              ))}
            </View>

            <View style={styles.daysGrid}>
              {days.map((day, index) =>
                day === null ? (
                  <View key={`empty-${index}`} style={styles.dayCell} />
                ) : (
                  <Pressable
                    key={day.date}
                    accessibilityRole="button"
                    accessibilityLabel={formatDisplayDate(day.date)}
                    accessibilityState={{ selected: day.date === value }}
                    onPress={() => choose(day.date)}
                    style={[
                      styles.dayCell,
                      day.date === today && {
                        borderColor: theme.brand.primary,
                        borderWidth: 1,
                      },
                      day.date === value && {
                        backgroundColor: theme.brand.primaryStrong,
                      },
                    ]}
                  >
                    <Text
                      variant="bodyMedium"
                      style={{
                        color:
                          day.date === value
                            ? theme.text.onPrimary
                            : theme.text.primary,
                        fontWeight: day.date === value ? '700' : '500',
                      }}
                    >
                      {day.day}
                    </Text>
                  </Pressable>
                ),
              )}
            </View>

            <View style={styles.sheetActions}>
              <Button
                mode="text"
                onPress={() => choose(today)}
                textColor={theme.brand.primaryText}
              >
                {vi.datePickerToday}
              </Button>
              {allowClear && (
                <Button
                  mode="text"
                  onPress={() => choose('')}
                  textColor={theme.finance.expense}
                >
                  {vi.clear}
                </Button>
              )}
              <Button mode="text" onPress={() => setOpen(false)}>
                {vi.cancel}
              </Button>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 58,
    borderWidth: 1,
    borderRadius: DesignRadius.sm,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  fieldText: {
    flex: 1,
    gap: 2,
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
    maxWidth: 360,
    borderRadius: DesignRadius.lg,
    borderWidth: 1,
    padding: DesignSpacing.md,
    gap: DesignSpacing.sm,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  jumpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  jumpInput: { flex: 1 },
  weekRow: {
    flexDirection: 'row',
    paddingHorizontal: 4,
  },
  weekday: {
    flex: 1,
    textAlign: 'center',
    fontWeight: '700',
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: `${100 / 7}%`,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: DesignRadius.xs,
  },
  sheetActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 4,
  },
});
