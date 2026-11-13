import { budgetThresholds } from '@pfm/domain';
import {
  claimBudgetAlert,
  readBudgetMonth,
  releaseBudgetAlert,
} from '@/data/budgets';
import type { Database } from '@/data/migrate';

export interface BudgetAlertPort {
  hasPermission(): Promise<boolean>;
  send(budgetId: string, month: string, threshold: number): Promise<void>;
}

export async function processBudgetAlerts(
  db: Database,
  month: string,
  port: BudgetAlertPort,
  referenceDate?: string,
) {
  if (!(await port.hasPermission())) return;
  const rows = await readBudgetMonth(db, month, undefined, referenceDate);
  for (const budget of rows.filter((row) => row.is_active && row.in_period)) {
    const period = budget.period_key ?? month;
    for (const threshold of budgetThresholds(
      budget.spent,
      budget.amount,
      budget.warn_percent,
    )) {
      if (
        !(await claimBudgetAlert(
          db,
          budget.id,
          period,
          threshold,
          new Date().toISOString(),
        ))
      )
        continue;
      try {
        // shortcut: claim-before-send avoids duplicates after a crash but can miss a crash-window alert; reconcile native delivery before release.
        await port.send(budget.id, period, threshold);
      } catch (error) {
        await releaseBudgetAlert(db, budget.id, period, threshold);
        throw error;
      }
    }
  }
}
