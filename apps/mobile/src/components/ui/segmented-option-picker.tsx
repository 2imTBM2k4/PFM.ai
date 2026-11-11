import { StyleSheet, View } from 'react-native';
import { SegmentedButtons, Text } from 'react-native-paper';
import { useDesignTheme } from '@/constants/theme';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SegmentedOptionPickerProps<T extends string> {
  label?: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onSelect(value: T): void;
  disabled?: boolean;
  accessibilityLabel?: string;
}

/**
 * Cross-platform segmented control using React Native Paper SegmentedButtons on Android and web.
 */
export function SegmentedOptionPicker<T extends string>({
  label,
  value,
  options,
  onSelect,
  disabled = false,
}: SegmentedOptionPickerProps<T>) {
  const theme = useDesignTheme();

  return (
    <View style={styles.container}>
      {!!label && (
        <Text
          variant="labelMedium"
          style={[styles.label, { color: theme.text.secondary }]}
        >
          {label}
        </Text>
      )}
      <SegmentedButtons
        value={value}
        density="small"
        onValueChange={(nextValue) => {
          if (nextValue !== value) {
            onSelect(nextValue as T);
          }
        }}
        buttons={options.map((option) => ({
          value: option.value,
          label: option.label,
          disabled: disabled || option.disabled,
          showSelectedCheck: false,
          labelStyle: styles.segmentLabel,
        }))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 6,
    width: '100%',
  },
  label: {
    fontWeight: '600',
  },
  segmentLabel: {
    fontSize: 12,
  },
});
