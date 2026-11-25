import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SymbolView } from 'expo-symbols';
import type { ComponentProps } from 'react';
import { Platform } from 'react-native';
import { toSfSymbol } from '@/utils/sf-symbols';

/** Uses one symbol family per platform while preserving existing icon callers. */
export default function PlatformIcon({
  name,
  size = 24,
  color,
  style,
  ...rest
}: ComponentProps<typeof MaterialCommunityIcons>) {
  return Platform.OS === 'ios' ? (
    <SymbolView
      name={toSfSymbol(name)!}
      size={size}
      tintColor={color}
      style={[{ width: size, height: size }, style]}
      accessible={rest.accessible ?? Boolean(rest.accessibilityLabel)}
      accessibilityLabel={rest.accessibilityLabel}
      accessibilityRole={rest.accessibilityRole}
      accessibilityState={rest.accessibilityState}
      testID={rest.testID}
    />
  ) : (
    <MaterialCommunityIcons
      name={name}
      size={size}
      color={color}
      style={style}
      {...rest}
      accessible={rest.accessible ?? Boolean(rest.accessibilityLabel)}
      accessibilityElementsHidden={
        rest.accessibilityElementsHidden ??
        !(rest.accessible || rest.accessibilityLabel)
      }
      importantForAccessibility={
        rest.importantForAccessibility ??
        (rest.accessible || rest.accessibilityLabel
          ? 'auto'
          : 'no-hide-descendants')
      }
    />
  );
}
