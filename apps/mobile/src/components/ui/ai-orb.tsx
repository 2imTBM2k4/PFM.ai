import {
  BlurMask,
  Canvas,
  Circle,
  Group,
  LinearGradient,
  RadialGradient,
  Rect,
  Shader,
  Skia,
  vec,
} from '@shopify/react-native-skia';
import { LinearGradient as ExpoLinearGradient } from 'expo-linear-gradient';
import { memo, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { vi } from '@/messages/vi';

const ORB_SHADER_SOURCE = `
uniform float2 uResolution;
uniform float uTime;

half4 main(float2 fragCoord) {
  float2 center = uResolution * 0.5;
  float radius = min(uResolution.x, uResolution.y) * 0.42;
  float2 p = (fragCoord - center) / max(radius, 1.0);
  float dist = length(p);

  if (dist > 1.06) {
    return half4(0.0);
  }

  // Smooth anti-aliased sphere edge
  float edgeAlpha = 1.0 - smoothstep(0.97, 1.03, dist);
  float r = clamp(dist, 0.0, 1.0);
  float z = sqrt(max(0.0, 1.0 - r * r));

  // Spherical lens distortion + slow rotation
  float angle = uTime * 0.45;
  float ca = cos(angle);
  float sa = sin(angle);
  float2 rotP = float2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
  float2 sphereUv = rotP / (0.65 + 0.35 * z);

  // Flowing internal holographic wave ribbons (purple - pink - cyan-blue)
  float wave1 = sin(sphereUv.x * 3.4 + uTime * 1.3 + cos(sphereUv.y * 2.6 - uTime * 0.9));
  float wave2 = cos(sphereUv.y * 3.8 - uTime * 1.1 + sin(sphereUv.x * 2.9 + uTime * 0.7));
  float ribbon = smoothstep(-0.6, 0.7, wave1 * 0.55 + wave2 * 0.45);
  float cyanBand = smoothstep(0.1, 0.95, sin((sphereUv.x - sphereUv.y) * 3.1 + uTime * 1.5));

  half3 deepPurple = half3(0.486, 0.361, 1.000);   // #7C5CFF
  half3 softLavender = half3(0.745, 0.647, 1.000); // #BEA5FF
  half3 wavePink = half3(1.000, 0.478, 0.851);     // #FF7AD9
  half3 waveBlue = half3(0.361, 0.882, 1.000);     // #5CE1FF
  half3 pearlWhite = half3(0.980, 0.965, 1.000);

  half3 coreColor = mix(deepPurple, wavePink, half(ribbon));
  coreColor = mix(coreColor, waveBlue, half(cyanBand * 0.58));
  coreColor = mix(coreColor, softLavender, half((1.0 - r) * 0.32));

  // Glass Fresnel rim & top-left specular highlight
  float fresnel = pow(1.0 - z, 2.3);
  float2 lightDir = normalize(float2(-0.48, -0.56));
  float specDist = length(p - lightDir * 0.48);
  float specular = exp(-specDist * specDist * 8.5) * 0.78;
  float secondarySpec = exp(-length(p + lightDir * 0.55) * 5.0) * 0.25;

  half3 finalColor = coreColor + pearlWhite * half(fresnel * 0.62 + specular + secondarySpec);
  return half4(clamp(finalColor, 0.0, 1.0) * half(edgeAlpha), half(edgeAlpha));
}
`;

/**
 * Compiles the holographic AI Orb SkSL shader safely with fallback support.
 */
function createOrbRuntimeEffect() {
  try {
    return Skia.RuntimeEffect.Make(ORB_SHADER_SOURCE);
  } catch {
    return null;
  }
}

export interface AIOrbProps {
  size?: number;
  animated?: boolean;
  accessibilityLabel?: string;
}

/**
 * Lightweight static holographic orb avatar using native Views and ExpoLinearGradient.
 * Avoids allocating Skia Canvas/GPU textures or Reanimated loops inside long FlatLists.
 */
const StaticOrbAvatar = memo(function StaticOrbAvatar({
  size,
  accessibilityLabel,
}: {
  size: number;
  accessibilityLabel: string;
}) {
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
          styles.staticGlow,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
          },
        ]}
      >
        <ExpoLinearGradient
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
        </ExpoLinearGradient>
      </View>
    </View>
  );
});

/**
 * Animated holographic glass AI Orb rendered via @shopify/react-native-skia shader.
 */
