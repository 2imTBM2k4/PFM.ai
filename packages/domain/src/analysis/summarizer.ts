import { ratioBps, roundHalfUp } from '../arithmetic';
import { daysInMonth as getDaysInMonth } from '../dates';
import { calculateSurplusPercentiles } from './percentiles';

export const DTI_STRESS_BPS = 4000; // 40%
export const HIGH_VARIANCE_RATIO_BPS = 5000; // 50%
export const MANY_UNCATEGORIZED_RATIO = 0.2; // 20%

export interface MonthlyRecord {
  monthKey: string; // YYYY-MM
  income: number;
  expense: number;
  fixedExpense: number;
  variableExpense: number;
  debtRepayPaid: number;
  uncategorizedExpense: number;
}

export interface CategoryBreakdown {
  key: string; // System category key or 'custom'
  isCustom: boolean;
  totalExpense: number;
  lastMonthExpense: number;
  prevMonthExpense: number;
}

export interface AnalysisInputData {
  generatedForDate: string; // YYYY-MM-DD
  monthsRequested?: number;
  firstTransactionMonth?: string | null;
  completeMonths: MonthlyRecord[];
  categories: CategoryBreakdown[];
  currentMonth: {
    incomeSoFar: number;
    expenseSoFar: number;
    dayOfMonth?: number;
  };
  recurringMonthlyTotal: number;
  liquidBalance: number;
  availableForGoals: number;
  /** Essential spending summed over the same complete-month window, when known. */
  essentialExpenseTotal?: number;
  goals: {
    targetAmount: number;
    currentAmount: number;
    deadline?: string | null;
  }[];
  debts: {
    outstandingBorrowed: number;
    outstandingLent: number;
  };
}

export interface AnalysisSummaryOutput {
  schemaVersion: 1;
  generatedForDate: string;
  currency: 'VND';
  window: {
    monthsRequested: number;
    monthsWithData: number;
  };
  income: {
    monthlyAvg: number;
    monthlyMin: number;
    monthlyMax: number;
  };
  expense: {
    monthlyAvg: number;
    monthlyMin: number;
    monthlyMax: number;
    fixedMonthlyAvg: number;
    variableMonthlyAvg: number;
    essentialMonthlyAvg: number | null;
  };
  surplus: {
    monthlyAvg: number;
    p25: number;
    median: number;
    p75: number;
  };
  currentMonth: {
    incomeSoFar: number;
    expenseSoFar: number;
    daysElapsed: number;
    daysInMonth: number;
    projectedExpense: number | null;
  };
  topExpenseCategories: {
    key: string;
    shareBps: number;
    monthlyAvg: number;
    changeVsPrevPctBps: number | null;
  }[];
  commitments: {
    recurringMonthlyTotal: number;
    debtMonthlyObligation: number;
  };
  savings: {
    liquidBalance: number;
    availableForGoals: number;
    emergencyFundMonths: number | null;
    emergencyFundMonthsEssential: number | null;
  };
  goals: {
    progressBps: number;
    monthsLeft: number | null;
    requiredPerMonth: number | null;
  }[];
  debts: {
    outstandingBorrowed: number;
    outstandingLent: number;
    dtiBps: number | null;
  };
  riskFlags: ('DEBT_STRESS' | 'NO_INCOME_RECORDED')[];
  dataQuality: (
    'FEW_MONTHS' | 'LESS_THAN_3_MONTHS' | 'MANY_UNCATEGORIZED' | 'HIGH_VARIANCE'
  )[];
}

