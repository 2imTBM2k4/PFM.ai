import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { GlassView } from 'expo-glass-effect';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createSoftShadow,
  DesignSpacing,
  useDesignTheme,
} from '@/constants/theme';
import { vi } from '@/messages/vi';

export interface BottomSheetModalProps {
  visible: boolean;
  onClose(): void;
  title: string;
  subtitle?: string;
  headerRight?: ReactNode;
  maxHeightPercent?: number;
  accessibilityLabel?: string;
  hideHeader?: boolean;
}

export const BottomSheetModal = memo(function BottomSheetModal({
  visible,
  onClose,
  title,
  subtitle,
  headerRight,
  maxHeightPercent = 0.92,
  accessibilityLabel,
  hideHeader = false,
  children,
}: PropsWithChildren<BottomSheetModalProps>) {
  const theme = useDesignTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const reduceMotion = useReducedMotion();

  const [rendered, setRendered] = useState(visible);
  const translateY = useSharedValue(windowHeight);
  const backdropOpacity = useSharedValue(0);

  const animateIn = useCallback(() => {
    setRendered(true);
    if (reduceMotion) {
      translateY.set(0);
      backdropOpacity.set(1);
    } else {
      backdropOpacity.set(withTiming(1, { duration: 240 }));
      translateY.set(
        withSpring(0, {
          damping: 24,
          stiffness: 280,
          mass: 0.9,
        }),
      );
    }
  }, [backdropOpacity, reduceMotion, translateY]);

  const animateOut = useCallback(
    (onComplete?: () => void) => {
      if (reduceMotion) {
        translateY.set(windowHeight);
        backdropOpacity.set(0);
        setRendered(false);
        onComplete?.();
      } else {
        backdropOpacity.set(withTiming(0, { duration: 180 }));
        translateY.set(
          withSpring(
            windowHeight,
            {
              damping: 26,
              stiffness: 300,
            },
            (finished) => {
              if (finished) {
                // Done closing
              }
            },
          ),
        );
        setTimeout(() => {
          setRendered(false);
          onComplete?.();
        }, 220);
      }
    },
    [backdropOpacity, reduceMotion, translateY, windowHeight],
  );

  useEffect(() => {
    if (visible) {
      animateIn();
    } else if (rendered) {
      animateOut();
    }
  }, [visible, animateIn, animateOut, rendered]);

  const handleRequestClose = useCallback(() => {
    animateOut(onClose);
  }, [animateOut, onClose]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gestureState) =>
          gestureState.dy > 4 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
        onPanResponderMove: (_, gestureState) => {
          if (gestureState.dy > 0) {
            translateY.set(gestureState.dy);
          }
        },
        onPanResponderRelease: (_, gestureState) => {
          if (gestureState.dy > 120 || gestureState.vy > 0.6) {
            handleRequestClose();
          } else {
            translateY.set(
              withSpring(0, { damping: 24, stiffness: 280, mass: 0.9 }),
            );
          }
        },
      }),
    [handleRequestClose, translateY],
  );

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  if (!rendered && !visible) {
    return null;
  }

  const sheetHeight = Math.min(
    windowHeight * maxHeightPercent,
    windowHeight - insets.top - 12,
  );

  return (
    <Modal
      transparent
      visible={rendered}
      animationType="none"
      statusBarTranslucent
      onRequestClose={handleRequestClose}
      accessibilityViewIsModal
      accessibilityLabel={accessibilityLabel ?? title}
    >
      <View style={styles.modalRoot} pointerEvents="box-none">
        {/* Dimmed backdrop */}
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={vi.cancel}
            style={StyleSheet.absoluteFill}
            onPress={handleRequestClose}
          />
        </Animated.View>

        {/* Sliding Sheet Container */}
        <Animated.View
          style={[
            styles.sheetContainer,
            sheetStyle,
            {
              height: sheetHeight,
              backgroundColor: theme.card.surfaceElevated,
              borderColor: theme.card.border,
            },
            createSoftShadow(theme.mode, 'lg'),
          ]}
        >
          {/* Top Grab Handle */}
          <View {...panResponder.panHandlers} style={styles.handleBar}>
            <View
              style={[
                styles.handle,
                {
                  backgroundColor:
                    theme.mode === 'dark'
                      ? 'rgba(255, 255, 255, 0.22)'
                      : 'rgba(0, 0, 0, 0.16)',
                },
              ]}
            />
          </View>

          {/* Liquid Glass Header */}
          {!hideHeader && (
            <GlassView
              glassEffectStyle="regular"
              colorScheme={theme.mode}
              style={[
                styles.header,
                {
                  borderBottomColor: theme.card.border,
                  backgroundColor: theme.tabBar.pillBackground,
                },
                Platform.OS === 'web' &&
                  ({
                    backdropFilter: 'blur(20px) saturate(180%)',
                    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                  } as never),
              ]}
            >
              <View style={styles.headerTitleCol}>
                <Text
                  numberOfLines={1}
                  style={[styles.headerTitle, { color: theme.text.primary }]}
                >
                  {title}
                </Text>
                {!!subtitle && (
                  <Text
                    numberOfLines={1}
                    style={[styles.headerSubtitle, { color: theme.text.secondary }]}
                  >
                    {subtitle}
                  </Text>
                )}
              </View>

              <View style={styles.headerRightActions}>
                {headerRight}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={vi.cancel}
                  hitSlop={8}
                  onPress={handleRequestClose}
                  style={({ pressed }) => [
                    styles.closeButton,
                    {
                      backgroundColor: pressed
                        ? theme.brand.primarySoft
                        : theme.card.surface,
                      borderColor: theme.card.border,
                    },
                  ]}
                >
                  <MaterialCommunityIcons
                    name="close"
                    size={20}
                    color={theme.text.primary}
                  />
                </Pressable>
              </View>
            </GlassView>
          )}

          {/* Body Content */}
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
            style={styles.body}
          >
            <View style={styles.contentWrap}>
              {children}
            </View>
          </KeyboardAvoidingView>
        </Animated.View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.48)',
    zIndex: 1,
  },
  sheetContainer: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    overflow: 'hidden',
    zIndex: 2,
  },
  handleBar: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  handle: {
    width: 38,
    height: 4.5,
    borderRadius: 2.5,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: DesignSpacing.screenPadding,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitleCol: {
    flex: 1,
    marginRight: DesignSpacing.sm,
  },
  headerTitle: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
  },
  contentWrap: {
    flex: 1,
  },
});