const AnimatedSkiaOrb = memo(function AnimatedSkiaOrb({
  size,
  accessibilityLabel,
}: {
  size: number;
  accessibilityLabel: string;
}) {
  const orbEffect = useMemo(() => createOrbRuntimeEffect(), []);
  const time = useSharedValue(0);
  const breath = useSharedValue(0);

  useEffect(() => {
    time.set(
      withRepeat(
        withTiming(Math.PI * 8, {
          duration: 24000,
          easing: Easing.linear,
        }),
        -1,
        false,
      ),
    );
    breath.set(
      withRepeat(
        withTiming(1, {
          duration: 3400,
          easing: Easing.inOut(Easing.sin),
        }),
        -1,
        true,
      ),
    );
    return () => {
      cancelAnimation(time);
      cancelAnimation(breath);
    };
  }, [breath, time]);

  const containerAnimatedStyle = useAnimatedStyle(() => {
    const scale = 0.96 + breath.value * 0.07;
    const rotateDeg = (breath.value - 0.5) * 8;
    return {
      transform: [{ scale }, { rotate: `${rotateDeg}deg` }],
    };
  });

  const uniforms = useDerivedValue(() => ({
    uResolution: [size, size],
    uTime: time.value,
  }));

  const center = size / 2;
  const sphereRadius = size * 0.42;
  const glowRadius = size * 0.48;

  return (
    <Animated.View
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.container,
        { width: size, height: size },
        containerAnimatedStyle,
      ]}
      pointerEvents="none"
    >
      <Canvas style={{ width: size, height: size }}>
        {/* Ambient Outer Glow */}
        <Circle cx={center} cy={center} r={glowRadius}>
          <RadialGradient
            c={vec(center, center)}
            r={glowRadius}
            colors={[
              'rgba(124, 92, 255, 0.45)',
              'rgba(255, 122, 217, 0.25)',
              'rgba(92, 225, 255, 0.0)',
            ]}
            positions={[0.2, 0.65, 1]}
          />
          <BlurMask blur={Math.max(4, size * 0.08)} style="normal" />
        </Circle>

        {/* Core Holographic Glass Sphere */}
        {orbEffect ? (
          <Rect x={0} y={0} width={size} height={size}>
            <Shader source={orbEffect} uniforms={uniforms} />
          </Rect>
        ) : (
          <Group>
            <Circle cx={center} cy={center} r={sphereRadius}>
              <LinearGradient
                start={vec(center - sphereRadius, center - sphereRadius)}
                end={vec(center + sphereRadius, center + sphereRadius)}
                colors={['#5CE1FF', '#7C5CFF', '#FF7AD9', '#FFFFFF']}
                positions={[0, 0.42, 0.8, 1]}
              />
            </Circle>
            <Circle
              cx={center - sphereRadius * 0.28}
              cy={center - sphereRadius * 0.32}
              r={sphereRadius * 0.35}
            >
              <RadialGradient
                c={vec(
                  center - sphereRadius * 0.28,
                  center - sphereRadius * 0.32,
                )}
                r={sphereRadius * 0.35}
                colors={['rgba(255,255,255,0.85)', 'rgba(255,255,255,0)']}
              />
            </Circle>
          </Group>
        )}
      </Canvas>
    </Animated.View>
  );
});

/**
 * Start static until the OS preference is known; keep listening while mounted so
 * enabling Reduce Motion immediately unmounts the Skia animation and its loops.
 * A late initial read must not overwrite a more recent accessibility event.
 */
function useOrbReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(true);

  useEffect(() => {
    let active = true;
    let preferenceChanged = false;
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => {
        preferenceChanged = true;
        if (active) setReducedMotion(enabled);
      },
    );
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active && !preferenceChanged) setReducedMotion(enabled);
      })
      .catch(() => {
        // Keep the non-animated fallback if the OS preference cannot be read.
      });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reducedMotion;
}

/**
 * Shared AI Orb component. Reduced motion (including an unresolved preference)
 * and `animated={false}` use the static avatar without Skia or animation loops.
 */
export const AIOrb = memo(function AIOrb({
  size = 120,
  animated = true,
  accessibilityLabel = vi.aiOrbLabel,
}: AIOrbProps) {
  const reducedMotion = useOrbReducedMotion();
  if (!animated || reducedMotion) {
    return (
      <StaticOrbAvatar size={size} accessibilityLabel={accessibilityLabel} />
    );
  }
  return (
    <AnimatedSkiaOrb size={size} accessibilityLabel={accessibilityLabel} />
  );
});

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  staticGlow: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(124, 92, 255, 0.16)',
  },
});
