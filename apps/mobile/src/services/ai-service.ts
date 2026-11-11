import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { AdvicePlanResponseSchema, type Intent } from '@pfm/contracts';
import {
  classifyAdviceScope,
  findPreviousFactQuery,
  monthKey,
  parseAdviceQuery,
  today,
  type AdviceDateRange,
  type AdviceTopic,
} from '@pfm/domain';
import { formatMoney as formatVnd } from '@/utils/display-money';
import { readAnalysisSummary } from '@/data/analysis';
import {
  readCashFlow,
  readExpenseByCategory,
  type AdviceFactData,
} from '@/data/advice-insights';
import { readAdviceGroups } from '@/data/advice-groups';
import { withDatabase } from '@/data/connection';
import { readDashboard } from '@/data/dashboard';
import type { Database, Queries } from '@/data/migrate';
import { AI_REPLIES_SETTING_KEY } from '@/data/repository';
import { foldSearchText } from '@/data/search-text';
import { en } from '@/messages/en';
import { vi } from '@/messages/vi';
import { displayCategoryName, factsLabels } from '@/messages/seed-labels';
import { getOrCreateDeviceId } from '@/services/device-id';
import { computeAdviceMetrics } from '@/services/advice-metrics';
import { buildFactualAdviceReply } from '@/services/advice-factual';
import { tryAIBudgetSetup } from '@/services/ai-budget-setup';
import { usePreferences } from '@/state/preferences';

export interface AIChartItem {
  category: string;
  percentage: number;
  amount: number;
  color: string;
}

export interface AIResponsePayload {
  id: string;
  userMessageId: string;
  replyText: string;
  chartTitle?: string;
  chartItems?: AIChartItem[];
  createdAt: string;
}

export interface AIServiceContext {
  balance: number;
  monthlyIncome: number;
  monthlyExpense: number;
  monthlyNet: number;
  topCategories: { name: string; amount: number }[];
  budgetsCount: number;
  goalsCount: number;
}

export interface AIService {
  sendMessage(
    prompt: string,
    context: AIServiceContext,
    userMessageId?: string,
    history?: AdviceHistoryItem[],
  ): Promise<AIResponsePayload>;
}

export type AdviceHistoryItem = { role: 'user' | 'assistant'; text: string };

export interface AIQuotaStatus {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: string;
}

export const ADVICE_CLOCK = {
  now: () => new Date(),
  timeZone: 'Asia/Ho_Chi_Minh',
} as const;

function pickStrings(language: 'vi' | 'en') {
  return language === 'en' ? en : vi;
}

export function isDevRuntime(): boolean {
  return typeof __DEV__ !== 'undefined' && Boolean(__DEV__);
}

/**
 * Parses a raw `/v1/quota` JSON payload into a validated AIQuotaStatus object.
 * Supports both `{ data: { allowed, remaining, limit, resetAt } }` and flat objects.
 */
export function parseAIQuotaResponse(raw: unknown): AIQuotaStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const candidate =
    record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : record;
  const { allowed, remaining, limit, resetAt } = candidate;
  if (
    typeof allowed !== 'boolean' ||
    typeof remaining !== 'number' ||
    !Number.isFinite(remaining) ||
    remaining < 0 ||
    typeof limit !== 'number' ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    typeof resetAt !== 'string' ||
    !resetAt.trim()
  ) {
    return null;
  }
  return {
    allowed,
    remaining: Math.trunc(remaining),
    limit: Math.trunc(limit),
    resetAt: resetAt.trim(),
  };
}

/**
 * Returns true only when quota has a finite daily limit below Number.MAX_SAFE_INTEGER
 * (hides the counter when the proxy is running in unlimitedAiTesting mode).
 */
export function shouldShowAIQuotaBadge(
  quota: AIQuotaStatus | null | undefined,
): quota is AIQuotaStatus {
  return Boolean(
    quota &&
      Number.isFinite(quota.limit) &&
      quota.limit > 0 &&
      quota.limit < Number.MAX_SAFE_INTEGER,
  );
}

/**
 * Formats a quota reset ISO timestamp into Asia/Ho_Chi_Minh local time.
 */
