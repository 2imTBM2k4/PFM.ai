import { SymbolView } from 'expo-symbols';
import { type PropsWithChildren, useEffect, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, {
  FadeIn,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { createWebTransitionStyle, MotionSpring } from '@/constants/motion';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Expandable disclosure section with spring-animated chevron rotation and
 * reduced-motion aware reveal transitions.
 */
export function Collapsible({
  children,
  title,
}: PropsWithChildren & { title: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const rotation = useSharedValue(0);

  useEffect(() => {
    const target = isOpen ? 90 : 0;
    if (reduceMotion) {
      rotation.set(target);
    } else {
      rotation.set(withSpring(target, MotionSpring.snappy));
    }
  }, [isOpen, reduceMotion, rotation]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View
      layout={reduceMotion ? undefined : LinearTransition.duration(200)}
    >
      <ThemedView>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityState={{ expanded: isOpen }}
          style={({ pressed }) => [
            styles.heading,
            createWebTransitionStyle(),
            pressed && styles.pressedHeading,
          ]}
          onPress={() => setIsOpen((value) => !value)}
        >
          <ThemedView type="backgroundElement" style={styles.button}>
            <Animated.View style={chevronStyle}>
              <SymbolView
                name={{
                  ios: 'chevron.right',
                  android: 'chevron_right',
                  web: 'chevron_right',
                }}
                size={14}
                weight="bold"
                tintColor={theme.text}
              />
            </Animated.View>
          </ThemedView>

          <ThemedText type="small">{title}</ThemedText>
        </Pressable>
        {isOpen && (
          <Animated.View
            entering={reduceMotion ? undefined : FadeIn.duration(180)}
          >
            <ThemedView type="backgroundElement" style={styles.content}>
              {children}
            </ThemedView>
          </Animated.View>
        )}
      </ThemedView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minHeight: 44,
  },
  pressedHeading: {
    opacity: 0.72,
  },
  button: {
    width: Spacing.four,
    height: Spacing.four,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    marginTop: Spacing.three,
    borderRadius: Spacing.three,
    marginLeft: Spacing.four,
    padding: Spacing.four,
  },
});