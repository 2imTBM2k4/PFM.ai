import type { SFSymbol } from 'expo-symbols';

const MATERIAL_TO_SF_SYMBOL: Record<string, SFSymbol> = {
  'arrow-down-circle': 'arrow.down.circle',
  'arrow-up-circle': 'arrow.up.circle',
  'swap-horizontal-circle': 'arrow.left.arrow.right.circle',
  'cash-multiple': 'banknote',
  cash: 'banknote',
  'cash-fast': 'banknote',
  'cash-minus': 'minus.circle',
  'cash-plus': 'plus.circle',
  'bank-outline': 'building.columns',
  'cellphone-check': 'iphone',
  'credit-card-outline': 'creditcard',
  'piggy-bank-outline': 'dollarsign.circle',
  'wallet-outline': 'wallet.bifold',
  'folder-outline': 'folder',
  tag: 'tag',
  'tag-outline': 'tag',
  food: 'fork.knife',
  home: 'house',
  car: 'car',
  cart: 'cart',
  'help-circle-outline': 'questionmark.circle',
  history: 'clock.arrow.circlepath',
  handshake: 'person.2',
  'calendar-month-outline': 'calendar',
  calendar: 'calendar',
  'clock-outline': 'clock',
  repeat: 'repeat',
  'view-grid-outline': 'square.grid.2x2',
  'arrow-top-right': 'arrow.up.right',
  'arrow-bottom-left': 'arrow.down.left',
  'swap-horizontal': 'arrow.left.arrow.right',
  'tune-variant': 'slider.horizontal.3',
  'calendar-sync-outline': 'calendar.badge.clock',
  'handshake-outline': 'person.2',
  'pin-outline': 'pin',
  'pin-off-outline': 'pin.slash',
  'chart-donut': 'chart.pie',
};

/**
 * Maps a MaterialCommunityIcons name used in shared options to a valid iOS SF Symbol.
 */
export function toSfSymbol(materialIcon?: string): SFSymbol | undefined {
  if (!materialIcon) return undefined;
  return MATERIAL_TO_SF_SYMBOL[materialIcon] ?? 'circle';
}