export function formatQuotaResetTimeVietnam(
  resetAtInput: string | null | undefined,
  language: 'vi' | 'en',
  now: Date = ADVICE_CLOCK.now(),
): string {
  const strings = pickStrings(language);
  const isoMatch = resetAtInput?.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?/,
  );
  const parsed = isoMatch ? new Date(isoMatch[0]) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return strings.aiQuotaResetTomorrow.replace('{time}', '00:00');
  }

  const timeParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(parsed);
  const rawHour =
    timeParts.find((part) => part.type === 'hour')?.value ?? '00';
  const hour = rawHour === '24' ? '00' : rawHour;
  const minute =
    timeParts.find((part) => part.type === 'minute')?.value ?? '00';
  const timeStr = `${hour}:${minute}`;

  const resetDateKey = today({
    now: () => parsed,
    timeZone: 'Asia/Ho_Chi_Minh',
  });
  const currentVnDateKey = today({
    now: () => now,
    timeZone: 'Asia/Ho_Chi_Minh',
  });
  const [y, m, d] = currentVnDateKey.split('-').map(Number);
  const tomorrowKey = new Date(Date.UTC(y, m - 1, d + 1))
    .toISOString()
    .slice(0, 10);

  if (resetDateKey === tomorrowKey) {
    return strings.aiQuotaResetTomorrow.replace('{time}', timeStr);
  }
  const [, resetMonth, resetDay] = resetDateKey.split('-');
  const dateLabel = `${Number(resetDay)}/${Number(resetMonth)}`;
  return strings.aiQuotaResetOnDate
    .replace('{time}', timeStr)
    .replace('{date}', dateLabel);
}

/**
 * Formats the quota banner text for the Chat screen when the limit is finite.
 */
export function formatAIQuotaBanner(
  quota: AIQuotaStatus | null | undefined,
  language: 'vi' | 'en',
  now: Date = ADVICE_CLOCK.now(),
): string | null {
  if (!shouldShowAIQuotaBadge(quota)) return null;
  const strings = pickStrings(language);
  if (quota.remaining <= 0 || !quota.allowed) {
    const resetTime = formatQuotaResetTimeVietnam(quota.resetAt, language, now);
    return strings.aiQuotaExhaustedBanner
      .replace(/\{limit\}/g, String(quota.limit))
      .replace('{resetTime}', resetTime);
  }
  return strings.aiQuotaRemaining
    .replace('{remaining}', String(quota.remaining))
    .replace('{limit}', String(quota.limit));
}

/**
 * Queries `GET /v1/quota` for the current device. Returns null if offline,
 * non-HTTPS in production, or when the proxy is unreachable.
 */