// Build a verified AnalysisSummary conforming to Appendix G from financial aggregates.
export function buildAnalysisSummary(
  data: AnalysisInputData,
): AnalysisSummaryOutput {
  const {
    generatedForDate,
    monthsRequested = 6,
    firstTransactionMonth,
    completeMonths,
    categories,
    currentMonth,
    recurringMonthlyTotal,
    liquidBalance,
    availableForGoals,
    essentialExpenseTotal,
    goals,
    debts,
  } = data;

  // Determine months with data
  let activeMonths: MonthlyRecord[] = completeMonths;
  if (firstTransactionMonth === null) {
    activeMonths = [];
  } else if (typeof firstTransactionMonth === 'string') {
    activeMonths = completeMonths.filter(
      (m) => m.monthKey >= firstTransactionMonth,
    );
  }
  const monthsWithData = activeMonths.length;

  // Income summary
  const incomes = activeMonths.map((m) => m.income);
  const totalIncome = incomes.reduce((acc, v) => acc + v, 0);
  const monthlyAvgIncome =
    monthsWithData > 0 ? roundHalfUp(totalIncome, monthsWithData) : 0;
  const monthlyMinIncome = incomes.length > 0 ? Math.min(...incomes) : 0;
  const monthlyMaxIncome = incomes.length > 0 ? Math.max(...incomes) : 0;

  // Expense summary
  const expenses = activeMonths.map((m) => m.expense);
  const totalExpense = expenses.reduce((acc, v) => acc + v, 0);
  const monthlyAvgExpense =
    monthsWithData > 0 ? roundHalfUp(totalExpense, monthsWithData) : 0;
  const monthlyMinExpense = expenses.length > 0 ? Math.min(...expenses) : 0;
  const monthlyMaxExpense = expenses.length > 0 ? Math.max(...expenses) : 0;

  const totalFixedExpense = activeMonths.reduce(
    (acc, m) => acc + m.fixedExpense,
    0,
  );
  const totalVarExpense = activeMonths.reduce(
    (acc, m) => acc + m.variableExpense,
    0,
  );
  const fixedMonthlyAvg =
    monthsWithData > 0 ? roundHalfUp(totalFixedExpense, monthsWithData) : 0;
  const variableMonthlyAvg =
    monthsWithData > 0 ? roundHalfUp(totalVarExpense, monthsWithData) : 0;
  // Unknown essential spend stays null so no confident number is invented.
  const essentialMonthlyAvg =
    monthsWithData > 0 && essentialExpenseTotal !== undefined
      ? Math.min(
          monthlyAvgExpense,
          roundHalfUp(essentialExpenseTotal, monthsWithData),
        )
      : null;

  // Surplus summary
  const surpluses = activeMonths.map((m) => m.income - m.expense);
  const totalSurplus = surpluses.reduce((acc, v) => acc + v, 0);
  const monthlyAvgSurplus =
    monthsWithData > 0 ? roundHalfUp(totalSurplus, monthsWithData) : 0;
  const surplusPercentiles = calculateSurplusPercentiles(surpluses);

  // Current month projection
  const [yearStr, monthStr, dayStr] = generatedForDate.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const daysInCurrentMonth = getDaysInMonth(year, month);
  const daysElapsed = currentMonth.dayOfMonth ?? parseInt(dayStr, 10);

  const projectedExpense =
    daysElapsed >= 5
      ? roundHalfUp(
          (currentMonth.expenseSoFar * daysInCurrentMonth) / daysElapsed,
        )
      : null;

  // Top expense categories: merge custom categories and cap at top 8
  const mergedCategoriesMap = new Map<
    string,
    {
      key: string;
      totalExpense: number;
      lastMonthExpense: number;
      prevMonthExpense: number;
    }
  >();

  for (const cat of categories) {
    const key = cat.isCustom ? 'custom' : cat.key;
    const existing = mergedCategoriesMap.get(key);
    if (existing) {
      existing.totalExpense += cat.totalExpense;
      existing.lastMonthExpense += cat.lastMonthExpense;
      existing.prevMonthExpense += cat.prevMonthExpense;
    } else {
      mergedCategoriesMap.set(key, {
        key,
        totalExpense: cat.totalExpense,
        lastMonthExpense: cat.lastMonthExpense,
        prevMonthExpense: cat.prevMonthExpense,
      });
    }
  }

  const sortedCategories = Array.from(mergedCategoriesMap.values()).sort(
    (a, b) => b.totalExpense - a.totalExpense,
  );

  const topCategories = sortedCategories.slice(0, 8).map((cat) => {
    const shareBps =
      totalExpense > 0
        ? roundHalfUp((cat.totalExpense * 10000) / totalExpense)
        : 0;
    const monthlyAvg =
      monthsWithData > 0 ? roundHalfUp(cat.totalExpense, monthsWithData) : 0;

    let changeVsPrevPctBps: number | null = null;
    if (cat.prevMonthExpense > 0) {
      changeVsPrevPctBps = roundHalfUp(
        ((cat.lastMonthExpense - cat.prevMonthExpense) * 10000) /
          cat.prevMonthExpense,
      );
    }

    return {
      key: cat.key,
      shareBps,
      monthlyAvg,
      changeVsPrevPctBps,
    };
  });

  // Debt obligation
  const totalDebtPaid = activeMonths.reduce(
    (acc, m) => acc + m.debtRepayPaid,
    0,
  );
  const debtMonthlyObligation =
    monthsWithData > 0 ? roundHalfUp(totalDebtPaid, monthsWithData) : 0;
  const dtiBps =
    monthlyAvgIncome > 0
      ? ratioBps(debtMonthlyObligation, monthlyAvgIncome)
      : null;

  // Savings and emergency fund
  const emergencyFundMonths =
    monthlyAvgExpense > 0
      ? Math.floor(liquidBalance / monthlyAvgExpense)
      : null;
  const emergencyFundMonthsEssential =
    essentialMonthlyAvg !== null && essentialMonthlyAvg > 0
      ? Math.floor(liquidBalance / essentialMonthlyAvg)
      : null;

  // Goals (capped at 5)
  const goalItems = goals.slice(0, 5).map((g) => {
    const progressBps =
      g.targetAmount > 0
        ? Math.min(
            10000,
            roundHalfUp((g.currentAmount * 10000) / g.targetAmount),
          )
        : 10000;

    let monthsLeft: number | null = null;
    let requiredPerMonth: number | null = null;
    if (g.deadline) {
      const [dYear, dMonth] = g.deadline.split('-').map(Number);
      const diffMonths = (dYear - year) * 12 + (dMonth - month);
      monthsLeft = Math.max(1, diffMonths);
      const remaining = Math.max(0, g.targetAmount - g.currentAmount);
      requiredPerMonth = roundHalfUp(remaining, monthsLeft);
    }

    return {
      progressBps,
      monthsLeft,
      requiredPerMonth,
    };
  });

  // Risk flags
  const riskFlags: ('DEBT_STRESS' | 'NO_INCOME_RECORDED')[] = [];
  if (
    (dtiBps !== null && dtiBps >= DTI_STRESS_BPS) ||
    (monthsWithData >= 3 && surplusPercentiles.median <= 0)
  ) {
    riskFlags.push('DEBT_STRESS');
  }
  // A current-month receipt is recorded income even when there are no
  // completed months yet to compute a historical monthly average.
  if (totalIncome === 0 && currentMonth.incomeSoFar === 0) {
    riskFlags.push('NO_INCOME_RECORDED');
  }

  // Data quality flags
  const dataQuality: (
    'FEW_MONTHS' | 'LESS_THAN_3_MONTHS' | 'MANY_UNCATEGORIZED' | 'HIGH_VARIANCE'
  )[] = [];
  if (monthsWithData < 3) {
    dataQuality.push('LESS_THAN_3_MONTHS');
  }
  if (monthsWithData < 4) {
    dataQuality.push('FEW_MONTHS');
  }

  const totalUncategorized = activeMonths.reduce(
    (acc, m) => acc + m.uncategorizedExpense,
    0,
  );
  if (
    totalExpense > 0 &&
    totalUncategorized / totalExpense > MANY_UNCATEGORIZED_RATIO
  ) {
    dataQuality.push('MANY_UNCATEGORIZED');
  }

  if (
    monthlyAvgIncome > 0 &&
    (monthlyMaxIncome - monthlyMinIncome) * 10000 >
      HIGH_VARIANCE_RATIO_BPS * monthlyAvgIncome
  ) {
    dataQuality.push('HIGH_VARIANCE');
  }

  return {
    schemaVersion: 1,
    generatedForDate,
    currency: 'VND',
    window: {
      monthsRequested,
      monthsWithData,
    },
    income: {
      monthlyAvg: monthlyAvgIncome,
      monthlyMin: monthlyMinIncome,
      monthlyMax: monthlyMaxIncome,
    },
    expense: {
      monthlyAvg: monthlyAvgExpense,
      monthlyMin: monthlyMinExpense,
      monthlyMax: monthlyMaxExpense,
      fixedMonthlyAvg,
      variableMonthlyAvg,
      essentialMonthlyAvg,
    },
    surplus: {
      monthlyAvg: monthlyAvgSurplus,
      p25: surplusPercentiles.p25,
      median: surplusPercentiles.median,
      p75: surplusPercentiles.p75,
    },
    currentMonth: {
      incomeSoFar: currentMonth.incomeSoFar,
      expenseSoFar: currentMonth.expenseSoFar,
      daysElapsed,
      daysInMonth: daysInCurrentMonth,
      projectedExpense,
    },
    topExpenseCategories: topCategories,
    commitments: {
      recurringMonthlyTotal,
      debtMonthlyObligation,
    },
    savings: {
      liquidBalance,
      availableForGoals,
      emergencyFundMonths,
      emergencyFundMonthsEssential,
    },
    goals: goalItems,
    debts: {
      outstandingBorrowed: debts.outstandingBorrowed,
      outstandingLent: debts.outstandingLent,
      dtiBps,
    },
    riskFlags,
    dataQuality,
  };
}
