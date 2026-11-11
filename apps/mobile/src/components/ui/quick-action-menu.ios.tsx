import { Button, Host, Image, Menu } from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  buttonStyle,
  contentShape,
  frame,
  menuIndicator,
  menuOrder,
  menuStyle,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import { useDesignTheme } from '@/constants/theme';
import { vi } from '@/messages/vi';
import type { FloatingTabBarProps } from './floating-tab-bar';

/** Lets SwiftUI own single-tap presentation, dismissal, and menu accessibility. */
export function QuickActionMenu({
  size,
  label,
  onActionSelect,
}: {
  size: number;
  label: string;
  onActionSelect: FloatingTabBarProps['onActionSelect'];
}) {
  const theme = useDesignTheme();
  return (
    <Host
      style={{ width: size, height: size }}
      colorScheme={theme.mode}
      ignoreSafeArea="all"
    >
      <Menu
        label={
          <Image
            systemName="plus"
            size={26}
            color={theme.text.primary}
            modifiers={[
              frame({ width: size, height: size }),
              contentShape(shapes.circle()),
            ]}
          />
        }
        modifiers={[
          menuStyle('button'),
          buttonStyle('plain'),
          menuIndicator('hidden'),
          menuOrder('fixed'),
          accessibilityLabel(label),
        ]}
      >
        <Button
          label={vi.quickAddManual}
          systemImage="pencil"
          onPress={() => onActionSelect('manual')}
        />
        <Button
          label={vi.quickAddCamera}
          systemImage="camera"
          onPress={() => onActionSelect('camera')}
        />
        <Button
          label={vi.quickAddAI}
          systemImage="sparkles"
          onPress={() => onActionSelect('chat')}
        />
      </Menu>
    </Host>
  );
}