export async function fetchAIQuota(options?: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<AIQuotaStatus | null> {
  const baseUrl = options?.baseUrl ?? getProxyBaseUrl();
  if (!baseUrl || (!isDevRuntime() && !baseUrl.startsWith('https://'))) {
    return null;
  }
  const fetchFn = options?.fetchImpl ?? fetch;
  try {
    const deviceId = await getOrCreateDeviceId();
    const response = await fetchFn(`${baseUrl}/v1/quota`, {
      method: 'GET',
      headers: {
        'x-device-id': deviceId,
        'ngrok-skip-browser-warning': 'true',
      },
    });
    if (!response.ok) return null;
    const json = await response.json();
    return parseAIQuotaResponse(json);
  } catch (error) {
    if (isDevRuntime()) {
      console.warn('Quota request failed at', baseUrl, error);
    }
    return null;
  }
}

/**
 * Append the reference-only disclaimer to advice text. It runs on the device
 * after verification, so the wording is never model-generated or unverified.
 */
export function applyAdviceDisclaimer(
  payload: AIResponsePayload,
  prompt: string,
): AIResponsePayload {
  const { language } = usePreferences.getState();
  const strings = pickStrings(language);
  if (payload.replyText.includes(strings.aiAdviceDisclaimer)) return payload;
  const scope = classifyAdviceScope(prompt);
  const needsProfessional =
    scope.topic === 'loan_estimate' || scope.topic === 'purchase_affordability';
  const suffix = needsProfessional
    ? `${strings.aiAdviceDisclaimer} ${strings.aiAdviceBigDecision}`
    : strings.aiAdviceDisclaimer;
  return { ...payload, replyText: `${payload.replyText}\n\n${suffix}` };
}

/**
 * Answer a pure numeric question from local SQLite data. Returns null when the
 * turn still needs the advice model (scenario, or a period we must ask about).
 */
export async function tryFactualAdvice(input: {
  prompt: string;
  history: AdviceHistoryItem[];
  userMessageId: string;
}): Promise<AIResponsePayload | null> {
  const { language, currency, exchangeRate } = usePreferences.getState();
  const query = parseAdviceQuery(input.prompt, input.history, ADVICE_CLOCK);
  if (query.kind === 'advice') return null;

  const strings = pickStrings(language);
  if (!query.range || query.needsClarification) {
    return {
      id: `ai-${input.userMessageId}`,
      userMessageId: input.userMessageId,
      replyText: strings.aiFactPeriodQuestion,
      createdAt: new Date().toISOString(),
    };
  }
  if (currency === 'USD' && exchangeRate === null) {
    return {
      id: `ai-${input.userMessageId}`,
      userMessageId: input.userMessageId,
      replyText: strings.aiExchangeRateUnavailable,
      createdAt: new Date().toISOString(),
    };
  }

  const range: AdviceDateRange = query.range;
  const data: AdviceFactData = await withDatabase(async (db) => {
    if (query.kind === 'expense_by_category') {
      const expenses = await readExpenseByCategory(db, range.from, range.to);
      return {
        kind: 'expense_by_category',
        totalExpense: expenses.totalExpense,
        topCategories: expenses.topCategories,
        otherAmount: expenses.otherAmount,
        uncategorizedAmount: expenses.uncategorizedAmount,
        transactionCount: expenses.transactionCount,
      };
    }
    const flow = await readCashFlow(db, range.from, range.to);
    return {
      kind: 'cash_flow',
      totalIncome: flow.totalIncome,
      totalExpense: flow.totalExpense,
      net: flow.net,
      incomeCount: flow.incomeCount,
      expenseCount: flow.expenseCount,
    };
  });

  const payload = buildFactualAdviceReply({
    kind: query.kind,
    range,
    data,
    labels: factsLabels(language, strings),
    language,
    currency,
    exchangeRate,
    userMessageId: input.userMessageId,
    clock: ADVICE_CLOCK,
  });
  return payload;
}

const RANGE_PHRASE_PATTERNS = [
  /\b(nh\u1eefng|m\u1ea5y|v\u00e0i|m\u1ecdi)\s*ng\u00e0y\s*(qua|nay|g\u1ea7n \u0111\u00e2y)\b/iu,
  /\b(g\u1ea7n \u0111\u00e2y)\b/iu,
  /\b(7|30)\s*ng\u00e0y\b/iu,
  /\btu\u1ea7n (n\u00e0y|tr\u01b0\u1edbc|qua|r\u1ed3i)\b/iu,
  /\bth\u00e1ng (n\u00e0y|tr\u01b0\u1edbc|qua|r\u1ed3i)\b/iu,
  /\bh\u00f4m (nay|qua)\b/iu,
  /\b(last|past)\s+(7|30)\s*days?\b/i,
  /\b(this|last)\s+(week|month)\b/i,
  /\b(today|yesterday)\b/i,
];

function extractRangePhrase(question: string): string | null {
  for (const pattern of RANGE_PHRASE_PATTERNS) {
    const match = question.match(pattern);
    if (match?.[0]) return match[0].trim();
  }
  return null;
}

export function buildAdviceHistory(
  prompt: string,
  previous: { id: string; text: string }[],
  replies: Record<string, AIResponsePayload>,
): AdviceHistoryItem[] {
  const scope = classifyAdviceScope(prompt);
  const foldedPrompt = foldSearchText(prompt);
  const refersBack =
    /^(vay|the|neu|con|nhu vay|gia su|truong hop|what if|then|if|how about|in that case)\b/.test(
      foldedPrompt,
    );
  // Only an open numeric topic continues a data chain; a fresh advice question
  // that merely mentions a period must not inherit an unrelated history.
  const currentQuery = parseAdviceQuery(prompt, [], ADVICE_CLOCK);
  const barePeriodFollowup =
    currentQuery.kind === 'advice' &&
    currentQuery.range !== null &&
    /^(thang|tuan|hom|this|last|today|yesterday)\b/.test(foldedPrompt) &&
    scope.status === 'ambiguous';
  const continuesFact =
    currentQuery.kind === 'advice' &&
    (currentQuery.range !== null || currentQuery.category !== null) &&
    findPreviousFactQuery(
      prompt,
      previous.map((row) => ({ role: 'user' as const, text: row.text })),
      ADVICE_CLOCK,
    ) !== null;
  if (
    (scope.status !== 'ambiguous' && !refersBack && !continuesFact) ||
    !previous.length
  )
    return [];

  const chain: AdviceHistoryItem[][] = [];
  for (const row of previous.slice(0, 4)) {
    const replyText = replies[row.id]?.replyText ?? '';
    // A numeric turn answers with data instead of a question, so keep its
    // subject and period rather than dropping the topic.
    const factQuery = parseAdviceQuery(row.text, [], ADVICE_CLOCK);
    if (factQuery.kind !== 'advice') {
      const rangePhrase =
        extractRangePhrase(row.text) ??
        (factQuery.range
          ? `${factQuery.range.from}..${factQuery.range.to}`
          : '');
      const strings = pickStrings(usePreferences.getState().language);
      const context = [
        row.text,
        rangePhrase
          ? strings.aiHistoryAskedRange.replace('{range}', rangePhrase)
          : '',
        replyText
          ? strings.aiHistoryAnsweredData.replace('{reply}', replyText)
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      chain.unshift([
        { role: 'user', text: row.text },
        { role: 'assistant', text: context.slice(0, 500) },
      ]);
      continue;
    }

    const question = replyText
      .match(/[^?\n]*\?/g)
      ?.at(-1)
      ?.trim();
    if (
      !question &&
      !(
        barePeriodFollowup &&
        classifyAdviceScope(row.text).status === 'allowed' &&
        replyText
      )
    )
      break;
    chain.unshift([
      { role: 'user', text: row.text },
      { role: 'assistant', text: (question ?? replyText).slice(0, 500) },
    ]);
    // A bare period modifies the nearest advice topic, not older unrelated topics.
    if (barePeriodFollowup) break;
  }
  return chain.flat();
}

const CHART_PALETTE = [
  '#7C5CFF',
  '#FF7AD9',
  '#16A34A',
  '#0EA5E9',
  '#F59E0B',
] as const;

export function mapTopicToIntent(
  topic: AdviceTopic | null | undefined,
): Intent {
  switch (topic) {
    case 'purchase_affordability':
      return 'purchase_affordability';
    case 'loan_estimate':
      return 'loan_estimate';
    case 'savings_plan':
      return 'savings_plan';
    case 'budget_review':
      return 'budget_review';
    case 'spending_overview':
      return 'spending_overview';
    case 'general':
    default:
      return 'general';
  }
}

export function getProxyBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_PROXY_URL?.trim();
  if (!isDevRuntime()) {
    return configured && configured.startsWith('https://') ? configured : '';
  }
  if (configured) {
    return configured;
  }
  if (typeof window !== 'undefined' && window.location?.hostname) {
    return `http://${window.location.hostname}:3000`;
  }
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const ip = hostUri.split(':')[0];
    if (ip) {
      return `http://${ip}:3000`;
    }
  }
  return 'http://192.168.137.1:3000';
}

