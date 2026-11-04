import { expect, it } from 'vitest';
import { makeEntryDrafts } from './draft';
import { receiptToParseResult } from './receipt';

it('turns one receipt payable total into one editable expense draft', () => {
  const parsed = receiptToParseResult({ merchant: 'Quán A', totalVnd: 87000, occurredOn: '2026-11-02', categoryKey: null });
  expect(parsed.candidates).toHaveLength(1);
  expect(parsed.candidates[0]).toMatchObject({ kind: 'expense', amount: { value: 87000 }, date: { value: '2026-11-02' }, noteText: 'Quán A' });
  const drafts = makeEntryDrafts(parsed, { wallets: [], categories: [], debts: [], lastWalletId: null }, () => 'test-id');
  expect(drafts[0]).toMatchObject({ amount: '87.000', note: 'Quán A' });
});

it('requires user-entered total when the scan is uncertain', () => {
  const parsed = receiptToParseResult({ merchant: null, totalVnd: null, occurredOn: null, categoryKey: null });
  expect(parsed.warnings).toContain('NO_AMOUNT');
  expect(parsed.candidates[0].amount.value).toBeNull();
  expect(parsed.candidates).toHaveLength(1);
});

it('suggests the rent category from a housing bill even when the payee name has no rent cue', () => {
  const parsed = receiptToParseResult({ merchant: 'Ban quan ly ABC', totalVnd: 3000000, occurredOn: '2026-11-02', categoryKey: 'expense.housing.rent' });
  const drafts = makeEntryDrafts(parsed, {
    wallets: [], debts: [], lastWalletId: null,
    categories: [{ id: 'rent-id', system_key: 'expense.housing.rent', parent_id: null, name: 'Tiền nhà', kind: 'expense', is_fixed_cost: 1, icon: null, color: null, is_archived: 0, sort_order: 0 }],
  }, () => 'test-id');
  expect(parsed.candidates[0].categoryKey).toBe('expense.housing.rent');
  expect(drafts[0].categoryId).toBe('rent-id');
});

it('keeps a USD receipt amount in USD even when the selected display currency is VND', () => {
  const parsed = receiptToParseResult({ merchant: 'Rent office', totalMinor: 1025, currency: 'USD', occurredOn: '2026-11-02', categoryKey: 'expense.housing.rent' });
  const draft = makeEntryDrafts(parsed, { wallets: [], categories: [], debts: [], lastWalletId: null }, () => 'test-id', 'VND')[0];
  expect(draft).toMatchObject({ amount: '10.25', currency: 'USD' });
});
