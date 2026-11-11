export interface PickerOptionLike<T> {
  value: T;
  label: string;
  subtitle?: string;
}

/**
 * Formats an option label for single-line native iOS menus by appending its subtitle when present.
 */
export function formatPickerOptionLabel<T>(option: PickerOptionLike<T>): string {
  if (!option.subtitle) return option.label;
  return option.label + ' \u00b7 ' + option.subtitle;
}

/**
 * Finds the option matching the current value, returning undefined when no match exists.
 */
export function resolveSelectedOption<T, O extends PickerOptionLike<T>>(
  options: readonly O[],
  value: T,
): O | undefined {
  return options.find((option) => option.value === value);
}
