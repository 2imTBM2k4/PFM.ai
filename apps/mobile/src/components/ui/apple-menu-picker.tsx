import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { memo, useMemo, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {
  createSoftShadow,
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
} from '@/constants/theme';
import { vi } from '@/messages/vi';

export interface AppleMenuOption<T> {
  value: T;
  label: string;
  icon?: string;
  iconColor?: string;
  iconBg?: string;
  colorSwatch?: string;
  subtitle?: string;
}

export interface AppleMenuPickerProps<T> {
  label: string;
  value: T;
  options: readonly AppleMenuOption<T>[];
  onSelect(value: T): void;
  disabled?: boolean;
  placeholder?: string;
  accessibilityLabel?: string;
  helperText?: string;
}

/**
 * Apple-style menu picker component featuring:
 * 1. Clean form row trigger with squircle icon badge, label, and vertical unfold chevrons (↕)
 * 2. Floating frosted glass popup menu with iOS scale & spring animations and checkmark indicator on active item.
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
  const [modalVisible, setModalVisible] = useState(false);
  const theme = useDesignTheme();

  const scale = useSharedValue(0.85);
  const opacity = useSharedValue(0);
  const backdropOpacity = useSharedValue(0);
  const triggerScale = useSharedValue(1);

  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === value),
    [options, value],
  );

  const displayTitle = selectedOption?.label ?? placeholder;

  const openMenu = () => {
    if (disabled) return;
    setModalVisible(true);
    scale.set(0.85);
    opacity.set(0);
    backdropOpacity.set(0);
    scale.set(withSpring(1, { damping: 18, stiffness: 280, mass: 0.8 }));
    opacity.set(withTiming(1, { duration: 160 }));
    backdropOpacity.set(withTiming(1, { duration: 180 }));
  };

  const closeMenu = (callback?: () => void) => {
    scale.set(withTiming(0.88, { duration: 130 }));
    opacity.set(withTiming(0, { duration: 130 }));
    backdropOpacity.set(withTiming(0, { duration: 130 }));
    setTimeout(() => {
      setModalVisible(false);
      callback?.();
    }, 140);
  };

  const handleSelect = (optionValue: T) => {
    closeMenu(() => onSelect(optionValue));
  };

  const animatedTriggerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: triggerScale.value }],
  }));

  const animatedCardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const animatedBackdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  return (
    <View style={styles.container}>
      {/* Form Row Trigger */}
      <Pressable
        accessibilityRole="combobox"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled, expanded: modalVisible }}
        disabled={disabled}
        onPress={openMenu}
        onPressIn={() => {
          triggerScale.set(withSpring(0.97, { damping: 15, stiffness: 320 }));
        }}
        onPressOut={() => {
          triggerScale.set(withSpring(1, { damping: 15, stiffness: 320 }));
        }}
        style={styles.rowWrapper}
      >
        <Text style={[styles.rowLabel, { color: theme.text.primary }]}>
          {label}
        </Text>

        <Animated.View
          style={[
            styles.triggerPill,
            animatedTriggerStyle,
            {
              backgroundColor:
                theme.mode === 'dark'
                  ? 'rgba(255, 255, 255, 0.08)'
                  : 'rgba(0, 0, 0, 0.05)',
              borderColor:
                theme.mode === 'dark'
                  ? 'rgba(255, 255, 255, 0.12)'
                  : 'rgba(0, 0, 0, 0.08)',
            },
          ]}
        >
          {/* Selected Option Icon or Color Swatch */}
          {selectedOption?.colorSwatch ? (
            <View
              style={[
                styles.swatchCircle,
                { backgroundColor: selectedOption.colorSwatch },
              ]}
            />
          ) : selectedOption?.icon ? (
            <View
              style={[
                styles.iconSquircle,
                {
                  backgroundColor:
                    selectedOption.iconBg ??
                    (theme.mode === 'dark'
                      ? 'rgba(255, 255, 255, 0.12)'
                      : 'rgba(0, 0, 0, 0.08)'),
                },
              ]}
            >
              <MaterialCommunityIcons
                name={selectedOption.icon as never}
                size={16}
                color={selectedOption.iconColor ?? theme.text.primary}
              />
            </View>
          ) : null}

          <Text style={[styles.triggerText, { color: theme.text.primary }]}>
            {displayTitle}
          </Text>

          <MaterialCommunityIcons
            name="unfold-more-horizontal"
            size={18}
            color={theme.text.muted}
            style={styles.chevron}
          />
        </Animated.View>
      </Pressable>

      {!!helperText && (
        <Text style={[styles.helperText, { color: theme.text.muted }]}>
          {helperText}
        </Text>
      )}

      {/* Apple-style Floating Context Menu Popup with Spring & Fade Animation */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="none"
        onRequestClose={() => closeMenu()}
      >
        <TouchableWithoutFeedback onPress={() => closeMenu()}>
          <Animated.View style={[styles.modalBackdrop, animatedBackdropStyle]}>
            <TouchableWithoutFeedback>
              <Animated.View
                style={[
                  styles.popoverCard,
                  animatedCardStyle,
                  createSoftShadow(theme.mode, 'lg'),
                  {
                    backgroundColor:
                      theme.mode === 'dark'
                        ? 'rgba(28, 30, 44, 0.96)'
                        : 'rgba(255, 255, 255, 0.96)',
                    borderColor:
                      theme.mode === 'dark'
                        ? 'rgba(255, 255, 255, 0.16)'
                        : 'rgba(0, 0, 0, 0.12)',
                  },
                  Platform.OS === 'web' &&
                    ({
                      backdropFilter: 'blur(28px) saturate(190%)',
                      WebkitBackdropFilter: 'blur(28px) saturate(190%)',
                    } as never),
                ]}
              >
                {/* Menu Header with Category / Field Title */}
                <View
                  style={[
                    styles.menuHeader,
                    {
                      borderBottomColor:
                        theme.mode === 'dark'
                          ? 'rgba(255, 255, 255, 0.08)'
                          : 'rgba(0, 0, 0, 0.06)',
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.menuHeaderTitle,
                      { color: theme.text.secondary },
                    ]}
                  >
                    {label}
                  </Text>
                </View>

                {/* Options List */}
                <ScrollView
                  bounces={false}
                  showsVerticalScrollIndicator={options.length > 7}
                  style={styles.menuScroll}
                  contentContainerStyle={styles.menuScrollContent}
                >
                  {options.map((option, index) => {
                    const isSelected = option.value === value;
                    const isLast = index === options.length - 1;

                    return (
                      <Pressable
                        key={String(option.value)}
                        accessibilityRole="button"
                        accessibilityLabel={option.label}
                        onPress={() => handleSelect(option.value)}
                        style={({ pressed }) => [
                          styles.optionItem,
                          pressed && {
                            backgroundColor:
                              theme.mode === 'dark'
                                ? 'rgba(255, 255, 255, 0.08)'
                                : 'rgba(0, 0, 0, 0.05)',
                          },
                          !isLast && [
                            styles.optionBorder,
                            {
                              borderBottomColor:
                                theme.mode === 'dark'
                                  ? 'rgba(255, 255, 255, 0.06)'
                                  : 'rgba(0, 0, 0, 0.04)',
                            },
                          ],
                        ]}
                      >
                        {/* Selected Checkmark Check Indicator */}
                        <View style={styles.checkSlot}>
                          {isSelected && (
                            <MaterialCommunityIcons
                              name="check"
                              size={18}
                              color={theme.brand.primary}
                            />
                          )}
                        </View>

                        {/* Option Icon or Color Swatch */}
                        {option.colorSwatch ? (
                          <View
                            style={[
                              styles.swatchCircleLarge,
                              { backgroundColor: option.colorSwatch },
                            ]}
                          />
                        ) : option.icon ? (
                          <View
                            style={[
                              styles.iconSquircleLarge,
                              {
                                backgroundColor:
                                  option.iconBg ??
                                  (theme.mode === 'dark'
                                    ? 'rgba(255, 255, 255, 0.10)'
                                    : 'rgba(0, 0, 0, 0.06)'),
                              },
                            ]}
                          >
                            <MaterialCommunityIcons
                              name={option.icon as never}
                              size={18}
                              color={option.iconColor ?? theme.text.primary}
                            />
                          </View>
                        ) : null}

                        {/* Title & Subtitle */}
                        <View style={styles.optionTextColumn}>
                          <Text
                            style={[
                              styles.optionLabel,
                              {
                                color: theme.text.primary,
                                fontWeight: isSelected ? '600' : '400',
                              },
                            ]}
                          >
                            {option.label}
                          </Text>
                          {!!option.subtitle && (
                            <Text
                              style={[
                                styles.optionSubtitle,
                                { color: theme.text.muted },
                              ]}
                            >
                              {option.subtitle}
                            </Text>
                          )}
                        </View>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </Animated.View>
            </TouchableWithoutFeedback>
          </Animated.View>
        </TouchableWithoutFeedback>
      </Modal>
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
  },
  triggerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '68%',
    paddingVertical: 7,
    paddingHorizontal: 11,
    borderRadius: 14,
    borderWidth: 1,
    gap: 7,
  },
  triggerText: {
    fontSize: 14,
    fontWeight: '500',
    flexShrink: 1,
  },
  chevron: {
    marginLeft: 2,
  },
  helperText: {
    fontSize: 12,
    marginTop: 2,
    paddingHorizontal: 2,
  },
  iconSquircle: {
    width: 24,
    height: 24,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.4)',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: DesignSpacing.lg,
  },
  popoverCard: {
    width: '100%',
    maxWidth: 320,
    maxHeight: 460,
    borderRadius: DesignRadius.xl,
    borderWidth: 1,
    overflow: 'hidden',
  },
  menuHeader: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  menuHeaderTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  menuScroll: {
    flexGrow: 0,
  },
  menuScrollContent: {
    paddingVertical: 4,
  },
  optionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 46,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 10,
  },
  optionBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  checkSlot: {
    width: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconSquircleLarge: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchCircleLarge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.4)',
  },
  optionTextColumn: {
    flex: 1,
    justifyContent: 'center',
    gap: 2,
  },
  optionLabel: {
    fontSize: 15,
  },
  optionSubtitle: {
    fontSize: 12,
  },
});
