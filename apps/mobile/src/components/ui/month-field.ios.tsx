import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Host, HStack, Picker, Text as SwiftUIText } from '@expo/ui/swift-ui';
import { frame, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Button, HelperText, Text } from 'react-native-paper';
import {
  createSoftShadow,
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
} from '@/constants/theme';
import { vi } from '@/messages/vi';
import { usePreferences } from '@/state/preferences';
import { vietnamToday } from '@/utils/calendar';
import { formatDisplayMonth } from '@/utils/display';
import type { MonthFieldProps } from './month-field';
import {
  buildMonthYearOptions,
  formatMonthDraftToKey,
  getMonthWheelLabels,
  parseMonthKeyToDraft,
  type MonthDraft,
} from './month-field-helpers';

/**
 * iOS month selector backed by side-by-side SwiftUI wheel Pickers for month and year
 * with explicit This month and Clear actions.
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
  const language = usePreferences((state) => state.language);
  const [open, setOpen] = useState(false);
  const currentMonthKey = vietnamToday().slice(0, 7);
  const currentYear = Number(currentMonthKey.slice(0, 4));
  const [draft, setDraft] = useState<MonthDraft>(() =>
    parseMonthKeyToDraft(value, currentMonthKey),
  );

  const monthLabels = useMemo(
    () => getMonthWheelLabels(language, vi.monthPickerMonth),
    [language],
  );
  const yearOptions = useMemo(
    () => buildMonthYearOptions(draft.year, currentYear, 30),
    [draft.year, currentYear],
  );

  const openPicker = () => {
    if (disabled) return;
    setDraft(parseMonthKeyToDraft(value, currentMonthKey));
    setOpen(true);
  };

  const commitValue = (nextMonthKey: string) => {
    onChange(nextMonthKey);
    setOpen(false);
  };

  const displayLabel = value ? formatDisplayMonth(value) : vi.datePickerChoose;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled, expanded: open }}
        accessibilityLabel={label + ': ' + displayLabel}
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
        <SymbolView
          name="calendar"
          size={20}
          tintColor={error ? theme.finance.expense : theme.text.secondary}
          fallback={
            <MaterialCommunityIcons
              name="calendar-month-outline"
              size={20}
              color={error ? theme.finance.expense : theme.text.secondary}
            />
          }
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
        <SymbolView
          name="chevron.down"
          size={16}
          tintColor={theme.text.muted}
          fallback={
            <MaterialCommunityIcons
              name="chevron-down"
              size={20}
              color={theme.text.muted}
            />
          }
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
            <Text
              variant="titleMedium"
              style={{ color: theme.text.primary, fontWeight: '700' }}
            >
              {label}
            </Text>

            <Host
              matchContents={{ vertical: true }}
              colorScheme={theme.mode}
              style={styles.host}
            >
              <HStack spacing={8} alignment="center">
                <Picker
                  label={vi.monthPickerMonth}
                  selection={draft.monthIndex}
                  onSelectionChange={(nextMonth) => {
                    if (typeof nextMonth === 'number') {
                      setDraft((prev) => ({ ...prev, monthIndex: nextMonth }));
                    }
                  }}
                  modifiers={[
                    pickerStyle('wheel'),
                    frame({ width: 165, height: 180 }),
                  ]}
                >
                  {monthLabels.map((monthText, monthIndex) => (
                    <SwiftUIText
                      key={monthIndex}
                      modifiers={[tag(monthIndex)]}
                    >
                      {monthText}
                    </SwiftUIText>
                  ))}
                </Picker>

                <Picker
                  label={vi.monthPickerYear}
                  selection={draft.year}
                  onSelectionChange={(nextYear) => {
                    if (typeof nextYear === 'number') {
                      setDraft((prev) => ({ ...prev, year: nextYear }));
                    }
                  }}
                  modifiers={[
                    pickerStyle('wheel'),
                    frame({ width: 130, height: 180 }),
                  ]}
                >
                  {yearOptions.map((yearOption) => (
                    <SwiftUIText
                      key={yearOption}
                      modifiers={[tag(yearOption)]}
                    >
                      {String(yearOption)}
                    </SwiftUIText>
                  ))}
                </Picker>
              </HStack>
            </Host>

            <View style={styles.sheetActions}>
              <Button
                mode="text"
                onPress={() => commitValue(currentMonthKey)}
                textColor={theme.brand.primaryText}
              >
                {vi.monthPickerThisMonth}
              </Button>
              {allowClear && (
                <Button
                  mode="text"
                  onPress={() => commitValue('')}
                  textColor={theme.finance.expense}
                >
                  {vi.clear}
                </Button>
              )}
              <Button mode="text" onPress={() => setOpen(false)}>
                {vi.cancel}
              </Button>
              <Button
                mode="contained"
                onPress={() => commitValue(formatMonthDraftToKey(draft))}
              >
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
  host: {
    width: '100%',
  },
  sheetActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 4,
  },
});
