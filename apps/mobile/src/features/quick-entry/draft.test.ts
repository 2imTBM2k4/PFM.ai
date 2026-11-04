import { describe, expect, it } from 'vitest';
import { parseEntry } from '@pfm/domain';
import { makeEntryDrafts, confirmEntryDraft } from './draft';
import type { WalletRow } from '@/data/repository';
import type { CategoryRow } from '@/data/categories';

const walletId = '00000000-0000-4000-8000-000000000001';
const categoryId = '00000000-0000-4000-8001-000000000002';
const now = new Date('2026-10-23T09:00:00+07:00');
const clock = { now: () => now, timeZone: 'Asia/Ho_Chi_Minh' };
const wallet: WalletRow = {
  id: walletId,
  name: 'Cash',
  kind: 'cash',
  balance: 0,
  initial_balance: 0,
  is_archived: 0,
  sort_order: 0,
  is_goal_funding: 0,
};
const category: CategoryRow = {
  id: categoryId,
  system_key: 'expense.food.eating_out',
  name: 'Food',
  kind: 'expense',
  parent_id: null,
  is_archived: 0,
  is_fixed_cost: 0,
  icon: null,
  color: null,
  sort_order: 0,
};
const context = {
  wallets: [wallet],
  categories: [category],
  debts: [],
  lastWalletId: walletId,
};
let serial = 0;
const id = () =>
  `00000000-0000-4000-8002-${String(++serial).padStart(12, '0')}`;

