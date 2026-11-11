import { DatePicker, Host } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as accessibilityLabelModifier,
  datePickerStyle,
  disabled as disabledModifier,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';
import { useDesignTheme } from '@/constants/theme';
import type { TimeFieldProps } from './time-field';
import { formatDateToTime, parseTimeToLocalDate } from './time-field-helpers';

/**
 * Native iOS time picker backed by SwiftUI DatePicker in hourAndMinute mode,
 * supporting arbitrary times such as 07:10.
 */
export function TimeField({
  label,
  value,
  onChange,
  disabled = false,
  accessibilityLabel,
}: TimeFieldProps) {
  const theme = useDesignTheme();
  const selection = parseTimeToLocalDate(value);

  return (
    <View style={[styles.wrap, disabled && styles.disabled]}>
      <Host
        matchContents={{ horizontal: true, vertical: true }}
        colorScheme={theme.mode}
        style={styles.host}
      >
        <DatePicker
          title={label}
          selection={selection}
          displayedComponents={['hourAndMinute']}
          onDateChange={(nextDate) => {
            const formatted = formatDateToTime(nextDate);
            if (formatted !== value) {
              onChange(formatted);
            }
          }}
          modifiers={[
            datePickerStyle('compact'),
            disabledModifier(disabled),
            accessibilityLabelModifier(
              (accessibilityLabel ?? label) + ': ' + value,
            ),
          ]}
        />
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'flex-end',
    flexShrink: 0,
  },
  host: {
    minHeight: 36,
  },
  disabled: {
    opacity: 0.55,
  },
});
