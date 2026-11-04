import type { AdviceDateRange, Clock } from '@pfm/domain';
import { today as readToday } from '@pfm/domain';
import type {
  AdviceCategoryItem,
  AdviceFactData,
} from '@/data/advice-insights';
import { formatCurrencyAmount } from '@/state/preferences';
import type { CurrencyCode } from '@/constants/design-tokens';
import type { AIChartItem, AIResponsePayload } from '@/services/ai-service';

export type AdviceFactKind = 'expense_by_category' | 'cash_flow';

export const ADVICE_FACT_KINDS: readonly AdviceFactKind[] = [
  'expense_by_category',
  'cash_flow',
] as const;

export type { AdviceFactData };

export interface AdviceFactLabels {
  /** Resolve a stored/system category label for the active language. */
  category(name: string, systemKey: string | null): string;
  date(from: string, to: string): string;
  expenseHeadline(total: string, range: string): string;
  expenseOther(total: string, range: string): string;
  noDataExpense(range: string): string;
  cashFlowHeadline(
    income: string,
    expense: string,
    net: string,
    range: string,
  ): string;
  noDataCashFlow(range: string): string;
  uncategorizedSuffix(total: string, count: number): string;
  chartTitle(range: string): string;
}

export const FACT_CHART_COLORS = [
  '#7C5CFF',
  '#FF7AD9',
  '#16A34A',
  '#0EA5E9',
  '#F59E0B',
] as const;

const MONTH_NAMES_VI = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
] as const;
const MONTH_NAMES_EN = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Render an ISO range into a short, unambiguous local label. The year is only
 * added when the window leaves the current year, and same-day ranges collapse.
 */
export function formatFactRange(
  range: AdviceDateRange,
  language: 'vi' | 'en',
  forToday: string,
): string {
  const [year, month, day] = range.from.split('-');
  const [endYear, endMonth, endDay] = range.to.split('-');
  const sameYear = year === endYear;
  const dayNumber = (value: string) => String(Number(value));
  const monthName = (value: string) => {
    const index = Number(value) - 1;
    const names = language === 'en' ? MONTH_NAMES_EN : MONTH_NAMES_VI;
    return names[index] ?? value;
  };
  const withYear = (value: string) =>
    year === forToday.slice(0, 4) ? value : `${value}/${year}`;

  if (range.from === range.to) {
    return sameYear
      ? withYear(`${dayNumber(day)}/${monthName(month)}`)
      : `${dayNumber(day)}/${monthName(month)}/${year}`;
  }
  if (language === 'en') {
    return sameYear && year === forToday.slice(0, 4)
      ? `${monthName(month)} ${Number(day)} – ${monthName(endMonth)} ${Number(endDay)}`
      : `${monthName(month)} ${Number(day)}, ${year} – ${monthName(endMonth)} ${Number(endDay)}, ${endYear}`;
  }
  return sameYear
    ? withYear(
        `${dayNumber(day)}/${monthName(month)} – ${dayNumber(endDay)}/${monthName(endMonth)}`,
      )
    : `${dayNumber(day)}/${monthName(month)}/${year} – ${dayNumber(endDay)}/${monthName(endMonth)}/${endYear}`;
}

export function toChartItems(
  lines: AdviceCategoryItem[],
  labels: AdviceFactLabels,
): AIChartItem[] {
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  if (total <= 0) return [];
  return lines.map((line, index) => ({
    category: labels.category(line.name, line.systemKey),
    percentage: Math.max(1, Math.round((line.amount * 100) / total)),
    amount: line.amount,
    color: FACT_CHART_COLORS[index % FACT_CHART_COLORS.length],
  }));
}

function formatMoney(
  amountVnd: number,
  currency: CurrencyCode,
  exchangeRate: number | null,
): string {
  return formatCurrencyAmount(
    amountVnd,
    currency,
    currency === 'USD' && exchangeRate !== null
      ? { rate: exchangeRate }
      : undefined,
  );
}

/**
 * Build a deterministic on-device answer for a numeric question. No network call
 * and no model inference happens for these turns.
 */
export function buildFactualAdviceReply(input: {
  kind: AdviceFactKind;
  range: AdviceDateRange;
  data: AdviceFactData;
  labels: AdviceFactLabels;
  language: 'vi' | 'en';
  currency: CurrencyCode;
  exchangeRate: number | null;
  userMessageId: string;
  clock?: Clock;
}): AIResponsePayload {
  const {
    kind,
    range,
    data,
    labels,
    language,
    currency,
    exchangeRate,
    userMessageId,
  } = input;
  const clock = input.clock ?? {
    now: () => new Date(),
    timeZone: 'Asia/Ho_Chi_Minh',
  };
  const createdAt = new Date().toISOString();
  const id = `ai-${userMessageId}`;
  const money = (value: number) => formatMoney(value, currency, exchangeRate);
  const currentDate = readToday(clock);

  if (kind === 'cash_flow' && data.kind === 'cash_flow') {
    const rangeLabel = formatFactRange(range, language, currentDate);
    if (data.incomeCount + data.expenseCount === 0) {
      return {
        id,
        userMessageId,
        replyText: labels.noDataCashFlow(rangeLabel),
        createdAt,
      };
    }
    return {
      id,
      userMessageId,
      replyText: labels.cashFlowHeadline(
        money(data.totalIncome),
        money(data.totalExpense),
        money(data.net),
        rangeLabel,
      ),
      createdAt,
    };
  }

  if (data.kind !== 'expense_by_category') {
    throw new Error('ADVICE_FACT_DATA_MISMATCH');
  }

  if (data.transactionCount === 0) {
    return {
      id,
      userMessageId,
      replyText: labels.noDataExpense(
        formatFactRange(range, language, currentDate),
      ),
      createdAt,
    };
  }

  const rangeLabel = formatFactRange(range, language, currentDate);
  const lines = data.topCategories.map((line) => {
    const share = Math.round((line.amount * 100) / data.totalExpense);
    return `• ${labels.category(line.name, line.systemKey)}: ${money(line.amount)} (${share}%)`;
  });
  if (data.otherAmount > 0) {
    lines.push(`• ${labels.expenseOther(money(data.otherAmount), rangeLabel)}`);
  }
  const uncategorized =
    data.uncategorizedAmount > 0
      ? `\n${labels.uncategorizedSuffix(money(data.uncategorizedAmount), data.transactionCount)}`
      : '';

  return {
    id,
    userMessageId,
    replyText: `${labels.expenseHeadline(money(data.totalExpense), rangeLabel)}\n${lines.join('\n')}${uncategorized}`,
    chartTitle: labels.chartTitle(rangeLabel),
    chartItems: toChartItems(data.topCategories, labels),
    createdAt,
  };
}
