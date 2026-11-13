import MaterialCommunityIcons from '@/components/platform-icon';
import { DatePicker, Host } from '@expo/ui/swift-ui';
import { datePickerStyle } from '@expo/ui/swift-ui/modifiers';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Button, HelperText, Text } from 'react-native-paper';
import {
  createSoftShadow,
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
} from '@/constants/theme';
import { vi } from '@/messages/vi';
import { vietnamToday } from '@/utils/calendar';
import { formatDisplayDate } from '@/utils/display';
import type { DateFieldProps } from './date-field';
import {
  formatLocalDateToIso,
  parseIsoDateToLocalDate,
} from './date-field-helpers';

/**
 * iOS date field displaying a tappable form row backed by a native SwiftUI graphical DatePicker sheet
 * with explicit Today and Clear actions so optional dates can be cleared cleanly.
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
  const today = vietnamToday();
  const [draftDate, setDraftDate] = useState<Date>(() =>
    parseIsoDateToLocalDate(value, today),
  );

  const openPicker = () => {
    if (disabled) return;
    setDraftDate(parseIsoDateToLocalDate(value, today));
    setOpen(true);
  };

  const commitValue = (nextIso: string) => {
    onChange(nextIso);
    setOpen(false);
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled, expanded: open }}
        accessibilityLabel={
          label +
          ': ' +
          (value ? formatDisplayDate(value) : vi.datePickerChoose)
        }
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
            {value ? formatDisplayDate(value) : vi.datePickerChoose}
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
              <DatePicker
                title={label}
                selection={draftDate}
                displayedComponents={['date']}
                onDateChange={setDraftDate}
                modifiers={[datePickerStyle('graphical')]}
              />
            </Host>

            <View style={styles.sheetActions}>
              <Button
                hitSlop={4}
                mode="text"
                onPress={() => commitValue(today)}
                textColor={theme.brand.primaryText}
              >
                {vi.datePickerToday}
              </Button>
              {allowClear && (
                <Button
                  hitSlop={4}
                  mode="text"
                  onPress={() => commitValue('')}
                  textColor={theme.finance.expense}
                >
                  {vi.clear}
                </Button>
              )}
              <Button hitSlop={4} mode="text" onPress={() => setOpen(false)}>
                {vi.cancel}
              </Button>
              <Button
                hitSlop={4}
                mode="contained"
                onPress={() => commitValue(formatLocalDateToIso(draftDate))}
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
    maxWidth: 380,
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