export function buildCategoryChartItems(
  topCategories: { name: string; amount: number }[],
): { items: AIChartItem[]; isSample: boolean } {
  const valid = topCategories.filter(
    (item) => Number.isInteger(item.amount) && item.amount > 0,
  );
  const total = valid.reduce((sum, item) => sum + item.amount, 0);

  if (total > 0 && valid.length > 0) {
    const sliced = valid.slice(0, 5);
    const sliceTotal = sliced.reduce((sum, item) => sum + item.amount, 0);
    const items = sliced.map((item, index) => ({
      category: displayCategoryName(item.name),
      percentage: Math.max(1, Math.round((item.amount * 100) / sliceTotal)),
      amount: item.amount,
      color: CHART_PALETTE[index % CHART_PALETTE.length],
    }));
    return { items, isSample: false };
  }

  const strings = pickStrings(usePreferences.getState().language);
  return {
    isSample: true,
    items: [
      {
        category: displayCategoryName('Ăn uống'),
        percentage: 38,
        amount: 3_800_000,
        color: CHART_PALETTE[0],
      },
      {
        category: strings.aiSampleCategoryHousing,
        percentage: 27,
        amount: 2_700_000,
        color: CHART_PALETTE[1],
      },
      {
        category: displayCategoryName('Di chuyển'),
        percentage: 15,
        amount: 1_500_000,
        color: CHART_PALETTE[2],
      },
      {
        category: displayCategoryName('Mua sắm'),
        percentage: 12,
        amount: 1_200_000,
        color: CHART_PALETTE[3],
      },
      {
        category: strings.aiSampleCategorySavings,
        percentage: 8,
        amount: 800_000,
        color: CHART_PALETTE[4],
      },
    ],
  };
}

