import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useState } from 'react';
import { Pressable } from 'react-native';
import { Menu } from 'react-native-paper';
import { useDesignTheme } from '@/constants/theme';
import { vi } from '@/messages/vi';
import type { FloatingTabBarProps } from './floating-tab-bar';

/** Provides the same actions on Android and web using the installed Paper menu. */
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
  const [open, setOpen] = useState(false);
  const select = (action: 'manual' | 'camera' | 'chat') => {
    setOpen(false);
    onActionSelect(action);
  };
  return (
    <Menu
      visible={open}
      onDismiss={() => setOpen(false)}
      anchorPosition="top"
      overlayAccessibilityLabel={vi.close}
      contentStyle={{ backgroundColor: theme.card.surface }}
      anchor={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((value) => !value)}
          style={{
            width: size,
            height: size,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <MaterialCommunityIcons
            name="plus"
            size={26}
            color={theme.text.primary}
          />
        </Pressable>
      }
    >
      <Menu.Item
        title={vi.quickAddManual}
        accessibilityLabel={vi.quickAddManual}
        leadingIcon="pencil-outline"
        onPress={() => select('manual')}
      />
      <Menu.Item
        title={vi.quickAddCamera}
        accessibilityLabel={vi.quickAddCamera}
        leadingIcon="camera-outline"
        onPress={() => select('camera')}
      />
      <Menu.Item
        title={vi.quickAddAI}
        accessibilityLabel={vi.quickAddAI}
        leadingIcon="creation"
        onPress={() => select('chat')}
      />
    </Menu>
  );
}
