import type { TransactionInput } from '@pfm/contracts';
import { vi } from '@/messages/vi';
export const DEBT_KIND_LABELS: Partial<
  Record<TransactionInput['kind'], string>
> = {
  get debt_borrow() { return vi.debtBorrow; },
  get debt_lend() { return vi.debtLend; },
  get debt_repay_paid() { return vi.debtRepayPaid; },
  get debt_repay_received() { return vi.debtRepayReceived; },
};