describe('editable quick-entry confirmation', () => {
  it('keeps a parsed USD rent amount in cents and requires a booking rate', () => {
    const result = parseEntry('spent $10 on rent', { clock, currency: 'USD' });
    const draft = makeEntryDrafts(result, context, id, 'USD')[0];
    expect(draft).toMatchObject({ amount: '10.00', currency: 'USD', kind: 'expense' });
    expect(() => confirmEntryDraft(result.candidates[0], draft, now)).toThrow();
    expect(confirmEntryDraft(result.candidates[0], draft, now, 25_500).input).toMatchObject({
      amount: 1000,
      currency: 'USD',
      vndPerUsd: 25_500,
    });
  });
  it('builds a default draft from actual parser/classifier output without changing it', () => {
    const result = parseEntry('ăn sáng 30k hôm qua', { clock });
    const before = JSON.stringify(result);
    const drafts = makeEntryDrafts(result, context, id);
    expect(drafts[0]).toMatchObject({
      selected: true,
      kind: 'expense',
      amount: '30.000',
      categoryId,
      walletId,
      date: '2026-10-22',
    });
    expect(
      confirmEntryDraft(result.candidates[0], drafts[0], now),
    ).toMatchObject({
      input: {
        amount: 30000,
        kind: 'expense',
        categoryId,
        walletId,
        occurredOn: '2026-10-22',
        occurredAt: '2026-10-22T08:00:00+07:00',
      },
    });
    expect(JSON.stringify(result)).toBe(before);
  });

  it('requires explicit acknowledgement of assumed thousands, including after amount edits', () => {
    const result = parseEntry('ăn sáng 30', { clock });
    const draft = makeEntryDrafts(result, context, id)[0];
    expect(() => confirmEntryDraft(result.candidates[0], draft, now)).toThrow(
      'ENTRY_AMOUNT_CONFIRMATION',
    );
    expect(() =>
      confirmEntryDraft(
        result.candidates[0],
        { ...draft, amount: '40.000' },
        now,
      ),
    ).toThrow('ENTRY_AMOUNT_CONFIRMATION');
    expect(
      confirmEntryDraft(
        result.candidates[0],
        { ...draft, amount: '40.000', amountConfirmed: true },
        now,
      ).input.amount,
    ).toBe(40000);
  });

  it('never silently changes an unknown kind to expense', () => {
    const result = parseEntry('bạn trả tiền ăn 100k', { clock });
    const draft = makeEntryDrafts(result, context, id)[0];
    expect(draft.kind).toBe('unknown');
    expect(() => confirmEntryDraft(result.candidates[0], draft, now)).toThrow(
      'ENTRY_KIND',
    );
    expect(
      confirmEntryDraft(
        result.candidates[0],
        { ...draft, kind: 'income', categoryId: '' },
        now,
      ).input.kind,
    ).toBe('income');
  });

  it('blocks invalid money/date/transfer and uses noon only when the parsed date was edited', () => {
    const result = parseEntry('cf 30k tối qua', { clock });
    const draft = makeEntryDrafts(result, context, id)[0];
    for (const amount of ['0', '-30', '1.5', '100.000.000.001'])
      expect(() =>
        confirmEntryDraft(result.candidates[0], { ...draft, amount }, now),
      ).toThrow();
    expect(() =>
      confirmEntryDraft(
        result.candidates[0],
        { ...draft, date: '2026-02-30' },
        now,
      ),
    ).toThrow();
    expect(() =>
      confirmEntryDraft(
        result.candidates[0],
        { ...draft, kind: 'transfer' },
        now,
      ),
    ).toThrow();
    expect(
      confirmEntryDraft(result.candidates[0], draft, now).input.occurredAt,
    ).toBe('2026-10-22T19:00:00+07:00');
    expect(
      confirmEntryDraft(
        result.candidates[0],
        { ...draft, date: '2026-10-20' },
        now,
      ).input.occurredAt,
    ).toBe('2026-10-20T12:00:00+07:00');
  });

  it('does not sum multiple amounts and excludes archived or wrong-kind category hints', () => {
    const result = parseEntry('cf 30k bánh 20k', { clock });
    expect(makeEntryDrafts(result, context, id).map((d) => d.amount)).toEqual([
      '30.000',
      '20.000',
    ]);
    const food = parseEntry('ăn sáng 30k', { clock });
    expect(
      makeEntryDrafts(
        food,
        { ...context, categories: [{ ...category, is_archived: 1 }] },
        id,
      )[0].categoryId,
    ).toBe('');
    expect(
      makeEntryDrafts(
        food,
        { ...context, categories: [{ ...category, kind: 'income' }] },
        id,
      )[0].categoryId,
    ).toBe('');
  });

  it('uses a unique wallet hint or exact wallet name without guessing among multiple active wallets', () => {
    const bank: WalletRow = {
      ...wallet,
      id: 'bank-1',
      name: 'VCB',
      kind: 'bank',
    };
    const cash: WalletRow = {
      ...wallet,
      id: 'cash-1',
      name: 'Tiền mặt',
      kind: 'cash',
    };
    const anotherCash: WalletRow = {
      ...wallet,
      id: 'cash-2',
      name: 'Ví dự phòng',
      kind: 'cash',
    };
    const input = parseEntry('cf 40k tiền mặt', { clock });
    expect(
      makeEntryDrafts(
        input,
        { ...context, wallets: [bank, cash], lastWalletId: bank.id },
        id,
      )[0].walletId,
    ).toBe(cash.id);
    expect(
      makeEntryDrafts(
        input,
        {
          ...context,
          wallets: [bank, cash, anotherCash],
          lastWalletId: bank.id,
        },
        id,
      )[0].walletId,
    ).toBe(cash.id);
    expect(
      makeEntryDrafts(
        input,
        {
          ...context,
          wallets: [bank, { ...cash, name: 'Cash' }, anotherCash],
          lastWalletId: bank.id,
        },
        id,
      )[0].walletId,
    ).toBe('');
    expect(
      makeEntryDrafts(
        input,
        {
          ...context,
          wallets: [bank, { ...cash, is_archived: 1 }],
          lastWalletId: bank.id,
        },
        id,
      )[0].walletId,
    ).toBe(bank.id);
  });

  it('requires a counterparty for each new loan and an existing debt for repayment', () => {
    const loan = parseEntry('mượn Hùng 500k', { clock });
    const draft = makeEntryDrafts(loan, context, id)[0];
    expect(() => confirmEntryDraft(loan.candidates[0], draft, now)).toThrow(
      'ENTRY_COUNTERPARTY',
    );
    expect(
      confirmEntryDraft(
        loan.candidates[0],
        { ...draft, counterpartyLabel: ' Hùng ' },
        now,
      ).newDebt,
    ).toMatchObject({ counterpartyLabel: 'Hùng' });
    const repayment = parseEntry('trả nợ Hùng 30k', {
      clock,
      knownCounterparties: ['Hùng'],
    });
    expect(() =>
      confirmEntryDraft(
        repayment.candidates[0],
        makeEntryDrafts(repayment, context, id)[0],
        now,
      ),
    ).toThrow('ENTRY_DEBT_REQUIRED');
  });
});
