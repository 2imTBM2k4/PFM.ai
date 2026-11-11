import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { RevealFieldContext } from './field-feedback';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Icon, Text } from 'react-native-paper';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { GradientBackground } from '@/components/ui/gradient-background';
import {
  DUO_SIDE_RAIL_WIDTH,
  getCameraClearance,
  useResponsiveLayout,
} from '@/constants/responsive-layout';
import {
  createSoftShadow,
  DesignRadius,
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { vi } from '@/messages/vi';
import { useTabBarScroll } from '@/hooks/use-tab-bar-scroll';
import { usePreferences } from '@/state/preferences';

let hiddenTabBarOwners = 0;

/**
 * Shared screen wrapper with safe area handling, keyboard avoidance, and glassmorphic header.
 */
export function Screen({
  title,
  subtitle,
  onBack,
  backDisabled,
  headerRight,
  rightRail,
  hideHeader = false,
  inModal = false,
  autoHideTabBar = true,
  footer,
  hasTabBar,
  hideTabBar,
  onScroll,
  children,
  scroll = true,
}: PropsWithChildren<{
  title: string;
  subtitle?: string;
  onBack?: () => void;
  backDisabled?: boolean;
  headerRight?: ReactNode;
  rightRail?: ReactNode;
  hideHeader?: boolean;
  inModal?: boolean;
  hasTabBar?: boolean;
  hideTabBar?: boolean;
  autoHideTabBar?: boolean;
  footer?: ReactNode;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scroll?: boolean;
}>) {
  const palette = useFinancePalette();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const contentRef = useRef<ComponentRef<typeof View>>(null);
  const revealField = useCallback((target: ComponentRef<typeof View>) => {
    if (!contentRef.current) return;
    target.measureLayout(
      contentRef.current,
      (_x, y) => {
        scrollRef.current?.scrollTo({ y: Math.max(0, y - 16), animated: true });
      },
      () => {},
    );
  }, []);
  const designTheme = useDesignTheme();
  const insets = useSafeAreaInsets();
  const { width, height, isDuoClosedPortrait } = useResponsiveLayout();
  const cameraClearance = getCameraClearance(width, height, insets.top);
  const tabBarActive = hasTabBar ?? !inModal;
  const shouldHideTabBar = tabBarActive && (hideTabBar ?? Boolean(footer));
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const showEvent =
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent =
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () =>
      setKeyboardVisible(true),
    );
    const hideSub = Keyboard.addListener(hideEvent, () =>
      setKeyboardVisible(false),
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    if (!shouldHideTabBar) return;
    hiddenTabBarOwners += 1;
    usePreferences.getState().setTabBarVisible(false);
    return () => {
      hiddenTabBarOwners = Math.max(0, hiddenTabBarOwners - 1);
      if (hiddenTabBarOwners === 0) {
        usePreferences.getState().setTabBarVisible(true);
      }
    };
  }, [shouldHideTabBar]);

  const tabBarScroll = useTabBarScroll({
    enabled: tabBarActive && autoHideTabBar && !shouldHideTabBar,
  });
  // The Duo camera sits in the reserved right rail, so left-side content can
  // use the upper space while the rail controls remain below the camera.
  const contentCameraClearance = inModal
    ? 0
    : isDuoClosedPortrait
      ? 0
      : cameraClearance;
  const horizontalPadding =
    width <= 340
      ? DesignSpacing.sm
      : width < 390
        ? DesignSpacing.md
        : DesignSpacing.screenPadding;
  const compactHeight = height < 700;
  const content = (
    <RevealFieldContext.Provider value={revealField}>
      <Animated.View
        ref={contentRef}
        collapsable={false}
        entering={FadeIn.duration(240)}
        style={[
          styles.column,
          scroll ? styles.scrollColumn : styles.fill,
          {
            paddingLeft: horizontalPadding,
            paddingRight:
              horizontalPadding +
              (isDuoClosedPortrait ? DUO_SIDE_RAIL_WIDTH : 0),
            paddingTop: inModal
              ? DesignSpacing.xs
              : (compactHeight ? DesignSpacing.xs : DesignSpacing.sm) +
                contentCameraClearance,
            paddingBottom: inModal
              ? DesignSpacing.md
              : compactHeight
                ? DesignSpacing.md
                : DesignSpacing.xl,
            gap: compactHeight ? DesignSpacing.sm : DesignSpacing.md,
          },
        ]}
      >
        {!hideHeader && (
          <View style={styles.headerContainer}>
            {onBack && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={vi.back}
                disabled={backDisabled}
                onPress={onBack}
                style={({ pressed }) => [
                  styles.backPill,
                  createSoftShadow(designTheme.mode, 'sm'),
                  {
                    backgroundColor: designTheme.card.surfaceElevated,
                    borderColor: designTheme.card.border,
                    opacity: backDisabled ? 0.5 : pressed ? 0.75 : 1,
                  },
                ]}
              >
                <Icon source="arrow-left" size={18} color={palette.text} />
                <Text
                  variant="labelLarge"
                  style={{ color: palette.text, fontWeight: '600' }}
                >
                  {vi.back}
                </Text>
              </Pressable>
            )}
            <View style={styles.headerTitleRow}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  accessibilityRole="header"
                  variant="headlineSmall"
                  style={[
                    styles.screenTitle,
                    { color: designTheme.text.primary },
                  ]}
                >
                  {title}
                </Text>
                {!!subtitle && (
                  <Text
                    variant="bodyMedium"
                    style={{ color: designTheme.text.secondary }}
                  >
                    {subtitle}
                  </Text>
                )}
              </View>
              {!!headerRight && (
                <View style={styles.headerActions}>{headerRight}</View>
              )}
            </View>
          </View>
        )}
        {children}
      </Animated.View>
    </RevealFieldContext.Provider>
  );
  if (inModal) {
    return (
      <View style={[styles.fill, { backgroundColor: 'transparent' }]}>
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : footer ? 'height' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 16 : 0}
        >
          {scroll ? (
            <ScrollView
              ref={scrollRef}
              style={styles.fill}
              contentInsetAdjustmentBehavior="automatic"
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
              contentContainerStyle={[
                styles.scroll,
                {
                  paddingBottom: footer
                    ? DesignSpacing.lg
                    : Math.max(insets.bottom, DesignSpacing.md),
                },
              ]}
              showsVerticalScrollIndicator={false}
            >
              {content}
            </ScrollView>
          ) : (
            content
          )}
          {!!footer && (
            <View
              style={[
                styles.stickyFooter,
                {
                  backgroundColor: designTheme.card.surfaceElevated,
                  borderTopColor: designTheme.card.border,
                  paddingBottom: keyboardVisible
                    ? DesignSpacing.sm
                    : Math.max(insets.bottom, DesignSpacing.sm),
                },
              ]}
            >
              <View
                style={[
                  styles.column,
                  {
                    paddingLeft: horizontalPadding,
                    paddingRight:
                      horizontalPadding +
                      (isDuoClosedPortrait ? DUO_SIDE_RAIL_WIDTH : 0),
                    gap: DesignSpacing.xs,
                  },
                ]}
              >
                {footer}
              </View>
            </View>
          )}
        </KeyboardAvoidingView>
      </View>
    );
  }

  return (
    <View
      style={[styles.rootScreen, { backgroundColor: designTheme.sky.upperMid }]}
    >
      <GradientBackground themeMode={designTheme.mode} />
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.fill}>
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : footer ? 'height' : undefined}
          keyboardVerticalOffset={0}
        >
          {scroll ? (
            <ScrollView
              ref={scrollRef}
              style={styles.fill}
              contentInsetAdjustmentBehavior="automatic"
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
              onScroll={(e) => {
                tabBarScroll.onScroll(e);
                onScroll?.(e);
              }}
              scrollEventThrottle={tabBarScroll.scrollEventThrottle}
              contentContainerStyle={[
                styles.scroll,
                {
                  paddingBottom: footer
                    ? DesignSpacing.lg
                    : !tabBarActive || isDuoClosedPortrait
                      ? DesignSpacing.xl + insets.bottom
                      : DesignSpacing.bottomTabClearance + insets.bottom,
                },
              ]}
              showsVerticalScrollIndicator={false}
            >
              {content}
            </ScrollView>
          ) : (
            content
          )}
          {!!footer && (
            <View
              style={[
                styles.stickyFooter,
                {
                  backgroundColor: designTheme.card.surfaceElevated,
                  borderTopColor: designTheme.card.border,
                  paddingBottom: keyboardVisible
                    ? DesignSpacing.sm
                    : Math.max(insets.bottom, DesignSpacing.sm),
                },
              ]}
            >
              <View
                style={[
                  styles.column,
                  {
                    paddingLeft: horizontalPadding,
                    paddingRight:
                      horizontalPadding +
                      (isDuoClosedPortrait ? DUO_SIDE_RAIL_WIDTH : 0),
                    gap: DesignSpacing.xs,
                  },
                ]}
              >
                {footer}
              </View>
            </View>
          )}
        </KeyboardAvoidingView>
        {isDuoClosedPortrait && !!rightRail && (
          <View
            style={[
              styles.rightRail,
              {
                top: Math.max(insets.top, cameraClearance) + DesignSpacing.xl,
              },
            ]}
          >
            {rightRail}
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}

/**
 * Rounded pastel icon container used inside cards and transaction rows.
 */
export function IconBadge({
  icon,
  bg,
  fg,
  size = 44,
  iconSize = 22,
}: {
  icon: string;
  bg: string;
  fg: string;
  size?: number;
  iconSize?: number;
}) {
  return (
    <View
      style={[
        styles.iconBadge,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.36),
          backgroundColor: bg,
        },
      ]}
    >
      <Icon source={icon} size={iconSize} color={fg} />
    </View>
  );
}

