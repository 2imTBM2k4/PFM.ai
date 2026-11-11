import { describe, expect, it } from 'vitest';
import { parseEntry } from '@pfm/domain';
import { makeEntryDrafts, type EntryReferences } from './draft';
import { quickEntryErrors } from './validation';

const clock = {
  now: () => new Date('2026-11-11T12:00:00+07:00'),
  timeZone: 'Asia/Ho_Chi_Minh',
};
const refs: EntryReferences = {
  wallets: [
    {
      id: 'wallet',
      name: 'Cash',
      kind: 'cash',
      balance: 1000000,
      initial_balance: 1000000,
      is_archived: 0,
      sort_order: 0,
      is_goal_funding: 0,
    },
  ],
  categories: [],
  lastWalletId: 'wallet',
  debts: [
    {
      id: 'debt',
      counterparty_label: 'Minh',
      direction: 'borrowed',
      due_on: null,
      note: null,
      status: 'open',
      created_at: '',
      updated_at: '',
      principal: 100000,
      repaid: 0,
      outstanding: 100000,
    },
  ],
};
const result = parseEntry('spent 30000 on food', { clock });
const draft = {
  ...makeEntryDrafts(result, refs, () => 'id')[0],
  kind: 'expense' as const,
  amount: '30000',
  date: '2026-11-11',
  amountConfirmed: true,
};

describe('quick entry field errors', () => {
  it('accepts valid rows and ignores invalid deselected rows', () => {
    expect(quickEntryErrors(result, [draft], refs, null)).toEqual([{}]);
    expect(
      quickEntryErrors(
        result,
        [{ ...draft, selected: false, amount: '', date: '', walletId: '' }],
        refs,
        null,
      ),
    ).toEqual([{}]);
  });
  it('reports invalid money, dates, wallets, kind and counterparty on their fields', () => {
    expect(
      quickEntryErrors(
        result,
        [
          {
            ...draft,
            kind: 'unknown',
            amount: 'abc',
            date: '2026-02-30',
            walletId: '',
          },
        ],
        refs,
        null,
      )[0],
    ).toMatchObject({
      amount: { type: 'validate' },
      date: { type: 'validate' },
      walletId: { type: 'validate' },
      kind: { type: 'validate' },
    });
    expect(
      quickEntryErrors(
        result,
        [{ ...draft, kind: 'debt_borrow', counterpartyLabel: ' ' }],
        refs,
        null,
      )[0],
    ).toHaveProperty('counterpartyLabel');
  });
  it('rejects same-wallet transfers and inactive category parents', () => {
    expect(
      quickEntryErrors(
        result,
        [{ ...draft, kind: 'transfer', toWalletId: draft.walletId }],
        refs,
        null,
      )[0],
    ).toHaveProperty('toWalletId');
    const category = {
      id: 'child',
      name: 'Food',
      kind: 'expense' as const,
      parent_id: 'parent',
      is_archived: 0,
      system_key: null,
      is_fixed_cost: 0,
      icon: null,
      color: null,
      sort_order: 0,
    };
    expect(
      quickEntryErrors(
        result,
        [{ ...draft, categoryId: 'child' }],
        {
          ...refs,
          categories: [
            category,
            { ...category, id: 'parent', parent_id: null, is_archived: 1 },
          ],
        },
        null,
      )[0],
    ).toHaveProperty('categoryId');
  });
  it('checks combined repayments against remaining debt, excluding unselected rows', () => {
    const repayment = {
      ...draft,
      kind: 'debt_repay_paid' as const,
      debtId: 'debt',
      amount: '60000',
    };
    expect(
      quickEntryErrors(result, [repayment, repayment], refs, null),
    ).toMatchObject([{}, { amount: { type: 'validate' } }]);
    expect(
      quickEntryErrors(
        result,
        [{ ...repayment, selected: false }, repayment],
        refs,
        null,
      ),
    ).toEqual([{}, {}]);
    expect(
      quickEntryErrors(
        result,
        [{ ...repayment, amount: '100000' }],
        refs,
        null,
      ),
    ).toEqual([{}]);
    expect(
      quickEntryErrors(
        result,
        [{ ...repayment, kind: 'debt_repay_received' }],
        refs,
        null,
      )[0],
    ).toHaveProperty('debtId');
  });
  it('requires a USD rate and compares converted repayment values', () => {
    const repayment = {
      ...draft,
      kind: 'debt_repay_paid' as const,
      debtId: 'debt',
      currency: 'USD' as const,
      amount: '4.00',
    };
    expect(quickEntryErrors(result, [repayment], refs, null)[0]).toHaveProperty(
      'currency',
    );
    expect(quickEntryErrors(result, [repayment], refs, 25000)).toEqual([{}]);
    expect(
      quickEntryErrors(
        result,
        [{ ...repayment, amount: '4.01' }],
        refs,
        25000,
      )[0],
    ).toHaveProperty('amount');
  });
  it('requires acknowledgement when the parser assumed thousands', () => {
    const assumed = {
      ...result,
      candidates: result.candidates.map((candidate) => ({
        ...candidate,
        explanation: [...candidate.explanation, 'amount.assumed_thousands'],
      })),
    };
    expect(
      quickEntryErrors(
        assumed,
        [{ ...draft, amountConfirmed: false }],
        refs,
        null,
      )[0],
    ).toHaveProperty('amountConfirmed');
  });
});
