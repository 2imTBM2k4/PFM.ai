import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

/**
 * Triggers a real file download or native "Save to Files" sharing dialog for CSV data.
 * Works seamlessly across Web, iOS, and Android.
 */
export async function saveCsvFile(
  fileName: string,
  csvContent: string,
): Promise<string> {
  if (Platform.OS === 'web') {
    if (typeof document !== 'undefined' && typeof Blob !== 'undefined') {
      const blob = new Blob([csvContent], {
        type: 'text/csv;charset=utf-8;',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return fileName;
    }
    return fileName;
  }

  // Native iOS / Android
  const dir = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
  const fileUri = `${dir}${fileName}`;

  await FileSystem.writeAsStringAsync(fileUri, csvContent, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(fileUri, {
      mimeType: 'text/csv',
      dialogTitle: 'Lưu bản sao .csv',
      UTI: 'public.comma-separated-values-text',
    });
  }

  return fileUri;
}

/**
 * Opens the native system file picker to select and read a .csv file.
 * Returns the selected file name and text content, or null if cancelled.
 */
export async function pickAndReadCsvFile(): Promise<{
  fileName: string;
  content: string;
} | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['text/csv', 'text/comma-separated-values', 'text/plain', '*/*'],
    copyToCacheDirectory: true,
  });

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0]!;
  let content = '';

  if (Platform.OS === 'web') {
    if (asset.file) {
      content = await asset.file.text();
    } else {
      const res = await fetch(asset.uri);
      content = await res.text();
    }
  } else {
    content = await FileSystem.readAsStringAsync(asset.uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  }

  return {
    fileName: asset.name,
    content,
  };
}