/**
 * Compact status pill badge for transaction types and budget alerts.
 */
export function StatusPill({
  label,
  bg,
  fg,
  icon,
}: {
  label: string;
  bg: string;
  fg: string;
  icon?: string;
}) {
  return (
    <View style={[styles.statusPill, { backgroundColor: bg }]}>
      {!!icon && <Icon source={icon} size={13} color={fg} />}
      <Text
        variant="labelSmall"
        style={{ color: fg, fontWeight: '600', letterSpacing: 0.1 }}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * Interactive quick action tile with glassmorphic surface and press scale feedback.
 */
export function QuickTile({
  icon,
  label,
  bg,
  fg,
  disabled,
  onPress,
  style,
}: {
  icon: string;
  label: string;
  bg: string;
  fg: string;
  disabled?: boolean;
  onPress(): void;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = useFinancePalette();
  const designTheme = useDesignTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.quickTile,
        createSoftShadow(designTheme.mode, 'sm'),
        {
          backgroundColor: designTheme.card.surface,
          borderColor: designTheme.card.border,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
        style,
      ]}
    >
      <IconBadge icon={icon} bg={bg} fg={fg} size={40} iconSize={20} />
      <Text
        variant="labelMedium"
        numberOfLines={2}
        style={{
          color: palette.text,
          fontWeight: '600',
          textAlign: 'center',
          lineHeight: 16,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Glassmorphic empty state card with icon badge and helper message.
 */
export function EmptyStateCard({
  icon,
  message,
  action,
}: {
  icon: string;
  message: string;
  action?: ReactNode;
}) {
  const palette = useFinancePalette();
  const designTheme = useDesignTheme();
  return (
    <View
      style={[
        styles.emptyCard,
        createSoftShadow(designTheme.mode, 'sm'),
        {
          backgroundColor: designTheme.card.surface,
          borderColor: designTheme.card.border,
        },
      ]}
    >
      <IconBadge
        icon={icon}
        bg={palette.primarySoft}
        fg={palette.primaryInk}
        size={48}
        iconSize={24}
      />
      <Text
        variant="bodyMedium"
        style={{
          color: palette.textMuted,
          textAlign: 'center',
          lineHeight: 21,
        }}
      >
        {message}
      </Text>
      {action}
    </View>
  );
}

export const styles = StyleSheet.create({
  rootScreen: { flex: 1 },
  fill: { flex: 1, backgroundColor: 'transparent' },
  scroll: {
    flexGrow: 1,
    paddingBottom: DesignSpacing.bottomTabClearance,
  },
  scrollColumn: { flexGrow: 1, flexShrink: 0 },
  stickyFooter: {
    borderTopWidth: 1,
    paddingTop: DesignSpacing.sm,
  },
  column: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
  },
  rightRail: {
    position: 'absolute',
    right: DesignSpacing.sm,
    width: 56,
    alignItems: 'center',
    zIndex: 40,
  },
  headerContainer: {
    gap: 10,
    paddingBottom: 2,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerActions: {
    flexShrink: 1,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
  },
  screenTitle: {
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  backPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: DesignRadius.pill,
    borderWidth: 1,
    minHeight: 44,
  },
  panel: {
    padding: 20,
    borderRadius: DesignRadius.lg,
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.78)',
    shadowColor: '#433872',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    elevation: 4,
  },
  subtlePanel: {
    padding: 16,
    borderRadius: DesignRadius.md,
    gap: 8,
    borderWidth: 1,
  },
  number: { fontVariant: ['tabular-nums'] },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  button: {
    minHeight: 48,
    justifyContent: 'center',
    borderRadius: DesignRadius.pill,
  },
  compactButton: {
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: DesignRadius.pill,
  },
  iconBadge: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: DesignRadius.pill,
    alignSelf: 'flex-start',
  },
  quickTile: {
    flex: 1,
    minWidth: 74,
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderRadius: DesignRadius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  emptyCard: {
    padding: 24,
    borderRadius: DesignRadius.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
});
