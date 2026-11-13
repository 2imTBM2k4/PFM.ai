import {
  Circle,
  Host,
  HStack,
  Image,
  Label,
  Menu,
  Picker,
  Text as SwiftUIText,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel as accessibilityLabelModifier,
  background,
  buttonStyle,
  clipShape,
  contentTransition,
  disabled as disabledModifier,
  foregroundStyle,
  frame,
  geometryGroup,
  lineLimit,
  menuOrder,
  menuStyle,
  padding,
  pickerStyle,
  shapes,
  tag,
  truncationMode,
} from '@expo/ui/swift-ui/modifiers';
import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useDesignTheme } from '@/constants/theme';
import { vi } from '@/messages/vi';
import { toSfSymbol } from '@/utils/sf-symbols';
import type { AppleMenuPickerProps } from './apple-menu-picker';
import {
  formatPickerOptionLabel,
  resolveSelectedOption,
} from './picker-helpers';

/**
 * Native iOS menu picker backed by SwiftUI Menu and inline Picker with SF Symbols.
 */
function AppleMenuPickerInner<T extends string | number>({
  label,
  value,
  options,
  onSelect,
  disabled = false,
  placeholder = vi.pickerChoose,
  accessibilityLabel,
  helperText,
}: AppleMenuPickerProps<T>) {
  const theme = useDesignTheme();
  const selectedOption = useMemo(
    () => resolveSelectedOption(options, value),
    [options, value],
  );
  const displayTitle = selectedOption?.label ?? placeholder;
  const pillBackground =
    theme.mode === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)';
  const selectedSfSymbol = toSfSymbol(selectedOption?.icon);

  return (
    <View style={[styles.container, disabled && styles.disabledContainer]}>
      <View style={styles.rowWrapper}>
        <Text style={[styles.rowLabel, { color: theme.text.primary }]}>
          {label}
        </Text>

        <View style={styles.triggerHostWrap}>
          <Host
            matchContents={{ vertical: true }}
            alignment="trailing"
            colorScheme={theme.mode}
            style={styles.host}
          >
            <Menu
              label={
                <HStack
                  spacing={6}
                  alignment="center"
                  modifiers={[
                    padding({ vertical: 7, horizontal: 11 }),
                    background(
                      pillBackground,
                      shapes.roundedRectangle({ cornerRadius: 14 }),
                    ),
                    clipShape('roundedRectangle', 14),
                    geometryGroup(),
                  ]}
                >
                  {selectedOption?.colorSwatch ? (
                    <Circle
                      modifiers={[
                        frame({ width: 14, height: 14 }),
                        foregroundStyle(selectedOption.colorSwatch),
                      ]}
                    />
                  ) : selectedSfSymbol ? (
                    <Image
                      systemName={selectedSfSymbol}
                      size={14}
                      color={selectedOption?.iconColor ?? theme.text.primary}
                    />
                  ) : null}
                  <SwiftUIText
                    modifiers={[
                      lineLimit(1),
                      truncationMode('tail'),
                      contentTransition('identity'),
                      foregroundStyle(theme.text.primary),
                    ]}
                  >
                    {displayTitle}
                  </SwiftUIText>
                  <Image
                    systemName="chevron.up.chevron.down"
                    size={12}
                    color={theme.text.muted}
                  />
                </HStack>
              }
              modifiers={[
                menuStyle('button'),
                buttonStyle('plain'),
                menuOrder('fixed'),
                disabledModifier(disabled),
                accessibilityLabelModifier(
                  (accessibilityLabel ?? label) + ': ' + displayTitle,
                ),
              ]}
            >
              <Picker
                label={label}
                selection={value}
                onSelectionChange={(nextValue) => {
                  if (nextValue === null || nextValue === undefined) return;
                  if (nextValue !== value) {
                    onSelect(nextValue as T);
                  }
                }}
                modifiers={[pickerStyle('inline')]}
              >
                {options.map((option) => {
                  const optionLabel = formatPickerOptionLabel(option);
                  const sfSymbol = toSfSymbol(option.icon);
                  return sfSymbol ? (
                    <Label
                      key={String(option.value)}
                      title={optionLabel}
                      systemImage={sfSymbol}
                      modifiers={[tag(option.value)]}
                    />
                  ) : (
                    <SwiftUIText
                      key={String(option.value)}
                      modifiers={[tag(option.value)]}
                    >
                      {optionLabel}
                    </SwiftUIText>
                  );
                })}
              </Picker>
            </Menu>
          </Host>
        </View>
      </View>

      {!!helperText && (
        <Text style={[styles.helperText, { color: theme.text.muted }]}>
          {helperText}
        </Text>
      )}
    </View>
  );
}

export const AppleMenuPicker = memo(
  AppleMenuPickerInner,
) as typeof AppleMenuPickerInner;

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  disabledContainer: {
    opacity: 0.55,
  },
  rowWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingVertical: 6,
    gap: 12,
  },
  rowLabel: {
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
    maxWidth: '46%',
  },
  triggerHostWrap: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-end',
    overflow: 'hidden',
  },
  host: {
    width: '100%',
    minHeight: 34,
  },
  helperText: {
    fontSize: 12,
    marginTop: 2,
    paddingHorizontal: 2,
  },
});