export class MockAIService implements AIService {
  private readonly delayMs: number;

  constructor(options?: { delayMs?: number }) {
    this.delayMs = options?.delayMs ?? 550;
  }

  async sendMessage(
    prompt: string,
    context: AIServiceContext,
    userMessageId = `msg-${Date.now()}`,
    history: AdviceHistoryItem[] = [],
  ): Promise<AIResponsePayload> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.delayMs);
      });
    }

    const { language } = usePreferences.getState();
    const strings = pickStrings(language);
    const normalized = foldSearchText(prompt);
    const { items: chartItems, isSample } = buildCategoryChartItems(
      context.topCategories,
    );
    const createdAt = new Date().toISOString();
    const id = `ai-${userMessageId}`;

    const budgetSetupReply = await tryAIBudgetSetup({
      prompt,
      userMessageId,
    });
    if (budgetSetupReply) return budgetSetupReply;

    const scopeDecision = classifyAdviceScope(
      history
        .filter((item) => item.role === 'user')
        .map((item) => item.text)
        .join(' ') +
        ' ' +
        prompt,
    );
    if (scopeDecision.status === 'out_of_scope') {
      return {
        id,
        userMessageId,
        replyText: strings.aiReplyOutOfScope,
        createdAt,
      };
    }
    if (scopeDecision.status === 'restricted') {
      return {
        id,
        userMessageId,
        replyText: strings.aiReplyRestricted,
        createdAt,
      };
    }
    if (scopeDecision.status === 'ambiguous') {
      return {
        id,
        userMessageId,
        replyText: strings.aiReplyAmbiguous,
        createdAt,
      };
    }

    if (language === 'en') {
      const hasData = context.monthlyIncome > 0 || context.monthlyExpense > 0;
      return {
        id,
        userMessageId,
        replyText: hasData
          ? strings.aiMockSummaryWithData
              .replace('{income}', formatVnd(context.monthlyIncome))
              .replace('{expense}', formatVnd(context.monthlyExpense))
              .replace('{balance}', formatVnd(context.balance))
          : strings.aiMockInsufficientData,
        createdAt,
      };
    }

    if (context.monthlyIncome <= 0 && context.monthlyExpense <= 0) {
      return {
        id,
        userMessageId,
        replyText: strings.aiMockInsufficientData,
        createdAt,
      };
    }

    if (
      normalized.includes('budget') ||
      normalized.includes('ngan sach') ||
      normalized.includes('50/30/20')
    ) {
      if (context.monthlyIncome <= 0) {
        return {
          id,
          userMessageId,
          replyText: strings.aiMockNeedIncomeForBudget,
          createdAt,
        };
      }
      const incomeRef = context.monthlyIncome;
      const essentials = Math.round(incomeRef * 0.5);
      const lifestyle = Math.round(incomeRef * 0.3);
      const savings = incomeRef - essentials - lifestyle;

      const budgetChart: AIChartItem[] = [
        {
          category: strings.aiMockBudgetNeedsLabel,
          percentage: 50,
          amount: essentials,
          color: CHART_PALETTE[0],
        },
        {
          category: strings.aiMockBudgetWantsLabel,
          percentage: 30,
          amount: lifestyle,
          color: CHART_PALETTE[1],
        },
        {
          category: strings.aiMockBudgetSavingsLabel,
          percentage: 20,
          amount: savings,
          color: CHART_PALETTE[2],
        },
      ];

      return {
        id,
        userMessageId,
        replyText: strings.aiMockBudget503020Reply
          .replace('{income}', formatVnd(incomeRef))
          .replace('{essentials}', formatVnd(essentials))
          .replace('{lifestyle}', formatVnd(lifestyle))
          .replace('{savings}', formatVnd(savings)),
        chartTitle: strings.aiMockBudget503020Title,
        chartItems: budgetChart,
        createdAt,
      };
    }

    if (
      normalized.includes('goal') ||
      normalized.includes('muc tieu') ||
      normalized.includes('tiet kiem')
    ) {
      const savingsRate =
        context.monthlyIncome > 0
          ? Math.max(
              0,
              Math.min(
                100,
                Math.round((context.monthlyNet * 100) / context.monthlyIncome),
              ),
            )
          : 20;

      return {
        id,
        userMessageId,
        replyText: strings.aiMockGoalReply
          .replace('{balance}', formatVnd(context.balance))
          .replace('{net}', formatVnd(context.monthlyNet))
          .replace('{savingsRate}', String(savingsRate))
          .replace('{goalsCount}', String(context.goalsCount))
          .replace('{budgetsCount}', String(context.budgetsCount)),
        chartTitle: isSample
          ? strings.aiMockGoalSampleChartTitle
          : strings.aiMockGoalActualChartTitle,
        chartItems,
        createdAt,
      };
    }

    const summaryPrefix =
      context.monthlyExpense > 0
        ? strings.aiMockSpendingReplyWithExpense
            .replace('{income}', formatVnd(context.monthlyIncome))
            .replace('{expense}', formatVnd(context.monthlyExpense))
            .replace('{net}', formatVnd(context.monthlyNet))
        : strings.aiMockSpendingReplyNoExpense.replace(
            '{balance}',
            formatVnd(context.balance),
          );

    return {
      id,
      userMessageId,
      replyText: summaryPrefix,
      chartTitle: isSample
        ? strings.aiMockSpendingSampleChartTitle
        : strings.aiMockSpendingActualChartTitle,
      chartItems,
      createdAt,
    };
  }
}

