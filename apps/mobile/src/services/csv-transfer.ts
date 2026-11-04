import { convertMoney, validateDate } from '@pfm/domain';
import { withDatabase } from '@/data/connection';
import { listCategories } from '@/data/categories';
import type { Database } from '@/data/migrate';
import { listWallets } from '@/data/repository';
import { DEFAULT_WALLET_ID, seed } from '@/data/seed';
import { foldSearchText } from '@/data/search-text';
import { listTransactions } from '@/data/transactions';

export interface CsvTransactionRecord {
  occurredOn: string;
  kind: 'expense' | 'income';
  amount: number;
  note: string;
  categoryName: string;
  originalCurrency?: 'USD';
  originalAmountMinor?: number;
  bookingRate?: number;
}

const CSV_HEADER = 'occurred_on,kind,amount,note,category,currency,original_amount_minor,booking_rate';

/**
 * Escapes a single CSV field according to RFC 4180.
 */
function escapeCsvField(value: string): string {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Splits a single CSV line into fields while respecting quoted strings and escaped double-quotes.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Serializes local transaction records into an RFC 4180 CSV string with integer amounts.
 */
export function serializeTransactionsToCsv(
  records: readonly CsvTransactionRecord[],
): string {
  const lines = [CSV_HEADER];
  for (const row of records) {
    const safeAmount = Math.trunc(row.amount);
    lines.push(
      [
        escapeCsvField(row.occurredOn),
        escapeCsvField(row.kind),
        String(safeAmount),
        escapeCsvField(row.note),
        escapeCsvField(row.categoryName),
        row.originalCurrency ?? 'VND',
        String(row.originalAmountMinor ?? row.amount),
        row.bookingRate === undefined ? '' : String(row.bookingRate),
      ].join(','),
    );
  }
  return lines.join('\n');
}

/**
 * Parses and validates CSV text into structured transaction records.
 * Rejects floating-point amounts, non-positive amounts, invalid dates, or unsupported kinds.
 */
export function parseTransactionsFromCsv(
  csvText: string,
): CsvTransactionRecord[] {
  const rawLines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rawLines.length === 0) {
    throw new Error('CSV_EMPTY');
  }

  const startIndex = rawLines[0]
    .toLowerCase()
    .startsWith('occurred_on,kind,amount')
    ? 1
    : 0;
  const dataLines = rawLines.slice(startIndex);
  if (dataLines.length === 0) {
    throw new Error('CSV_NO_ROWS');
  }

  const records: CsvTransactionRecord[] = [];
  for (const line of dataLines) {
    const cols = splitCsvLine(line);
    if (cols.length < 3) {
      throw new Error('CSV_COLUMNS_INVALID');
    }
    const [occurredOn, rawKind, rawAmount, note = '', categoryName = ''] = cols;
    validateDate(occurredOn);

    if (rawKind !== 'expense' && rawKind !== 'income') {
      throw new Error('CSV_KIND_INVALID');
    }

    if (!/^\d+$/.test(rawAmount)) {
      throw new Error('CSV_AMOUNT_NOT_INTEGER');
    }
    const amount = Number(rawAmount);
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > 100_000_000_000
    ) {
      throw new Error('CSV_AMOUNT_OUT_OF_RANGE');
    }

    const rawCurrency = cols[5] ?? 'VND';
    let metadata: Pick<CsvTransactionRecord, 'originalCurrency' | 'originalAmountMinor' | 'bookingRate'> = {};
    if (rawCurrency === 'USD') {
      const originalAmountMinor = Number(cols[6]);
      const bookingRate = Number(cols[7]);
      if (!/^\d+$/.test(cols[6] ?? '') || !Number.isSafeInteger(originalAmountMinor) || originalAmountMinor <= 0 || !Number.isFinite(bookingRate) || bookingRate <= 0 || convertMoney(originalAmountMinor, 'USD', 'VND', bookingRate) !== amount)
        throw new Error('CSV_EXCHANGE_MISMATCH');
      metadata = { originalCurrency: 'USD', originalAmountMinor, bookingRate };
    } else if (rawCurrency !== 'VND' || (cols[6] && Number(cols[6]) !== amount) || cols[7]) {
      throw new Error('CSV_EXCHANGE_MISMATCH');
    }

    records.push({
      occurredOn,
      kind: rawKind,
      amount,
      note,
      categoryName,
      ...metadata,
    });
  }

  return records;
}

/**
 * Exports local SQLite expense/income transactions into a CSV string.
 */
export async function exportLocalTransactionsCsv(): Promise<string> {
  return withDatabase(async (db) => {
    const [transactions, categories] = await Promise.all([
      listTransactions(db),
      listCategories(db, true),
    ]);
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
    const records: CsvTransactionRecord[] = transactions
      .filter(
        (tx): tx is typeof tx & { kind: 'expense' | 'income' } =>
          tx.kind === 'expense' || tx.kind === 'income',
      )
      .map((tx) => ({
        occurredOn: tx.occurred_on,
        kind: tx.kind,
        amount: tx.amount,
        note: tx.note ?? '',
        categoryName:
          (tx.category_id ? categoryMap.get(tx.category_id) : undefined) ?? '',
        ...(tx.original_currency === 'USD'
          ? {
              originalCurrency: 'USD' as const,
              originalAmountMinor: tx.original_amount_minor ?? undefined,
              bookingRate: tx.booking_rate ?? undefined,
            }
          : {}),
      }));
    return serializeTransactionsToCsv(records);
  });
}

/**
 * Imports validated CSV transaction records into the local SQLite database with source='import'.
 */
export async function importLocalTransactionsCsv(
  db: Database,
  csvText: string,
): Promise<number> {
  const records = parseTransactionsFromCsv(csvText);
  const nowIso = new Date().toISOString();
  await seed(db, nowIso);

  const [wallets, categories] = await Promise.all([
    listWallets(db, false),
    listCategories(db, true),
  ]);
  const targetWalletId = wallets[0]?.id ?? DEFAULT_WALLET_ID;

  await db.transaction(async (tx) => {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const matchedCategory = record.categoryName
        ? categories.find(
            (c) =>
              c.kind === record.kind &&
              foldSearchText(c.name) === foldSearchText(record.categoryName),
          )
        : undefined;
      const id = `import-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const occurredAt = `${record.occurredOn}T12:00:00+07:00`;
      await tx.runAsync(
        `INSERT INTO transactions (
          id, kind, amount, wallet_id, to_wallet_id, category_id, debt_id,
          occurred_on, occurred_at, note, note_search, source, created_at, updated_at,
          original_currency, original_amount_minor, booking_rate
        ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, 'import', ?, ?, ?, ?, ?)`,
        id,
        record.kind,
        record.amount,
        targetWalletId,
        matchedCategory?.id ?? null,
        record.occurredOn,
        occurredAt,
        record.note || null,
        foldSearchText(record.note),
        nowIso,
        nowIso,
        record.originalCurrency ?? 'VND',
        record.originalAmountMinor ?? record.amount,
        record.bookingRate ?? null,
      );
    }
  });

  return records.length;
}
