import type { ComponentProps } from 'react';
import { Platform } from 'react-native';
import { SegmentedButtons as PaperSegments } from 'react-native-paper';
import { SegmentedOptionPicker } from './segmented-option-picker';

/** Reuses native option selection on iOS while retaining Paper controls elsewhere. */
export default function NativeSegmentedButtons(
  props: ComponentProps<typeof PaperSegments>,
) {
  if (Platform.OS !== 'ios' || props.multiSelect)
    return <PaperSegments {...props} />;
  return (
    <SegmentedOptionPicker
      value={props.value}
      options={props.buttons.map((button) => ({
        value: button.value,
        label: button.label ?? button.value,
        disabled: button.disabled,
      }))}
      onSelect={props.onValueChange}
    />
  );
}
