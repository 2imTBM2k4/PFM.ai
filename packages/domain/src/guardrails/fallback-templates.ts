import { formatVnd } from '../money';

export interface FallbackTemplateContext {
  intent:
    | 'purchase_affordability'
    | 'loan_estimate'
    | 'savings_plan'
    | 'budget_review'
    | 'spending_overview'
    | 'general';
  calculations?: {
    type: string;
    inputs: Record<string, unknown>;
    results: Record<string, unknown>;
  }[];
  summary?: {
    income: { monthlyAvg: number };
    expense: { monthlyAvg: number };
    surplus: { monthlyAvg: number };
    savings: { liquidBalance: number };
  };
}

// Generate a deterministic Vietnamese fallback response without invoking an LLM.
export function renderFallbackTemplate(ctx: FallbackTemplateContext): string {
  const { intent, calculations = [], summary } = ctx;

  if (intent === 'purchase_affordability') {
    const calc = calculations.find((c) => c.type === 'time_to_afford');
    if (calc) {
      const remaining = Number(calc.results.remaining ?? 0);
      const available = Number(calc.inputs.available ?? 0);
      const typicalMonths = calc.results.typicalMonths as number | null;
      const conservativeMonths = calc.results.conservativeMonths as
        | number
        | null;
      const optimisticMonths = calc.results.optimisticMonths as number | null;
      const typicalSurplus = Number(calc.inputs.surplus ?? 0);

      if (remaining === 0) {
        return 'Bạn đã có đủ tiền cho khoản này.';
      }
      if (typicalMonths === null) {
        return 'Với mức thu chi hiện tại, bạn chưa thể tích lũy cho khoản này. Hãy xem lại các khoản chi lớn để tăng phần dư.';
      }
      return `Bạn đang có ${formatVnd(available)} và cần thêm ${formatVnd(remaining)}. Với phần dư trung bình khoảng ${formatVnd(typicalSurplus)} mỗi tháng, bạn cần khoảng ${typicalMonths} tháng. Nếu tiết kiệm ít hơn bình thường: ${conservativeMonths ?? 'nhiều'} tháng; nếu tiết kiệm tốt hơn: ${optimisticMonths ?? typicalMonths} tháng.`;
    }
  }

  if (intent === 'loan_estimate') {
    const calc = calculations.find((c) => c.type === 'loan_estimate');
    if (calc) {
      const principal = Number(calc.inputs.principal ?? 0);
      const months = Number(calc.inputs.months ?? 0);
      const annualRate = Number(calc.inputs.annualRate ?? 0) * 100;
      const rateType = calc.inputs.rateType === 'flat' ? 'lãi phẳng' : 'dư nợ giảm dần';
      const monthlyPayment = Number(calc.results.monthlyPayment ?? 0);
      const totalInterest = Number(calc.results.totalInterest ?? 0);

      return `Khoản vay ${formatVnd(principal)} trong ${months} tháng, lãi ${annualRate}% mỗi năm (${rateType}): trả khoảng ${formatVnd(monthlyPayment)} mỗi tháng, tổng lãi khoảng ${formatVnd(totalInterest)}.`;
    }
  }

  if (intent === 'savings_plan') {
    const calc = calculations.find((c) => c.type === 'savings_plan');
    if (calc) {
      const target = Number(calc.inputs.target ?? 0);
      const months = Number(calc.inputs.months ?? 0);
      const requiredPerMonth = Number(calc.results.requiredPerMonth ?? 0);

      return `Để đạt ${formatVnd(target)} trong ${months} tháng, bạn cần để dành khoảng ${formatVnd(requiredPerMonth)} mỗi tháng.`;
    }
  }

  if (summary) {
    const incomeAvg = formatVnd(summary.income.monthlyAvg);
    const expenseAvg = formatVnd(summary.expense.monthlyAvg);
    const surplusAvg = formatVnd(summary.surplus.monthlyAvg);

    if (intent === 'budget_review' || intent === 'spending_overview') {
      return `Thu nhập trung bình của bạn là ${incomeAvg}/tháng và chi tiêu trung bình là ${expenseAvg}/tháng, thặng dư trung bình khoảng ${surplusAvg}/tháng.`;
    }

    return `Dưới đây là tóm tắt tài chính của bạn: Thu nhập trung bình ${incomeAvg}/tháng, chi tiêu trung bình ${expenseAvg}/tháng, thặng dư trung bình ${surplusAvg}/tháng.`;
  }

  return 'Hiện tại chưa có đủ dữ liệu để tính toán chi tiết. Bạn hãy tiếp tục ghi chép thêm các khoản thu chi nhé.';
}
