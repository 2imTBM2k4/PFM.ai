import { expect, it } from 'vitest';
import { hasReceiptConsent, saveReceiptConsent, withdrawReceiptConsent } from './receipt-consent';

it('requires explicit local consent before the first receipt upload', async () => {
  let value: string | null = null;
  const db = {
    getFirstAsync: async () => value === null ? null : { value },
    runAsync: async (_sql: string, _key: string, next: string) => { value = next; },
  };
  expect(await hasReceiptConsent(db)).toBe(false);
  await saveReceiptConsent(db, '2026-11-02T00:00:00.000Z');
  expect(await hasReceiptConsent(db)).toBe(true);
  await withdrawReceiptConsent(db);
  expect(await hasReceiptConsent(db)).toBe(false);
});
