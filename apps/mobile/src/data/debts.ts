import {
  DebtChangesSchema,
  DebtInputSchema,
  DebtRepaymentSchema,
  type DebtChanges,
  type DebtInput,
  type DebtRepayment,
} from '@pfm/contracts';
import type { Database } from './migrate';
import { insertTransaction } from './transactions';
import type { DebtRow } from './debt-balances';
export { readDebtBalances as listDebts } from './debt-balances';
export type { DebtRow } from './debt-balances';

export async function createDebt(
  db: Database,
  id: string,
  transactionId: string,
  input: DebtInput,
  timestamp: string,
) {
  const value = DebtInputSchema.parse(input);
  await db.transaction(async (tx) => {
    await tx.runAsync(
      'INSERT INTO debts (id,counterparty_label,direction,due_on,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      id,
      value.counterpartyLabel,
      value.direction,
      value.dueOn,
      value.note,
      timestamp,
      timestamp,
    );
    await insertTransaction(
      tx,
      transactionId,
      {
        kind: value.direction === 'borrowed' ? 'debt_borrow' : 'debt_lend',
        amount: value.amount,
        walletId: value.walletId,
        debtId: id,
        occurredOn: value.occurredOn,
        occurredAt: `${value.occurredOn}T12:00:00+07:00`,
        note: value.note,
        affectsWalletBalance: value.affectsWalletBalance,
      },
      timestamp,
    );
  });
}

export async function repayDebt(
  db: Database,
  id: string,
  transactionId: string,
  input: DebtRepayment,
  timestamp: string,
) {
  const value = DebtRepaymentSchema.parse(input);
  await db.transaction(async (tx) => {
    const debt = await tx.getFirstAsync<DebtRow>(
      'SELECT * FROM debts WHERE id=?',
      id,
    );
    if (!debt) throw new Error('DEBT_NOT_FOUND');
    await insertTransaction(
      tx,
      transactionId,
      {
        kind:
          debt.direction === 'borrowed'
            ? 'debt_repay_paid'
            : 'debt_repay_received',
        amount: value.amount,
        walletId: value.walletId,
        debtId: id,
        occurredOn: value.occurredOn,
        occurredAt: `${value.occurredOn}T12:00:00+07:00`,
        note: value.note,
        affectsWalletBalance: value.affectsWalletBalance,
      },
      timestamp,
    );
  });
}

export async function updateDebt(
  db: Database,
  id: string,
  input: DebtChanges,
  timestamp: string,
) {
  const value = DebtChangesSchema.parse(input);
  await db.transaction(async (tx) => {
    if (!(await tx.getFirstAsync('SELECT id FROM debts WHERE id=?', id)))
      throw new Error('DEBT_NOT_FOUND');
    await tx.runAsync(
      'UPDATE debts SET counterparty_label=?,due_on=?,note=?,updated_at=? WHERE id=?',
      value.counterpartyLabel,
      value.dueOn,
      value.note,
      timestamp,
      id,
    );
  });
}
