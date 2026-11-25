export interface MonthlyFlowPoint {
  month: string;
  income: number;
  expense: number;
}

export const shouldShowDailyTotals = (date: string, currentDate: string) =>
  date <= currentDate;

export interface PeriodSummaryResult {
  totalIncome: number;
  totalExpense: number;
  netSavings: number;
  savingsRatePercent: number;
}

export interface CategoryAllocationItem {
  id: string;
  name: string;
  amount: number;
  percentage: number;
  color: string;
}

export interface DonutCategoryInput {
  id: string | null;
  systemKey?: string | null;
  name: string | null;
  icon?: string | null;
  color?: string | null;
  amount: number;
}

export interface DonutCategoryItem {
  id: string;
  systemKey: string | null;
  name: string;
  icon: string;
  color: string;
  amount: number;
  exactPercent: number;
  percentLabel: string;
}

export interface DonutCalloutPoint {
  item: DonutCategoryItem;
  startAngleDeg: number;
  endAngleDeg: number;
  midAngleDeg: number;
  side: 'left' | 'right';
  anchorX: number;
  anchorY: number;
  elbowX: number;
  labelY: number;
}

export const DONUT_CHART_PALETTE = [
  '#8B7BF6',
  '#F59E0B',
  '#22C58B',
  '#38BDF8',
  '#EC4899',
  '#6366F1',
] as const;

const SYSTEM_CATEGORY_META: Record<
  string,
  { icon: string; color: string }
> = {
  'expense.food': { icon: 'food', color: '#F59E0B' },
  'expense.transport': { icon: 'car', color: '#38BDF8' },
  'expense.housing': { icon: 'home', color: '#8B7BF6' },
  'expense.shopping': { icon: 'cart', color: '#EC4899' },
  'expense.health': { icon: 'heart-pulse', color: '#EF4444' },
  'expense.education': { icon: 'school-outline', color: '#6366F1' },
  'expense.entertainment': { icon: 'gamepad-variant-outline', color: '#A855F7' },
  'expense.family_gifts': { icon: 'gift-outline', color: '#F97316' },
  'expense.bills_subscriptions': { icon: 'receipt-text-outline', color: '#22C58B' },
  'expense.other': { icon: 'tag-outline', color: '#64748B' },
  'income.salary': { icon: 'cash-multiple', color: '#16A34A' },
  'income.business': { icon: 'briefcase-outline', color: '#7C3AED' },
  'income.bonus': { icon: 'gift-outline', color: '#F59E0B' },
  'income.gift': { icon: 'handshake-outline', color: '#EC4899' },
  'income.investment': { icon: 'sprout-outline', color: '#22C58B' },
  'income.other': { icon: 'tag-outline', color: '#0EA5E9' },
};

/**
 * Resolves icon and color metadata for a parent/standalone category row.
 */
export function resolveCategoryVisual(
  row: {
    systemKey?: string | null;
    icon?: string | null;
    color?: string | null;
    id?: string | null;
  },
  fallbackIndex: number,
  isUncategorized: boolean,
): { icon: string; color: string } {
  const sys = row.systemKey ? SYSTEM_CATEGORY_META[row.systemKey] : undefined;
  const fallbackColor = isUncategorized
    ? '#F472B6'
    : (sys?.color ??
      DONUT_CHART_PALETTE[fallbackIndex % DONUT_CHART_PALETTE.length]);
  const fallbackIcon = isUncategorized
    ? 'help-circle-outline'
    : (sys?.icon ?? 'tag-outline');
  return {
    icon: row.icon || fallbackIcon,
    color: row.color || fallbackColor,
  };
}

/**
 * Formats slice percentage for display, showing "<1%" for tiny non-zero shares.
 */
export function formatAllocationPercentLabel(
  amount: number,
  total: number,
  itemCount: number,
): string {
  if (total <= 0 || amount <= 0) return '0%';
  if (itemCount === 1) return '100%';
  const raw = (amount * 100) / total;
  if (raw < 1) return '<1%';
  return `${Math.min(99, Math.round(raw))}%`;
}

/**
 * Aggregates integer income, expense, net savings, and savings rate percentage
 * across a selected time range without floating-point money drift.
 */
export function aggregatePeriodSummary(
  points: readonly MonthlyFlowPoint[],
): PeriodSummaryResult {
  let totalIncome = 0;
  let totalExpense = 0;
  for (const point of points) {
    totalIncome += Math.trunc(point.income);
    totalExpense += Math.trunc(point.expense);
  }
  const netSavings = totalIncome - totalExpense;
  const savingsRatePercent =
    totalIncome > 0 && netSavings > 0
      ? Math.min(100, Math.round((netSavings * 100) / totalIncome))
      : 0;

  return {
    totalIncome,
    totalExpense,
    netSavings,
    savingsRatePercent,
  };
}

/**
 * Computes sorted category allocation items with integer percentages from local categories.
 */
