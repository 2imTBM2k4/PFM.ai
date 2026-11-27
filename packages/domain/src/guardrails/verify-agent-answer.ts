import { classifyAdviceScope, isUnsafeAdviceAnswer } from '../advice-scope';
import { APPROX_TOLERANCE_BPS } from './verify-numbers';

export type AgentVerifiedToolRecord =
  | {
      name: 'plan_savings_goal';
      params: Record<string, never>;
      data: {
        monthlyAvailable: number;
        requiredMonthlySaving: number;
        remainingAfterSaving: number;
        months: number;
        goalAmount: number;
        savingsForGoal: number;
      };
    }
  | {
      name: 'get_transactions';
      params: {
        from: string;
        to: string;
        kind?: string | null;
        category_id?: string | null;
        limit?: number;
      };
      data: {
        transactions: {
          id: string;
          date: string;
          amount: number;
          currency: 'VND';
          kind: string;
          category_id: string | null;
        }[];
        truncated: boolean;
      };
    }
  | {
      name: 'calculate_budget_status';
      params: { month: string; budget_id?: string | null };
      data: {
        budgets: {
          id: string;
          category_id: string | null;
          limit_amount: number;
          spent_amount: number;
          remaining_amount: number;
          overspent_amount: number;
        }[];
      };
    }
  | {
      name: 'get_financial_snapshot';
      params: { months: number; fields: string[] };
      data: {
        indicators: Record<string, number | null>;
        period: { from: string; to: string };
        currency: 'VND' | 'USD';
        dataQuality: 'complete' | 'partial' | 'insufficient';
      };
    }
  | {
      name: 'get_spending_breakdown';
      params: { from: string; to: string };
      data: {
        period: { from: string; to: string };
        currency: 'VND';
        total_income: number;
        total_expense: number;
        net: number;
        top_categories: {
          category_id: string | null;
          system_key: string | null;
          amount: number;
        }[];
        other_amount: number;
        uncategorized_amount: number;
        transaction_count: number;
      };
    }
  | {
      name: 'get_upcoming_obligations';
      params: { days_ahead?: number };
      data: {
        as_of: string;
        through: string;
        currency: 'VND';
        scheduled_due: {
          total_count: number;
          total_expense: number;
          total_income: number;
          items: {
            kind: 'expense' | 'income' | 'transfer';
            amount: number;
            due_on: string;
          }[];
        };
        debts_summary: {
          borrowed_outstanding: number;
          lent_outstanding: number;
          open_borrowed_count: number;
          open_lent_count: number;
          nearest_due_on: string | null;
        };
      };
    }
  | {
      name: 'get_savings_goals';
      params: { include_achieved?: boolean };
      data: {
        currency: 'VND';
        total_count: number;
        goals: {
          id: string;
          target_amount: number;
          saved_amount: number;
          remaining_amount: number;
          deadline_on: string | null;
          status: 'active' | 'achieved';
        }[];
      };
    };
export type AgentAnswerContextEvidence = Partial<
  Record<
    | 'income'
    | 'expenseTotal'
    | 'debtOutstanding'
    | 'goalTarget'
    | 'monthlySavingsGoal'
    | 'savingsForGoal'
    | 'savingsMonths'
    | 'purchasePrice'
    | 'monthlyPayment'
    | 'paymentMonths',
    number
  >
> & { expenseItems?: number[]; debtMonthlyPayments?: number[] };
export interface AgentAnswerEvidence {
  tools: AgentVerifiedToolRecord[];
  context?: AgentAnswerContextEvidence;
}
export type AgentVerificationViolationCode =
  | 'UNSAFE_ADVICE'
  | 'SCOPE_VIOLATION'
  | 'PII_DETECTED'
  | 'INTERNAL_FIELD_LEAK'
  | 'UNGROUNDED_NUMBER'
  | 'WRONG_SIGN'
  | 'LABEL_MISMATCH'
  | 'PERIOD_MISMATCH';
