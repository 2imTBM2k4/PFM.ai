import { useRef, useState } from 'react';
import { View } from 'react-native';
import { Button, Text, TextInput, useTheme } from 'react-native-paper';
import { IconBadge, styles } from './screen';
import { useFinancePalette } from '@/constants/theme';
import { vi } from '@/messages/vi';
import { useApp } from '@/state/app';

export function DeleteDataControl() {
  const { colors } = useTheme();
  const palette = useFinancePalette();
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const busy = useRef(false);
  const deleteData = useApp((state) => state.deleteData);
  if (!confirming)
    return (
      <Button
        mode="outlined"
        icon="trash-can-outline"
        textColor={colors.error}
        contentStyle={styles.button}
        style={{ borderColor: palette.danger }}
        onPress={() => setConfirming(true)}
      >
        {vi.deleteData}
      </Button>
    );
  return (
    <View style={{ gap: 14 }}>
      <View style={styles.inlineRow}>
        <IconBadge
          icon="alert-octagon-outline"
          bg={palette.dangerSoft}
          fg={palette.dangerInk}
          size={38}
          iconSize={20}
        />
        <Text
          variant="bodySmall"
          style={{ color: palette.dangerInk, flex: 1, lineHeight: 19 }}
        >
          {vi.deleteExplanation}
        </Text>
      </View>
      <TextInput
        label={vi.deletePrompt}
        accessibilityLabel={vi.deletePrompt}
        mode="outlined"
        value={confirmation}
        onChangeText={setConfirmation}
        autoCapitalize="characters"
        autoCorrect={false}
      />
      <Button
        mode="contained"
        icon="trash-can-outline"
        buttonColor={colors.error}
        contentStyle={styles.button}
        disabled={confirmation !== vi.deleteWord}
        onPress={async () => {
          if (busy.current || confirmation !== vi.deleteWord) return;
          busy.current = true;
          try {
            await deleteData();
          } finally {
            busy.current = false;
          }
        }}
      >
        {vi.deleteData}
      </Button>
      <Button
        mode="outlined"
        contentStyle={styles.button}
        onPress={() => {
          setConfirmation('');
          setConfirming(false);
        }}
      >
        {vi.cancel}
      </Button>
    </View>
  );
}
