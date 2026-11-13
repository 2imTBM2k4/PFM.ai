import { describe, expect, it } from 'vitest';

import {
  BudgetInputSchema,
  CategoryInputSchema,
  GoalInputSchema,
  DebtInputSchema,
  DebtChangesSchema,
  DebtRepaymentSchema,
  RecurringInputSchema,
  TransactionInputSchema,
  WalletInputSchema,
} from './entities';

const wallet = '749462b2-1e93-4f64-b705-9f292b98a812';
const destination = '105a98dd-073d-4117-9915-e61fc81787fe';
const category = '594fa4c9-7ec2-47ca-91ef-fb0c27c3538d';
const debt = 'f64368a1-7523-49d4-b2b7-f6e7e205b278';
const base = {
  kind: 'expense',
  amount: 30_000,
  walletId: wallet,
  occurredOn: '2026-10-23',
  occurredAt: '2026-10-23T09:00:00+07:00',
};

describe('core application input contracts', () => {
  it('validates debt metadata and positive whole-VND cash flows without allowing direction edits', () => {
    const input = {
      counterpartyLabel: ' Synthetic ',
      direction: 'borrowed',
      amount: 1000,
      walletId: wallet,
      occurredOn: '2026-10-26',
    };
    expect(DebtInputSchema.parse(input)).toMatchObject({
      counterpartyLabel: 'Synthetic',
      dueOn: null,
    });
    for (const change of [
      { counterpartyLabel: ' ' },
      { amount: 0 },
      { amount: 0.5 },
      { dueOn: '2026-02-30' },
      { direction: 'unknown' },
    ])
      expect(DebtInputSchema.safeParse({ ...input, ...change }).success).toBe(
        false,
      );
    expect(
      DebtChangesSchema.safeParse({
        counterpartyLabel: 'New',
        direction: 'lent',
      }).success,
    ).toBe(false);
    expect(
      DebtRepaymentSchema.safeParse({
        amount: 100,
        walletId: wallet,
        occurredOn: '2026-10-26',
      }).success,
    ).toBe(true);
  });
  it('validates recurrence dates, intervals and transfer references', () => {
    const input = {
      kind: 'expense',
      amount: 100,
      walletId: wallet,
      frequency: 'monthly',
      startOn: '2028-01-31',
    };
    expect(RecurringInputSchema.parse(input)).toMatchObject({
      intervalCount: 1,
      endOn: null,
    });
    for (const change of [
      { intervalCount: 0 },
      { intervalCount: 1.5 },
      { startOn: '2027-02-29' },
      { endOn: '2027-01-01' },
      { kind: 'transfer' },
      { kind: 'transfer', toWalletId: wallet },
      { kind: 'transfer', toWalletId: destination, categoryId: category },
      { toWalletId: destination },
    ])
      expect(
        RecurringInputSchema.safeParse({ ...input, ...change }).success,
      ).toBe(false);
    expect(
      RecurringInputSchema.safeParse({
        ...input,
        kind: 'transfer',
        toWalletId: destination,
      }).success,
    ).toBe(true);
  });
  it('validates wallet names, signed balances and supported kinds', () => {
    expect(
      WalletInputSchema.parse({ name: ' Tiền mặt ', kind: 'cash' }).name,
    ).toBe('Tiền mặt');
    expect(
      WalletInputSchema.parse({
        name: 'Thẻ',
        kind: 'credit_card',
        initialBalance: -1000,
      }).initialBalance,
    ).toBe(-1000);
    expect(
      WalletInputSchema.safeParse({ name: ' ', kind: 'cash' }).success,
    ).toBe(false);
    expect(
      WalletInputSchema.safeParse({ name: 'Ví', kind: 'crypto' }).success,
    ).toBe(false);
    expect(
      WalletInputSchema.safeParse({
        name: 'Ví',
        kind: 'cash',
        initialBalance: 0.5,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields and invalid category kinds', () => {
    expect(
      CategoryInputSchema.safeParse({
        name: 'Ăn uống',
        kind: 'expense',
        parentId: null,
      }).success,
    ).toBe(true);
    expect(
      CategoryInputSchema.safeParse({ name: 'Ăn uống', kind: 'transfer' })
        .success,
    ).toBe(false);
    expect(
      WalletInputSchema.safeParse({
        name: 'Ví',
        kind: 'cash',
        secret: 'not allowed',
      }).success,
    ).toBe(false);
  });

  it('normalizes empty optional text and validates calendar dates', () => {
    expect(TransactionInputSchema.parse({ ...base, note: '' }).note).toBeNull();
    expect(
      TransactionInputSchema.safeParse({ ...base, occurredOn: '2026-02-31' })
        .success,
    ).toBe(false);
    expect(
      TransactionInputSchema.safeParse({ ...base, occurredAt: 'yesterday' })
        .success,
    ).toBe(false);
    expect(
      TransactionInputSchema.safeParse({ ...base, walletId: 'not-a-uuid' })
        .success,
    ).toBe(false);
  });

  it.each([0, -1, 0.5, 100_000_000_001])(
    'rejects invalid transaction amount %s',
    (amount) => {
      expect(
        TransactionInputSchema.safeParse({ ...base, amount }).success,
      ).toBe(false);
    },
  );

  it('requires a distinct destination and no category or debt for transfers', () => {
    expect(
      TransactionInputSchema.safeParse({
        ...base,
        kind: 'transfer',
        toWalletId: destination,
      }).success,
    ).toBe(true);
    for (const fields of [
      {},
      { toWalletId: wallet },
      { toWalletId: destination, categoryId: category },
      { toWalletId: destination, debtId: debt },
    ]) {
      expect(
        TransactionInputSchema.safeParse({
          ...base,
          kind: 'transfer',
          ...fields,
        }).success,
      ).toBe(false);
    }
  });

  it('requires debt linkage and excludes unrelated links on other kinds', () => {
    for (const kind of [
      'debt_borrow',
      'debt_lend',
      'debt_repay_paid',
      'debt_repay_received',
    ]) {
      expect(
        TransactionInputSchema.safeParse({ ...base, kind, debtId: debt })
          .success,
      ).toBe(true);
      expect(TransactionInputSchema.safeParse({ ...base, kind }).success).toBe(
        false,
      );
      expect(
        TransactionInputSchema.safeParse({
          ...base,
          kind,
          debtId: debt,
          categoryId: category,
        }).success,
      ).toBe(false);
    }
    expect(
      TransactionInputSchema.safeParse({ ...base, debtId: debt }).success,
    ).toBe(false);
    expect(
      TransactionInputSchema.safeParse({
        ...base,
        kind: 'income',
        toWalletId: destination,
      }).success,
    ).toBe(false);
  });

  it('validates budget thresholds and month ranges', () => {
    const budget = { amount: 3_000_000, startMonth: '2026-10' };
    expect(BudgetInputSchema.parse(budget).warnPercent).toBe(80);
    expect(
      BudgetInputSchema.safeParse({ ...budget, warnPercent: 101 }).success,
    ).toBe(false);
    expect(
      BudgetInputSchema.safeParse({ ...budget, startMonth: '2026-13' }).success,
    ).toBe(false);
    expect(
      BudgetInputSchema.safeParse({ ...budget, endMonth: '2026-09' }).success,
    ).toBe(false);
  });

  it('accepts unlimited daily budgets but rejects invalid or reversed end dates', () => {
    const daily = {
      amount: 100000,
      periodType: 'custom',
      startDate: '2026-11-30',
      endDate: null,
    };
    expect(BudgetInputSchema.parse(daily).endDate).toBeNull();
    expect(
      BudgetInputSchema.safeParse({ ...daily, endDate: '2026-12-01' }).success,
    ).toBe(true);
    expect(
      BudgetInputSchema.safeParse({ ...daily, endDate: '2026-11-29' }).success,
    ).toBe(false);
    expect(
      BudgetInputSchema.safeParse({ ...daily, endDate: '2026-02-30' }).success,
    ).toBe(false);
  });

  it('allows goals without a deadline and rejects invalid target amounts', () => {
    expect(
      GoalInputSchema.parse({ name: 'Máy tính', targetAmount: 10_000_000 })
        .deadlineOn,
    ).toBeNull();
    expect(
      GoalInputSchema.safeParse({ name: 'Máy tính', targetAmount: 0 }).success,
    ).toBe(false);
    expect(
      GoalInputSchema.safeParse({
        name: 'Máy tính',
        targetAmount: 1000,
        deadlineOn: '2026-02-31',
      }).success,
    ).toBe(false);
  });
});
