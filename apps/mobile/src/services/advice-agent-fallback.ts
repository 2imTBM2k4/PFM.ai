import { en } from '@/messages/en';
import { vi } from '@/messages/vi';
import type { AgentObservation } from './advice-agent-loop';

type Options = {
  reason: string;
  language: 'vi' | 'en';
  currency: 'VND' | 'USD';
  categories?: { id: string; name: string }[];
  budgets?: { id: string; name: string }[];
};

/** Format only locally calculated observations without converting currencies. */
export function formatAgentFallbackReply(observations: readonly AgentObservation[], options: Options): string {
  const s = options.language === 'vi' ? vi : en;
  const money = (value: number, currency: 'VND' | 'USD') => {
    const sign = value < 0 ? '-' : '';
    const amount = Math.abs(value);
    return currency === 'USD'
      ? `${sign}$${(amount / 100).toFixed(2)}`
      : `${sign}${amount.toLocaleString(options.language === 'vi' ? 'vi-VN' : 'en-US')} ₫`;
  };
  const lines: string[] = [];
  for (const observation of observations) {
    if (observation.result.status !== 'ok') continue;
    const data = observation.result.data as Record<string, any>;
    if (observation.name === 'plan_savings_goal') {
      lines.push(`${s.aiFallbackAvailable}: ${money(data.monthlyAvailable, options.currency)}; ${s.aiFallbackRequired}: ${money(data.requiredMonthlySaving, options.currency)}; ${data.remainingAfterSaving < 0 ? s.aiFallbackShortfall : s.aiFallbackRemaining}: ${money(data.remainingAfterSaving, options.currency)}; ${s.aiFallbackGoal}: ${money(data.goalAmount, options.currency)}; ${s.aiFallbackMonths}: ${data.months}; ${s.aiFallbackReserved}: ${money(data.savingsForGoal, options.currency)}.`);
    } else if (observation.name === 'calculate_budget_status') {
      for (const row of data.budgets) {
        const name = options.budgets?.find((item) => item.id === row.id)?.name ?? options.categories?.find((item) => item.id === row.category_id)?.name;
        lines.push(`${s.aiFallbackBudget}${name ? ` ${name}` : ''}: ${s.aiFallbackLimit}: ${money(row.limit_amount, 'VND')}; ${s.aiFallbackSpent}: ${money(row.spent_amount, 'VND')}; ${s.aiFallbackBudgetRemaining}: ${money(row.remaining_amount, 'VND')}${row.overspent_amount > 0 ? `; ${s.aiFallbackOverspent}: ${money(row.overspent_amount, 'VND')}` : ''}.`);
      }
    } else if (observation.name === 'get_financial_snapshot') {
      const indicators = data.indicators;
      const values = [
        ['monthly_income_avg', s.aiFallbackIncome], ['monthly_expense_avg', s.aiFallbackExpense],
        ['liquid_balance', s.aiFallbackLiquid], ['months_with_data', s.aiFallbackMonthsData],
      ].filter(([key]) => indicators[key] != null).map(([key, label]) => `${label}: ${key === 'months_with_data' ? indicators[key] : money(indicators[key], data.currency)}`);
      lines.push(`${s.aiFallbackPeriod}: ${data.period.from} – ${data.period.to}; ${values.join('; ')}.`);
    } else if (observation.name === 'get_transactions') {
      lines.push(`${s.aiFallbackTransactions}: ${data.transactions.length}${data.truncated ? ` (${s.aiFallbackTruncated})` : ''}.`);
      for (const row of data.transactions) lines.push(`${row.date}: ${money(row.amount, row.currency)}`);
    } else if (observation.name === 'get_spending_breakdown') {
      lines.push(`${s.aiFallbackPeriod}: ${data.period.from} – ${data.period.to}; ${s.aiFallbackTotalIncome}: ${money(data.total_income, 'VND')}; ${s.aiFallbackTotalExpense}: ${money(data.total_expense, 'VND')}; ${s.aiFallbackNetCashFlow}: ${money(data.net, 'VND')}.`);
    } else if (observation.name === 'get_upcoming_obligations') {
      lines.push(`${s.aiFallbackPeriod}: ${data.as_of} – ${data.through}; ${s.aiFallbackScheduledExpense}: ${money(data.scheduled_due.total_expense, 'VND')}; ${s.aiFallbackBorrowedOutstanding}: ${money(data.debts_summary.borrowed_outstanding, 'VND')}; ${s.aiFallbackLentOutstanding}: ${money(data.debts_summary.lent_outstanding, 'VND')}.`);
    } else if (observation.name === 'get_savings_goals') {
      lines.push(`${s.aiFallbackGoalsCount}: ${data.total_count}.`);
      for (const goal of data.goals) lines.push(`${s.aiFallbackGoal}: ${money(goal.target_amount, 'VND')}; ${s.aiFallbackSaved}: ${money(goal.saved_amount, 'VND')}; ${s.aiFallbackBudgetRemaining}: ${money(goal.remaining_amount, 'VND')}.`);
    }
  }
  return lines.join('\n') || s.aiFallbackUnavailable;
}
