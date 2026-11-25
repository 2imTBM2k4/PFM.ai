import { Host, Picker, Text as SwiftUIText } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as accessibilityLabelModifier,
  disabled as disabledModifier,
  pickerStyle,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from 'react-native-paper';
import { useDesignTheme } from '@/constants/theme';
import type { SegmentedOptionPickerProps } from './segmented-option-picker';

/**
 * Native iOS segmented picker backed by SwiftUI Picker with segmented style.
 */
export function SegmentedOptionPicker<T extends string>({
  label,
  value,
  options,
  onSelect,
  disabled = false,
  accessibilityLabel,
}: SegmentedOptionPickerProps<T>) {
  const theme = useDesignTheme();
  const { fontScale = 1 } = useWindowDimensions();
  const resolvedLabel = accessibilityLabel ?? label ?? '';

  return (
    <View style={[styles.container, disabled && styles.disabled]}>
      {!!label && (
        <Text
          variant="labelMedium"
          style={[styles.label, { color: theme.text.secondary }]}
        >
          {label}
        </Text>
      )}
      <Host
        matchContents={{ vertical: true }}
        colorScheme={theme.mode}
        style={styles.host}
      >
        <Picker
          label={resolvedLabel}
          selection={value}
          onSelectionChange={(nextValue) => {
            if (typeof nextValue === 'string' && nextValue !== value) {
              onSelect(nextValue as T);
            }
          }}
          modifiers={[
            pickerStyle(fontScale > 1.3 ? 'menu' : 'segmented'),
            disabledModifier(disabled),
            accessibilityLabelModifier(resolvedLabel),
          ]}
        >
          {options.map((option) => (
            <SwiftUIText
              key={option.value}
              modifiers={[
                tag(option.value),
                disabledModifier(Boolean(option.disabled)),
              ]}
            >
              {option.label}
            </SwiftUIText>
          ))}
        </Picker>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 6,
    width: '100%',
  },
  disabled: {
    opacity: 0.55,
  },
  label: {
    fontWeight: '600',
  },
  host: {
    width: '100%',
    minHeight: 32,
  },
});