export interface AgentAnswerVerificationResult {
  isValid: boolean;
  violations: { code: AgentVerificationViolationCode; detail: string }[];
}

/** Verify assistant claims against validated, locally supplied evidence. */
export function verifyAgentAnswer(
  text: string,
  evidence: AgentAnswerEvidence,
  options: {
    approxToleranceBps?: number;
    checkPii?: (text: string) => boolean;
  } = {},
): AgentAnswerVerificationResult {
  const violations: AgentAnswerVerificationResult['violations'] = [];
  const add = (code: AgentVerificationViolationCode) => {
    if (!violations.some((item) => item.code === code))
      violations.push({ code, detail: code });
  };
  if (isUnsafeAdviceAnswer(text)) add('UNSAFE_ADVICE');
  if (['restricted', 'out_of_scope'].includes(classifyAdviceScope(text).status))
    add('SCOPE_VIOLATION');
  if (
    options.checkPii?.(text) ||
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/\S+|(?:\+84|0)(?:3[2-9]|5[689]|7[06-9]|8[1-9]|9\d)\d{7}\b/i.test(
      text,
    )
  )
    add('PII_DETECTED');
  if (
    /\b(?:monthlyAvailable|requiredMonthlySaving|remainingAfterSaving|goalAmount|savingsForGoal|limit_amount|spent_amount|remaining_amount|overspent_amount|monthly_income_avg|monthly_expense_avg|liquid_balance|months_with_data|stateRevision|calculationVersion|dataQuality|total_income|total_expense|top_categories|other_amount|uncategorized_amount|transaction_count|scheduled_due|debts_summary|borrowed_outstanding|lent_outstanding|open_borrowed_count|open_lent_count|nearest_due_on|target_amount|saved_amount|include_achieved|days_ahead)\b/i.test(
      text,
    )
  )
    add('INTERNAL_FIELD_LEAK');
  const numbers: number[] = [];
  const labels: Record<string, number[]> = {};
  const periods: { from: string; to: string }[] = [];
  const put = (label: string, value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      numbers.push(value);
      (labels[label] ??= []).push(value);
    }
  };
  for (const tool of evidence.tools) {
    if (tool.name === 'plan_savings_goal')
      for (const [key, value] of Object.entries(tool.data)) put(key, value);
    if (tool.name === 'calculate_budget_status') {
      periods.push({
        from: tool.params.month + '-01',
        to: tool.params.month + '-31',
      });
      put('count', tool.data.budgets.length);
      for (const row of tool.data.budgets)
        for (const key of [
          'limit_amount',
          'spent_amount',
          'remaining_amount',
          'overspent_amount',
        ] as const)
          put(key, row[key]);
    }
    if (tool.name === 'get_transactions') {
      periods.push({ from: tool.params.from, to: tool.params.to });
      put('count', tool.data.transactions.length);
      if (tool.data.truncated) put('count', tool.params.limit);
      for (const row of tool.data.transactions) put('transaction', row.amount);
    }
    if (tool.name === 'get_financial_snapshot') {
      periods.push(tool.data.period);
      put('months', tool.params.months);
      for (const [key, value] of Object.entries(tool.data.indicators))
        put(key, value);
    }
    if (tool.name === 'get_spending_breakdown') {
      periods.push(tool.data.period);
      put('total_income', tool.data.total_income);
      put('total_expense', tool.data.total_expense);
      put('net', tool.data.net);
      put('other_amount', tool.data.other_amount);
      put('uncategorized_amount', tool.data.uncategorized_amount);
      put('count', tool.data.transaction_count);
      for (const item of tool.data.top_categories) put('category', item.amount);
    }
    if (tool.name === 'get_upcoming_obligations') {
      periods.push({ from: tool.data.as_of, to: tool.data.through });
      put('days', tool.params.days_ahead ?? 30);
      put('count', tool.data.scheduled_due.total_count);
      put('total_expense', tool.data.scheduled_due.total_expense);
      put('total_income', tool.data.scheduled_due.total_income);
      for (const item of tool.data.scheduled_due.items) put('scheduled', item.amount);
      put('borrowed_outstanding', tool.data.debts_summary.borrowed_outstanding);
      put('lent_outstanding', tool.data.debts_summary.lent_outstanding);
      put('count', tool.data.debts_summary.open_borrowed_count);
      put('count', tool.data.debts_summary.open_lent_count);
      if (tool.data.debts_summary.nearest_due_on)
        periods.push({
          from: tool.data.debts_summary.nearest_due_on,
          to: tool.data.debts_summary.nearest_due_on,
        });
    }
    if (tool.name === 'get_savings_goals') {
      put('count', tool.data.total_count);
      put('count', tool.data.goals.length);
      for (const goal of tool.data.goals) {
        put('target_amount', goal.target_amount);
        put('saved_amount', goal.saved_amount);
        put('remaining_amount', goal.remaining_amount);
        if (goal.deadline_on)
          periods.push({ from: goal.deadline_on, to: goal.deadline_on });
      }
    }
  }
  for (const [key, value] of Object.entries(evidence.context ?? {})) {
    if (Array.isArray(value)) value.forEach((item) => put(key, item));
    else put(key, value);
  }
  const isDateInPeriods = (
    year: number | undefined,
    month: number | undefined,
    day: number | undefined,
  ) =>
    periods.some(({ from, to }) => {
      const start = new Date(from.slice(0, 7) + '-01T00:00:00Z');
      const end = new Date(to.slice(0, 7) + '-01T00:00:00Z');
      for (
        let d = start;
        d <= end;
        d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
      ) {
        if (
          (year === undefined || d.getUTCFullYear() === year) &&
          (month === undefined || d.getUTCMonth() + 1 === month)
        ) {
          if (day === undefined) return true;
          const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          return (
            iso >= from &&
            iso <= to &&
            new Date(iso).toISOString().slice(0, 10) === iso
          );
        }
      }
      return false;
    });
  // Handle same-year short date ranges like "01/08–31/10/2026" or "01/08 đến 31/10/2026".
  const shortRangePattern =
    /\b(\d{1,2})[/-](\d{1,2})\s*(?:[-–—]|đến|den|to)\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/giu;
  const textWithoutShortRanges = text.replace(
    shortRangePattern,
    (match, d1, m1, d2, m2, y) => {
      const year = Number(y);
      const valid =
        isDateInPeriods(year, Number(m1), Number(d1)) &&
        isDateInPeriods(year, Number(m2), Number(d2));
      if (!valid) add('PERIOD_MISMATCH');
      return ' '.repeat(match.length);
    },
  );
  const periodPattern =
    /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{4}|(?:tháng\s+)?\d{1,2}\s+năm\s+\d{4}|(?:tháng\s+)?\d{1,2}\/\d{4}|\d{4}-\d{1,2}|tháng\s+\d{1,2}|năm\s+\d{4})\b/giu;
  const clean = textWithoutShortRanges.replace(
    periodPattern,
    (match, offset: number) => {
      if (
        /^tháng\s+\d{1,2}$/iu.test(match) &&
        (Number(match.match(/\d+/)?.[0]) < 1 ||
          Number(match.match(/\d+/)?.[0]) > 12 ||
          /^[.,]\d/u.test(textWithoutShortRanges.slice(offset + match.length)) ||
          /(?:mỗi|hàng)\s*$/iu.test(textWithoutShortRanges.slice(0, offset)) ||
          /^\s*(?:triệu|trieu|tr\b|tỷ|ty\b|k\b|đồng|đ\b|vnd|₫)/iu.test(
            textWithoutShortRanges.slice(offset + match.length),
          ))
      )
        return match;
      const digits = match.match(/\d+/g)?.map(Number) ?? [];
      let year: number | undefined;
      let month: number | undefined;
      let day: number | undefined;
      if (/^\d{4}-/.test(match)) [year, month, day] = digits;
      else if (digits.length === 3) [day, month, year] = digits;
      else if (digits.length === 2) [month, year] = digits;
      else if (/^năm/i.test(match)) [year] = digits;
      else [month] = digits;
      const valid = isDateInPeriods(year, month, day);
      if (!valid) add('PERIOD_MISMATCH');
      return ' '.repeat(match.length);
    },
  );
  const numberPattern =
    /[+\-−]?\s*\$?\d+(?:[.,]\d+)*(?:\s*(?:(?:triệu|trieu|tr|tỷ|ty|ngàn|ngan|nghìn|nghin|k|m|đồng|dong|vnđ|vnd|usd|đ)(?![\p{L}\p{N}])|₫|%|\$))?/giu;
  const matchNumber = (
    value: number,
    candidates: number[],
    approximate: boolean,
  ) =>
    candidates.some(
      (candidate) =>
        value === candidate ||
        (approximate &&
          value !== 0 &&
          candidate !== 0 &&
          Math.sign(value) === Math.sign(candidate) &&
          Math.abs(value - candidate) / Math.abs(candidate) <=
            (options.approxToleranceBps ?? APPROX_TOLERANCE_BPS) / 10000),
    );
  const labelPatterns: [RegExp, string[]][] = [
    [
      /số dư tài khoản|số dư khả dụng|tổng số dư|tài khoản còn|liquid balance|account balance/iu,
      ['liquid_balance'],
    ],
    [
      /ngân sách còn lại|hạn mức còn lại|còn lại trong ngân sách|remaining budget|remaining allowance/iu,
      ['remaining_amount'],
    ],
    [/vượt ngân sách|vượt hạn mức|chi vượt|overspent/iu, ['overspent_amount']],
    [/hạn mức|định mức|ngân sách đặt ra|budget limit/iu, ['limit_amount']],
    [
      /đã chi|đã tiêu|chi tiêu thực tế|spent/iu,
      ['spent_amount', 'monthly_expense_avg', 'transaction', 'expenseTotal'],
    ],
    [
      /cần tiết kiệm mỗi tháng|cần để dành mỗi tháng|mức tiết kiệm cần thiết|required monthly saving/iu,
      ['requiredMonthlySaving'],
    ],
    [
      /khả năng tiết kiệm mỗi tháng|dư hàng tháng trước khi tiết kiệm|tiền dư mỗi tháng|chênh lệch thu chi|monthly available/iu,
      ['monthlyAvailable'],
    ],
    [
      /còn lại sau khi tiết kiệm|dư sau khi tiết kiệm|thiếu hụt mỗi tháng|thiếu mỗi tháng|remaining after saving|monthly shortfall/iu,
      ['remainingAfterSaving'],
    ],
    [
      /đã có sẵn|đã dành riêng|tiết kiệm sẵn có|existing savings/iu,
      ['savingsForGoal'],
    ],
    [
      /tổng mục tiêu|mục tiêu|goal amount|target/iu,
      ['goalAmount', 'goalTarget'],
    ],
    [
      /thu nhập trung bình|trung bình thu|average monthly income/iu,
      ['monthly_income_avg', 'income'],
    ],
    [
      /chi tiêu trung bình|trung bình chi|average monthly expense/iu,
      ['monthly_expense_avg', 'expenseTotal'],
    ],
  ];
  let previousNumberEnd = 0;
  for (const match of clean.matchAll(numberPattern)) {
    const raw = match[0].trim();
    const index = (match.index ?? 0) + match[0].indexOf(raw);
    const labelStart = previousNumberEnd;
    previousNumberEnd = (match.index ?? 0) + match[0].length;
    if (
      /^[1-9]\d?$/.test(raw) &&
      /^\.\s+/.test(clean.slice(index + raw.length)) &&
      /^\s*$/.test(clean.slice(clean.lastIndexOf('\n', index - 1) + 1, index))
    )
      continue;
    const part = raw.match(/\d+(?:[.,]\d+)*/)?.[0] ?? '';
    const unit = raw.toLowerCase();
    let base: number;
    if (/^\d{1,3}([.,]\d{3})+$/.test(part))
      base = Number(part.replace(/[.,]/g, ''));
    else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(part))
      base = Number(part.replace(/,/g, ''));
    else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(part))
      base = Number(part.replace(/\./g, '').replace(',', '.'));
    else base = Number(part.replace(',', '.'));
    if (/triệu|trieu|tr\b|\d\s*m\b/i.test(unit)) base *= 1e6;
    else if (/tỷ|ty\b/i.test(unit)) base *= 1e9;
    else if (/ngàn|ngan|nghìn|nghin|\d\s*k\b/i.test(unit)) base *= 1e3;
    if (!Number.isFinite(base)) {
      add('UNGROUNDED_NUMBER');
      continue;
    }
    if (/^\d{10,}$/.test(part) && !numbers.includes(base)) add('PII_DETECTED');
    const before = clean.slice(Math.max(0, index - 100), index);
    const clause = before.split(/[!?;\n]|,(?!\d)|\.(?!\d)/).at(-1) ?? '';
    const negative =
      /^[-−]/.test(raw) ||
      /(?:thiếu|còn thiếu|thiếu hụt|âm|thâm hụt|shortfall|deficit|short by|negative)(?:\s+mỗi\s+tháng)?(?:\s+(?:khoảng|xấp xỉ|tầm|gần|about|around|approximately|roughly))?\s*$/iu.test(
        clause,
      );
    const positive =
      /^\+/.test(raw) ||
      /(?:còn dư|dư ra|dư|thặng dư|surplus|left over)(?:\s+(?:khoảng|xấp xỉ|tầm|gần|about|around|approximately|roughly))?\s*$/iu.test(
        clause,
      );
    const approximate =
      /(?:khoảng|xấp xỉ|tầm|gần|about|around|approximately|roughly)\s*$/iu.test(
        before,
      );
    const overspent =
      /(?:vượt ngân sách|vượt hạn mức|chi vượt|overspent)\s*$/iu.test(clause);
    const signed = negative ? -base : base;
    if (
      negative &&
      !matchNumber(signed, numbers, approximate) &&
      !(
        overspent &&
        matchNumber(base, labels.overspent_amount ?? [], approximate)
      )
    )
      add('WRONG_SIGN');
    else if (
      positive &&
      !matchNumber(base, numbers, approximate) &&
      matchNumber(-base, numbers, approximate)
    )
      add('WRONG_SIGN');
    else if (
      !matchNumber(signed, numbers, approximate) &&
      !(
        overspent &&
        matchNumber(base, labels.overspent_amount ?? [], approximate)
      )
    )
      add('UNGROUNDED_NUMBER');
    let best: { index: number; end: number; keys: string[] } | undefined;
    const labelClause =
      clean
        .slice(Math.max(labelStart, index - 100), index)
        .split(/[!?;\n]|,(?!\d)|\.(?!\d)/)
        .at(-1) ?? '';
    const countOrDuration =
      /^\s*(?:tháng|thang|months?|giao dịch|ngân sách)(?![\p{L}\p{N}])/iu.test(
        clean.slice(previousNumberEnd),
      );
    for (const [pattern, keys] of labelPatterns) {
      if (countOrDuration) break;
      const found = pattern.exec(labelClause);
      if (found && (!best || found.index >= best.end))
        best = { index: found.index, end: found.index + found[0].length, keys };
    }
    if (best) {
      const allowed = best.keys.flatMap((key) => labels[key] ?? []);
      if (
        !matchNumber(signed, allowed, approximate) &&
        !(overspent && matchNumber(base, allowed, approximate))
      )
        add('LABEL_MISMATCH');
    }
  }
  return { isValid: violations.length === 0, violations };
}
