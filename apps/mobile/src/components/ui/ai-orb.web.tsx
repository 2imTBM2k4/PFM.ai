import { LinearGradient } from 'expo-linear-gradient';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { vi } from '@/messages/vi';

export interface AIOrbProps {
  size?: number;
  animated?: boolean;
  accessibilityLabel?: string;
}

export const AIOrb = memo(function AIOrb({
  size = 120,
  accessibilityLabel = vi.aiOrbLabel,
}: AIOrbProps) {
  const sphereDiameter = Math.round(size * 0.86);
  const sphereRadius = sphereDiameter / 2;
  const specSize = Math.max(6, Math.round(sphereDiameter * 0.36));

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      pointerEvents="none"
      style={[styles.container, { width: size, height: size }]}
    >
      <View
        style={[
          styles.glow,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
          },
        ]}
      >
        <LinearGradient
          colors={['#5CE1FF', '#7C5CFF', '#FF7AD9']}
          locations={[0, 0.52, 1]}
          start={{ x: 0.1, y: 0.1 }}
          end={{ x: 0.9, y: 0.9 }}
          style={{
            width: sphereDiameter,
            height: sphereDiameter,
            borderRadius: sphereRadius,
            borderWidth: 1,
            borderColor: 'rgba(255, 255, 255, 0.68)',
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              position: 'absolute',
              top: Math.round(sphereDiameter * 0.14),
              left: Math.round(sphereDiameter * 0.16),
              width: specSize,
              height: Math.round(specSize * 0.72),
              borderRadius: specSize / 2,
              backgroundColor: 'rgba(255, 255, 255, 0.62)',
            }}
          />
        </LinearGradient>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(124, 92, 255, 0.16)',
  },
});
