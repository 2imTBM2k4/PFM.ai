type ConsentStore = {
  getFirstAsync(sql: string, ...params: (string | number | null)[]): Promise<{ value: string } | null>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<unknown>;
};

const key = 'receipt_ai_consent_v1';

export async function hasReceiptConsent(db: ConsentStore): Promise<boolean> {
  const row = await db.getFirstAsync(
    'SELECT value FROM settings WHERE key=?', key,
  );
  return typeof row?.value === 'string' && !Number.isNaN(Date.parse(row.value));
}

export async function saveReceiptConsent(db: ConsentStore, timestamp: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key, timestamp,
  );
}

export async function withdrawReceiptConsent(db: ConsentStore): Promise<void> {
  await db.runAsync(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key, '',
  );
}
