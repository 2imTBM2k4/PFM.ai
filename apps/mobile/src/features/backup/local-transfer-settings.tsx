import { useState } from 'react';
import { View } from 'react-native';
import { Button, Text } from 'react-native-paper';
import { IconBadge, styles } from '@/components/screen';
import { GlassCard } from '@/components/ui';
import {
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import { useTransientState } from '@/hooks/use-transient-state';
import { vi } from '@/messages/vi';
import {
  exportLocalTransactionsCsv,
  importLocalTransactionsCsv,
} from '@/services/csv-transfer';
import { pickAndReadCsvFile, saveCsvFile } from '@/services/file-transfer';
import { usePreferences } from '@/state/preferences';

/** Exports and imports local transaction files inside Backup settings. */
export function LocalTransferSettings() {
  const theme = useDesignTheme();
  const palette = useFinancePalette();
  const language = usePreferences((state) => state.language);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvNotice, setCsvNotice] = useTransientState('');
  const [csvError, setCsvError] = useState('');
  const handleExportCsv = async () => {
    if (csvBusy) return;
    setCsvBusy(true);
    setCsvError('');
    setCsvNotice('');
    try {
      const exported = await exportLocalTransactionsCsv();
      const dateStr = new Date().toISOString().slice(0, 10);
      const fileName = `pfm-transactions-${dateStr}.csv`;
      await saveCsvFile(fileName, exported);
      setCsvNotice(`${vi.csvExportSuccess}: ${fileName}`);
    } catch {
      setCsvError(vi.saveError);
    } finally {
      setCsvBusy(false);
    }
  };

  const handlePickAndImportCsv = async () => {
    if (csvBusy) return;
    setCsvBusy(true);
    setCsvError('');
    setCsvNotice('');
    try {
      const picked = await pickAndReadCsvFile();
      if (!picked) {
        setCsvBusy(false);
        return;
      }
      const count = await withDatabase((db) =>
        importLocalTransactionsCsv(db, picked.content),
      );
      setCsvNotice(
        `${vi.csvImportSuccess} (${count} ${language === 'en' ? 'from' : 'từ'} ${picked.fileName})`,
      );
    } catch {
      setCsvError(vi.csvImportError);
    } finally {
      setCsvBusy(false);
    }
  };

  return (
    <GlassCard
      variant="elevated"
      radius="xl"
      padding={DesignSpacing.lg}
      style={{ gap: 12 }}
    >
      <View style={styles.inlineRow}>
        <IconBadge
          icon="file-delimited-outline"
          bg={palette.tealSoft}
          fg={palette.tealInk}
          size={40}
          iconSize={20}
        />
        <View style={{ flex: 1, gap: 2 }}>
          <Text
            variant="titleMedium"
            style={{ fontWeight: '800', color: theme.text.primary }}
          >
            {vi.csvSectionTitle}
          </Text>
          <Text
            variant="bodySmall"
            style={{ color: theme.text.secondary, lineHeight: 18 }}
          >
            {vi.csvSectionHint}
          </Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button
          mode="contained"
          compact
          icon="tray-arrow-up"
          buttonColor={theme.brand.primaryStrong}
          textColor="#FFFFFF"
          disabled={csvBusy}
          loading={csvBusy}
          onPress={() => void handleExportCsv()}
        >
          {vi.csvExportBtn}
        </Button>
        <Button
          mode="contained-tonal"
          compact
          icon="folder-open-outline"
          disabled={csvBusy}
          loading={csvBusy}
          onPress={() => void handlePickAndImportCsv()}
        >
          {vi.csvPickFileBtn}
        </Button>
      </View>

      <Text
        variant="bodySmall"
        style={{
          color: theme.brand.primaryText,
          fontStyle: 'italic',
          fontSize: 12,
          lineHeight: 16,
        }}
      >
        {vi.csvDriveBackupNote}
      </Text>

      {!!csvNotice && (
        <Text
          accessibilityLiveRegion="polite"
          variant="bodySmall"
          style={{ color: theme.finance.incomeText, fontWeight: '700' }}
        >
          {csvNotice}
        </Text>
      )}
      {!!csvError && (
        <Text
          accessibilityRole="alert"
          variant="bodySmall"
          style={{ color: palette.danger, fontWeight: '600' }}
        >
          {csvError}
        </Text>
      )}
    </GlassCard>
  );
}
