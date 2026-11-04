import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pickAndReadCsvFile, saveCsvFile } from './file-transfer';

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(async () => true),
  shareAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/user/0/pfm/files/',
  cacheDirectory: 'file:///data/user/0/pfm/cache/',
  writeAsStringAsync: vi.fn(async () => undefined),
  readAsStringAsync: vi.fn(
    async () =>
      'occurred_on,kind,amount,note,category\n2026-10-25,expense,45000,Pho,An ngoai',
  ),
  EncodingType: { UTF8: 'utf8' },
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(async () => ({
    canceled: false,
    assets: [
      {
        uri: 'file:///data/user/0/pfm/cache/import.csv',
        name: 'import.csv',
        size: 1024,
      },
    ],
  })),
}));

vi.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    select: (obj: Record<string, unknown>) => obj.ios ?? obj.default,
  },
}));

describe('file-transfer service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes csv content to document directory and opens native share sheet', async () => {
    const fileUri = await saveCsvFile('test.csv', 'test,content');
    expect(fileUri).toContain('test.csv');

    const FileSystem = await import('expo-file-system/legacy');
    const Sharing = await import('expo-sharing');

    expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith(
      'file:///data/user/0/pfm/files/test.csv',
      'test,content',
      { encoding: 'utf8' },
    );
    expect(Sharing.shareAsync).toHaveBeenCalledWith(
      'file:///data/user/0/pfm/files/test.csv',
      expect.objectContaining({ mimeType: 'text/csv' }),
    );
  });

  it('opens system document picker and reads selected file content', async () => {
    const result = await pickAndReadCsvFile();
    expect(result).not.toBeNull();
    expect(result?.fileName).toBe('import.csv');
    expect(result?.content).toContain('occurred_on,kind,amount');
  });

  it('returns null when document picker is cancelled', async () => {
    const DocumentPicker = await import('expo-document-picker');
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
      canceled: true,
      assets: null,
    });

    const result = await pickAndReadCsvFile();
    expect(result).toBeNull();
  });
});