export function computeCategoryAllocation(
  categories: readonly {
    id: string | null;
    name: string | null;
    color?: string | null;
    amount: number;
  }[],
  uncategorizedLabel = 'Chưa phân loại',
): { totalExpense: number; items: CategoryAllocationItem[] } {
  const valid = categories
    .filter((row) => Number.isInteger(row.amount) && row.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const totalExpense = valid.reduce((sum, row) => sum + row.amount, 0);
  if (totalExpense <= 0) {
    return { totalExpense: 0, items: [] };
  }

  const items: CategoryAllocationItem[] = valid.map((row, index) => ({
    id: row.id ?? `uncat-${index}`,
    name: row.name ?? uncategorizedLabel,
    amount: row.amount,
    percentage: Math.max(1, Math.round((row.amount * 100) / totalExpense)),
    color: row.color ?? DONUT_CHART_PALETTE[index % DONUT_CHART_PALETTE.length],
  }));

  return { totalExpense, items };
}

/**
 * Builds full sorted breakdown rows plus capped donut slices (up to 5 top + 1 merged "Other").
 */
export function buildDonutBreakdown(
  categories: readonly DonutCategoryInput[],
  uncategorizedLabel: string,
  otherBucketLabel: string,
  maxIndividualSlices = 5,
): {
  total: number;
  items: DonutCategoryItem[];
  slices: DonutCategoryItem[];
} {
  const valid = categories
    .filter((row) => Number.isSafeInteger(row.amount) && row.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const total = valid.reduce((sum, row) => sum + row.amount, 0);
  if (total <= 0) {
    return { total: 0, items: [], slices: [] };
  }

  const items: DonutCategoryItem[] = valid.map((row, index) => {
    const isUncategorized = row.id === null || row.name === null;
    const visual = resolveCategoryVisual(row, index, isUncategorized);
    return {
      id: row.id ?? `uncat-${index}`,
      systemKey: row.systemKey ?? null,
      name: row.name ?? uncategorizedLabel,
      icon: visual.icon,
      color: visual.color,
      amount: row.amount,
      exactPercent: (row.amount * 100) / total,
      percentLabel: formatAllocationPercentLabel(row.amount, total, valid.length),
    };
  });

  if (items.length <= maxIndividualSlices + 1) {
    return { total, items, slices: items };
  }

  const head = items.slice(0, maxIndividualSlices);
  const tail = items.slice(maxIndividualSlices);
  const tailAmount = tail.reduce((sum, row) => sum + row.amount, 0);
  const sliceCount = head.length + 1;

  const slices: DonutCategoryItem[] = [
    ...head.map((item) => ({
      ...item,
      percentLabel: formatAllocationPercentLabel(item.amount, total, sliceCount),
    })),
    {
      id: 'donut-other-bucket',
      systemKey: null,
      name: otherBucketLabel,
      icon: 'view-grid-outline',
      color: '#94A3B8',
      amount: tailAmount,
      exactPercent: (tailAmount * 100) / total,
      percentLabel: formatAllocationPercentLabel(tailAmount, total, sliceCount),
    },
  ];

  return { total, items, slices };
}

/**
 * Solves non-overlapping left/right donut callout anchor points starting at 12 o'clock clockwise.
 */
export function computeDonutCallouts(
  slices: readonly DonutCategoryItem[],
  centerX: number,
  centerY: number,
  outerRadius: number,
  topBound: number,
  bottomBound: number,
  minVerticalGap: number,
): DonutCalloutPoint[] {
  const total = slices.reduce((sum, slice) => sum + slice.amount, 0);
  if (total <= 0 || slices.length === 0) return [];

  // Enforce a small minimum visual sweep so <1% slices remain visible and selectable.
  const minSweepDeg = slices.length > 1 ? 8 : 360;
  const rawSweeps = slices.map((slice) => (slice.amount / total) * 360);
  const boosted = rawSweeps.map((deg) => Math.max(deg, minSweepDeg));
  const boostedSum = boosted.reduce((sum, deg) => sum + deg, 0);
  const scale = 360 / boostedSum;
  const sweeps = boosted.map((deg) => deg * scale);

  let cursorDeg = -90;
  const rawPoints: DonutCalloutPoint[] = slices.map((item, idx) => {
    const sweep = sweeps[idx];
    const startAngleDeg = cursorDeg;
    const endAngleDeg = cursorDeg + sweep;
    const midAngleDeg = startAngleDeg + sweep / 2;
    cursorDeg = endAngleDeg;

    const rad = (midAngleDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const side: 'left' | 'right' = cos < -0.05 ? 'left' : 'right';
    const anchorX = centerX + Math.cos(rad) * (outerRadius + 2);
    const anchorY = centerY + sin * (outerRadius + 2);
    const elbowX =
      centerX + Math.cos(rad) * (outerRadius + 14);
    const targetY =
      centerY + sin * (outerRadius + 18);

    return {
      item,
      startAngleDeg,
      endAngleDeg,
      midAngleDeg,
      side,
      anchorX,
      anchorY,
      elbowX,
      labelY: targetY,
    };
  });

  const relaxColumn = (column: DonutCalloutPoint[]) => {
    if (column.length === 0) return;
    column.sort((a, b) => a.labelY - b.labelY);
    for (let i = 0; i < column.length; i++) {
      if (column[i].labelY < topBound) column[i].labelY = topBound;
      if (i > 0) {
        const minY = column[i - 1].labelY + minVerticalGap;
        if (column[i].labelY < minY) column[i].labelY = minY;
      }
    }
    const last = column[column.length - 1];
    if (last.labelY > bottomBound) {
      last.labelY = bottomBound;
      for (let i = column.length - 2; i >= 0; i--) {
        const maxY = column[i + 1].labelY - minVerticalGap;
        if (column[i].labelY > maxY) column[i].labelY = maxY;
      }
      if (column[0].labelY < topBound) {
        column[0].labelY = topBound;
      }
    }
  };

  relaxColumn(rawPoints.filter((p) => p.side === 'left'));
  relaxColumn(rawPoints.filter((p) => p.side === 'right'));

  return rawPoints;
}

export type TrendUnitKind = 'million' | 'thousand' | 'base';

export interface TrendChartScale {
  unitKind: TrendUnitKind;
  divisor: number;
  ticks: number[];
  tickLabels: string[];
  minRawValue: number;
  maxRawValue: number;
  zeroRatio: number;
  currencyRate: number;
}

const NICE_STEP_FACTORS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

function pickNiceStep(rawMax: number, intervals: number): number {
  if (rawMax <= 0) return 1;
  const rough = rawMax / intervals;
  const exp = Math.floor(Math.log10(rough));
  const mag = 10 ** exp;
  const norm = rough / mag;
  const nice = NICE_STEP_FACTORS.find((factor) => factor >= norm - 1e-9) ?? 10;
  return Number((nice * mag).toPrecision(12));
}

function formatAxisTick(value: number): string {
  if (Math.abs(value) < 1e-9) return '0';
  const rounded = Number(value.toFixed(1));
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/**
 * Computes clean axis ticks, unit scaling, and zero baseline ratio for cash flow bar charts.
 */
export function computeTrendChartScale(
  rawVndValues: readonly number[],
  allowNegative: boolean,
  currency: 'VND' | 'USD' = 'VND',
  exchangeRate = 25_000,
): TrendChartScale {
  const safeRate =
    currency === 'USD' && exchangeRate > 0 ? exchangeRate : 1;
  const displayValues = rawVndValues.map((v) => v / safeRate);
  const maxVal = displayValues.length > 0 ? Math.max(0, ...displayValues) : 0;
  const minVal =
    allowNegative && displayValues.length > 0
      ? Math.min(0, ...displayValues)
      : 0;
  const maxAbs = Math.max(Math.abs(maxVal), Math.abs(minVal));

  let unitKind: TrendUnitKind = 'million';
  let divisor = 1_000_000;
  if (currency === 'USD') {
    if (maxAbs >= 1_000_000) {
      unitKind = 'million';
      divisor = 1_000_000;
    } else if (maxAbs >= 1_000) {
      unitKind = 'thousand';
      divisor = 1_000;
    } else {
      unitKind = 'base';
      divisor = 1;
    }
  } else if (maxAbs > 0 && maxAbs < 1_000_000) {
    unitKind = maxAbs >= 1_000 ? 'thousand' : 'base';
    divisor = maxAbs >= 1_000 ? 1_000 : 1;
  }

  let ticks: number[];
  let minScaled: number;
  let maxScaled: number;

  if (allowNegative && maxVal > 0 && minVal < 0) {
    const halfIntervals = 3;
    const step = pickNiceStep(maxAbs / divisor, halfIntervals);
    minScaled = -step * halfIntervals;
    maxScaled = step * halfIntervals;
    ticks = [3, 2, 1, 0, -1, -2, -3].map((i) => Number((i * step).toPrecision(12)));
  } else if (allowNegative && maxVal <= 0 && minVal < 0) {
    const intervals = 4;
    const step = pickNiceStep(Math.abs(minVal) / divisor, intervals);
    minScaled = -step * intervals;
    maxScaled = 0;
    ticks = [0, -1, -2, -3, -4].map((i) => Number((i * step).toPrecision(12)));
  } else {
    const intervals = 4;
    const step = pickNiceStep(maxVal / divisor, intervals);
    minScaled = 0;
    maxScaled = step * intervals;
    ticks = [4, 3, 2, 1, 0].map((i) => Number((i * step).toPrecision(12)));
  }

  const minRawValue = minScaled * divisor * safeRate;
  const maxRawValue = maxScaled * divisor * safeRate;
  const span = maxRawValue - minRawValue;
  const zeroRatio = span > 0 ? maxRawValue / span : 1;

  return {
    unitKind,
    divisor,
    ticks,
    tickLabels: ticks.map(formatAxisTick),
    minRawValue,
    maxRawValue,
    zeroRatio,
    currencyRate: safeRate,
  };
}