function formatRemoteErrorReply(
  data: {
    code?: string;
    message?: string;
    resetAt?: string;
    fallbackTemplate?: string;
  },
  language: 'vi' | 'en',
): string {
  const strings = pickStrings(language);
  if (data.code === 'QUOTA_EXCEEDED_DEVICE') {
    const resetTime = formatQuotaResetTimeVietnam(
      data.resetAt ?? data.message,
      language,
    );
    const base = strings.aiQuotaExceededReply.replace('{resetTime}', resetTime);
    return data.fallbackTemplate ? `${base}\n\n${data.fallbackTemplate}` : base;
  }
  if (data.code === 'RATE_LIMIT_EXCEEDED') {
    return strings.aiRateLimitExceededReply;
  }
  if (data.fallbackTemplate) {
    return `${strings.aiServerErrorReply}\n\n${data.fallbackTemplate}`;
  }
  return strings.aiServerErrorReply;
}

export class RemoteAIService implements AIService {
  private readonly customBaseUrl?: string;
  private readonly fallbackService: AIService;

  constructor(options?: { baseUrl?: string; fallbackService?: AIService }) {
    this.customBaseUrl = options?.baseUrl;
    this.fallbackService =
      options?.fallbackService ?? new MockAIService({ delayMs: 250 });
  }

  private resolveBaseUrl(): string {
    return this.customBaseUrl ?? getProxyBaseUrl();
  }

