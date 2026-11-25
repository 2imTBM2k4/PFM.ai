import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { monthKey } from '@pfm/domain';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Button, HelperText, IconButton, Text } from 'react-native-paper';
import {
  createSoftShadow,
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
} from '@/constants/theme';
import { activeLanguage } from '@/messages/language';
import { vi } from '@/messages/vi';
import {
  calendarMonthFromKey,
  formatCalendarMonthKey,
  vietnamToday,
} from '@/utils/calendar';
import { formatDisplayMonth } from '@/utils/display';

export interface MonthFieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  error?: boolean;
  helperText?: string;
  allowClear?: boolean;
}

/**
 * Tappable month/year selector field backed by a 12-month modal sheet.
 * Stores canonical `YYYY-MM` (or `""` when cleared via `allowClear`).
 */
export function MonthField({
  label,
  value,
  onChange,
  disabled = false,
  error = false,
  helperText,
  allowClear = false,
}: MonthFieldProps) {
  const theme = useDesignTheme();
  const [open, setOpen] = useState(false);
  const currentMonthKey = vietnamToday().slice(0, 7);
  const [year, setYear] = useState(
    () => calendarMonthFromKey(value, currentMonthKey).year,
  );

  const openPicker = () => {
    const parsed = calendarMonthFromKey(value, currentMonthKey);
    setYear(parsed.year);
    setOpen(true);
  };

  const choose = (nextMonthKey: string) => {
    if (nextMonthKey !== '' || !allowClear) {
      monthKey(`${nextMonthKey}-01`);
    }
    onChange(nextMonthKey);
    setOpen(false);
  };

  const displayLabel = value ? formatDisplayMonth(value) : vi.datePickerChoose;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${displayLabel}`}
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
            {displayLabel}
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
                disabled={year <= 1}
                onPress={() => setYear((y) => Math.max(1, y - 1))}
              />
              <Text
                variant="titleMedium"
                style={{ color: theme.text.primary, fontWeight: '700' }}
              >
                {activeLanguage === 'en' ? 'Year' : 'Năm'} {year}
              </Text>
              <IconButton
                icon="chevron-right"
                size={22}
                accessibilityLabel={vi.budgetNextMonth}
                disabled={year >= 9999}
                onPress={() => setYear((y) => Math.min(9999, y + 1))}
              />
            </View>

            <View style={styles.monthsGrid}>
              {Array.from({ length: 12 }, (_, monthIndex) => {
                const candidateKey = formatCalendarMonthKey({
                  year,
                  month: monthIndex,
                });
                const isSelected = candidateKey === value;
                const isCurrent = candidateKey === currentMonthKey;
                const cellLabel =
                  activeLanguage === 'en'
                    ? `${String(monthIndex + 1).padStart(2, '0')}/${year}`
                    : `Thg ${monthIndex + 1}`;
                return (
                  <Pressable
                    key={candidateKey}
                    accessibilityRole="button"
                    accessibilityLabel={formatDisplayMonth(candidateKey)}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => choose(candidateKey)}
                    style={[
                      styles.monthCell,
                      isCurrent && {
                        borderColor: theme.brand.primary,
                        borderWidth: 1,
                      },
                      isSelected && {
                        backgroundColor: theme.brand.primaryStrong,
                      },
                    ]}
                  >
                    <Text
                      variant="bodyMedium"
                      style={{
                        color: isSelected
                          ? theme.text.onPrimary
                          : theme.text.primary,
                        fontWeight: isSelected ? '700' : '600',
                      }}
                    >
                      {cellLabel}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.sheetActions}>
              <Button
                hitSlop={4}
                mode="text"
                onPress={() => choose(currentMonthKey)}
                textColor={theme.brand.primaryText}
              >
                {activeLanguage === 'en' ? 'This month' : 'Tháng này'}
              </Button>
              {allowClear && (
                <Button
                  hitSlop={4}
                  mode="text"
                  onPress={() => choose('')}
                  textColor={theme.finance.expense}
                >
                  {vi.clear}
                </Button>
              )}
              <Button hitSlop={4} mode="text" onPress={() => setOpen(false)}>
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
  monthsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
  },
  monthCell: {
    width: '30%',
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: DesignRadius.sm,
  },
  sheetActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 4,
  },
});