  async sendMessage(
    prompt: string,
    context: AIServiceContext,
    userMessageId = `msg-${Date.now()}`,
    history: AdviceHistoryItem[] = [],
  ): Promise<AIResponsePayload> {
    const createdAt = new Date().toISOString();
    const id = `ai-${userMessageId}`;
    const { language, currency, exchangeRate } = usePreferences.getState();
    const strings = pickStrings(language);

    const budgetSetupReply = await tryAIBudgetSetup({
      prompt,
      userMessageId,
    });
    if (budgetSetupReply) return budgetSetupReply;

    const currentScope = classifyAdviceScope(prompt);
    const scopeDecision =
      currentScope.status === 'ambiguous' && history.length
        ? classifyAdviceScope(
            (history
              .filter((item) => item.role === 'user')
              .map((item) => item.text)
              .reverse()
              .find((text) => classifyAdviceScope(text).status === 'allowed') ??
              '') +
              ' ' +
              prompt,
          )
        : currentScope;
    if (scopeDecision.status === 'out_of_scope') {
      return {
        id,
        userMessageId,
        replyText: strings.aiReplyOutOfScope,
        createdAt,
      };
    }
    if (scopeDecision.status === 'restricted') {
      return {
        id,
        userMessageId,
        replyText: strings.aiReplyRestricted,
        createdAt,
      };
    }
    // Numeric questions are answered from local data and never reach the proxy,
    // so they stay free of AI quota. They are resolved before the ambiguous
    // fallback because the advice classifier does not model fact questions.
    const factualReply = await tryFactualAdvice({
      prompt,
      history,
      userMessageId,
    });
    if (factualReply) return factualReply;

    if (scopeDecision.status === 'ambiguous') {
      return {
        id,
        userMessageId,
        replyText: strings.aiReplyAmbiguous,
        createdAt,
      };
    }

    const baseUrl = this.resolveBaseUrl();
    try {
      if (currency === 'USD' && exchangeRate === null)
        return {
          id,
          userMessageId,
          replyText: strings.aiExchangeRateUnavailable,
          createdAt,
        };
      if (!baseUrl || (!isDevRuntime() && !baseUrl.startsWith('https://'))) {
        throw new Error('HTTPS_REQUIRED');
      }
      const deviceId = await getOrCreateDeviceId();
      const requestId = Crypto.randomUUID();
      const headers = {
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
        'ngrok-skip-browser-warning': 'true',
      };
      let requestQuestion = prompt;
      let requestHistory = history;
      let planResponse = await fetch(`${baseUrl}/v1/advice/plan`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          requestId,
          question: requestQuestion,
          language,
          currency,
          supportsRiskContext: true,
          ...(requestHistory.length ? { history: requestHistory } : {}),
        }),
      });
      let planData = await planResponse.json();
      if (
        requestHistory.length &&
        planResponse.status === 400 &&
        planData.code === 'BAD_REQUEST' &&
        planData.errors?.some(
          (issue: { path: string; message: string }) =>
            issue.path === '' && issue.message.includes('history'),
        )
      ) {
        const legacyQuestion = [
          ...requestHistory.map((item) =>
            item.role === 'assistant' ? `AI hỏi: ${item.text}` : item.text,
          ),
          `Trả lời: ${prompt}`,
        ].join('\n');
        if (legacyQuestion.length <= 500) {
          requestQuestion = legacyQuestion;
          requestHistory = [];
          planResponse = await fetch(`${baseUrl}/v1/advice/plan`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              requestId,
              question: requestQuestion,
              language,
              currency,
            }),
          });
          planData = await planResponse.json();
        }
      }
      if (!planResponse.ok || !planData.success)
        return {
          id,
          userMessageId,
          replyText: formatRemoteErrorReply(planData, language),
          createdAt,
        };
      const plan = AdvicePlanResponseSchema.parse(planData);
      const currentDate = today({
        now: () => new Date(),
        timeZone: 'Asia/Ho_Chi_Minh',
      });
      const summary = await withDatabase((db) =>
        readAnalysisSummary(db, currentDate),
      );
      const response = await fetch(`${baseUrl}/v1/advice/complete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          requestId,
          question: requestQuestion,
          language,
          currency,
          ...(requestHistory.length ? { history: requestHistory } : {}),
          planToken: plan.planToken,
          ...(plan.selection.groups?.length
            ? {
                dataGroups: await withDatabase((db) =>
                  readAdviceGroups(db, plan.selection, {
                    fallbackCategoryLabel: strings.aiOtherCategoryLabel,
                    riskContext: {
                      monthsWithData: summary.window.monthsWithData,
                      riskFlags: summary.riskFlags,
                      dataQuality: summary.dataQuality,
                    },
                  }),
                ),
              }
            : {}),
          results: computeAdviceMetrics(
            summary,
            plan.selection,
            currency,
            exchangeRate,
          ),
        }),
      });

      const data = (await response.json()) as {
        success: boolean;
        requestId?: string;
        answer?: string;
        code?: string;
        message?: string;
        resetAt?: string;
        fallbackTemplate?: string;
      };

      if (response.ok && data.success && data.answer) {
        return applyAdviceDisclaimer(
          {
            id: data.requestId || id,
            userMessageId,
            replyText: data.answer,
            createdAt,
          },
          prompt,
        );
      }

      if (!data.success || !response.ok) {
        return {
          id,
          userMessageId,
          replyText: formatRemoteErrorReply(data, language),
          createdAt,
        };
      }

      // proxy error handled
      return await this.fallbackService.sendMessage(
        prompt,
        context,
        userMessageId,
        history,
      );
    } catch (networkError) {
      if (isDevRuntime()) {
        console.warn('Proxy request failed at', baseUrl, networkError);
      }
      const fallbackPayload = await this.fallbackService.sendMessage(
        prompt,
        context,
        userMessageId,
        history,
      );
      const activeStrings = pickStrings(usePreferences.getState().language);
      return applyAdviceDisclaimer(
        {
          ...fallbackPayload,
          replyText: `${activeStrings.aiOfflineFallbackPrefix}\n\n${fallbackPayload.replyText}`,
        },
        prompt,
      );
    }
  }
}

export const defaultAIService: AIService = new RemoteAIService();

export async function readAIServiceContext(): Promise<AIServiceContext> {
  const currentMonth = monthKey(
    today({ now: () => new Date(), timeZone: 'Asia/Ho_Chi_Minh' }),
  );
  const fallbackName = pickStrings(
    usePreferences.getState().language,
  ).recurringUncategorized;
  return withDatabase(async (db) => {
    const dashboard = await readDashboard(db, currentMonth);
    return {
      balance: dashboard.balance,
      monthlyIncome: dashboard.current.income,
      monthlyExpense: dashboard.current.expense,
      monthlyNet: dashboard.current.net,
      topCategories: dashboard.topCategories.map((row) => ({
        name: row.name ?? fallbackName,
        amount: row.amount,
      })),
      budgetsCount: dashboard.budgets.length,
      goalsCount: dashboard.goals.length,
    };
  });
}

export async function loadPersistedAIReplyMap(
  db: Queries,
): Promise<Record<string, AIResponsePayload>> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    AI_REPLIES_SETTING_KEY,
  );
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as Record<string, AIResponsePayload>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function savePersistedAIReply(
  db: Queries,
  payload: AIResponsePayload,
): Promise<void> {
  const existing = await loadPersistedAIReplyMap(db);
  existing[payload.userMessageId] = payload;
  const keys = Object.keys(existing);
  if (keys.length > 60) {
    for (const oldKey of keys.slice(0, keys.length - 60)) {
      delete existing[oldKey];
    }
  }
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    AI_REPLIES_SETTING_KEY,
    JSON.stringify(existing),
  );
}

export async function savePersistedAIReplyIfMessageExists(
  db: Database,
  payload: AIResponsePayload,
): Promise<boolean> {
  let saved = false;
  await db.transaction(async (tx) => {
    const row = await tx.getFirstAsync<{ id: string }>(
      'SELECT id FROM chat_messages WHERE id = ?',
      payload.userMessageId,
    );
    if (!row) return;
    await savePersistedAIReply(tx, payload);
    saved = true;
  });
  return saved;
}
