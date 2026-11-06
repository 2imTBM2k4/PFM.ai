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

export const ADVICE_CLOCK = {
  now: () => new Date(),
  timeZone: 'Asia/Ho_Chi_Minh',
} as const;

function pickStrings(language: 'vi' | 'en') {
  return language === 'en' ? en : vi;
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
      replyText:
        language === 'en'
          ? 'The USD/VND exchange rate is unavailable. Refresh it in Settings and try again.'
          : 'Chưa có tỷ giá USD/VND. Hãy tải lại tỷ giá trong Cài đặt rồi thử lại.',
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
      const context = [
        row.text,
        rangePhrase ? `Khoảng thời gian đã hỏi: ${rangePhrase}.` : '',
        replyText ? `Số liệu đã trả lời: ${replyText}` : '',
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
  if (process.env.EXPO_PUBLIC_PROXY_URL) {
    return process.env.EXPO_PUBLIC_PROXY_URL;
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
        category:
          usePreferences.getState().language === 'en'
            ? 'Housing and bills'
            : 'Nhà ở & Hóa đơn',
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
        category:
          usePreferences.getState().language === 'en' ? 'Savings' : 'Tiết kiệm',
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

    const normalized = foldSearchText(prompt);
    const { items: chartItems, isSample } = buildCategoryChartItems(
      context.topCategories,
    );
    const createdAt = new Date().toISOString();
    const id = `ai-${userMessageId}`;

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
        replyText: vi.aiReplyOutOfScope,
        createdAt,
      };
    }
    if (scopeDecision.status === 'restricted') {
      return {
        id,
        userMessageId,
        replyText: vi.aiReplyRestricted,
        createdAt,
      };
    }
    if (scopeDecision.status === 'ambiguous') {
      return {
        id,
        userMessageId,
        replyText: vi.aiReplyAmbiguous,
        createdAt,
      };
    }

    if (usePreferences.getState().language === 'en') {
      const hasData = context.monthlyIncome > 0 || context.monthlyExpense > 0;
      return {
        id,
        userMessageId,
        replyText: hasData
          ? `This month you received ${formatVnd(context.monthlyIncome)} and spent ${formatVnd(context.monthlyExpense)}. Your current wallet balance is ${formatVnd(context.balance)}. What amount or timeframe would you like to plan around?`
          : 'I do not have enough transaction data yet. What is your monthly income, typical spending, and the amount or timeframe you want to plan for?',
        createdAt,
      };
    }

    if (context.monthlyIncome <= 0 && context.monthlyExpense <= 0) {
      return {
        id,
        userMessageId,
        replyText:
          'Mình chưa có đủ dữ liệu thu chi. Bạn cho biết thu nhập và chi tiêu trung bình mỗi tháng, cùng số tiền hoặc thời hạn muốn lên kế hoạch nhé.',
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
          replyText:
            'Mình cần biết thu nhập trung bình mỗi tháng để gợi ý mức ngân sách phù hợp.',
          createdAt,
        };
      }
      const incomeRef = context.monthlyIncome;
      const essentials = Math.round(incomeRef * 0.5);
      const lifestyle = Math.round(incomeRef * 0.3);
      const savings = incomeRef - essentials - lifestyle;

      const budgetChart: AIChartItem[] = [
        {
          category: 'Thiết yếu (50%)',
          percentage: 50,
          amount: essentials,
          color: CHART_PALETTE[0],
        },
        {
          category: 'Cá nhân (30%)',
          percentage: 30,
          amount: lifestyle,
          color: CHART_PALETTE[1],
        },
        {
          category: 'Tích lũy (20%)',
          percentage: 20,
          amount: savings,
          color: CHART_PALETTE[2],
        },
      ];

      return {
        id,
        userMessageId,
        replyText: `Với thu nhập tham chiếu ${formatVnd(incomeRef)}, bạn có thể phân bổ ngân sách theo quy tắc 50/30/20: ${formatVnd(essentials)} cho chi phí thiết yếu, ${formatVnd(lifestyle)} cho nhu cầu cá nhân và dành ${formatVnd(savings)} tích lũy.`,
        chartTitle: 'Kế hoạch Ngân sách 50 / 30 / 20 (%)',
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
        replyText: `Số dư khả dụng hiện tại của bạn là ${formatVnd(context.balance)}. Tháng này chênh lệch thu trừ chi đạt ${formatVnd(context.monthlyNet)} (tỷ lệ tích lũy ~${savingsRate}%). Bạn đang theo dõi ${context.goalsCount} mục tiêu tiết kiệm và ${context.budgetsCount} ngân sách.`,
        chartTitle: isSample
          ? 'Cơ cấu chi tiêu mẫu để tối ưu mục tiêu (%)'
          : 'Tỷ trọng chi tiêu hiện tại theo danh mục (%)',
        chartItems,
        createdAt,
      };
    }

    const summaryPrefix =
      context.monthlyExpense > 0
        ? `Trong tháng này, tổng thu của bạn là ${formatVnd(context.monthlyIncome)} và tổng chi là ${formatVnd(context.monthlyExpense)} (còn lại ${formatVnd(context.monthlyNet)}). Dưới đây là biểu đồ phân bổ phần trăm các danh mục chi tiêu lớn nhất:`
        : `Số dư hiện tại của bạn là ${formatVnd(context.balance)}. Tháng này bạn chưa phát sinh khoản chi nào nên dưới đây là biểu đồ tỷ trọng chi tiêu mẫu để bạn tham khảo:`;

    return {
      id,
      userMessageId,
      replyText: summaryPrefix,
      chartTitle: isSample
        ? 'Phân bổ chi tiêu tham khảo theo danh mục (%)'
        : 'Phân bổ chi tiêu thực tế theo danh mục (%)',
      chartItems,
      createdAt,
    };
  }
}

export class RemoteAIService implements AIService {
  private readonly baseUrl: string;
  private readonly fallbackService: AIService;

  constructor(options?: { baseUrl?: string; fallbackService?: AIService }) {
    this.baseUrl = options?.baseUrl ?? getProxyBaseUrl();
    this.fallbackService =
      options?.fallbackService ?? new MockAIService({ delayMs: 250 });
  }

  async sendMessage(
    prompt: string,
    context: AIServiceContext,
    userMessageId = `msg-${Date.now()}`,
    history: AdviceHistoryItem[] = [],
  ): Promise<AIResponsePayload> {
    const createdAt = new Date().toISOString();
    const id = `ai-${userMessageId}`;

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
        replyText: vi.aiReplyOutOfScope,
        createdAt,
      };
    }
    if (scopeDecision.status === 'restricted') {
      return {
        id,
        userMessageId,
        replyText: vi.aiReplyRestricted,
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
        replyText: vi.aiReplyAmbiguous,
        createdAt,
      };
    }

    try {
      const { language, currency, exchangeRate } = usePreferences.getState();
      if (currency === 'USD' && exchangeRate === null)
        return {
          id,
          userMessageId,
          replyText:
            language === 'en'
              ? 'The USD/VND exchange rate is unavailable. Refresh it in Settings and try again.'
              : 'Chưa có tỷ giá USD/VND. Hãy tải lại tỷ giá trong Cài đặt rồi thử lại.',
          createdAt,
        };
      const deviceId = await getOrCreateDeviceId();
      const requestId = Crypto.randomUUID();
      const headers = {
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
        'ngrok-skip-browser-warning': 'true',
      };
      let requestQuestion = prompt;
      let requestHistory = history;
      let planResponse = await fetch(`${this.baseUrl}/v1/advice/plan`, {
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
          planResponse = await fetch(`${this.baseUrl}/v1/advice/plan`, {
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
          replyText:
            language === 'en'
              ? 'Could not prepare advice right now. Please try again.'
              : (planData.message ?? vi.chatLoadError),
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
      const response = await fetch(`${this.baseUrl}/v1/advice/complete`, {
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
                    fallbackCategoryLabel:
                      language === 'en' ? 'Other category' : 'Danh mục khác',
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

      if (!data.success) {
        if (data.code === 'QUOTA_EXCEEDED_DEVICE') {
          const combined =
            language === 'en'
              ? 'Daily AI limit reached.'
              : data.fallbackTemplate
                ? `${data.message ?? ''}\n\n${data.fallbackTemplate}`
                : (data.message ?? vi.chatLoadError);
          return {
            id,
            userMessageId,
            replyText: combined,
            createdAt,
          };
        }

        if (data.code === 'RATE_LIMIT_EXCEEDED') {
          return {
            id,
            userMessageId,
            replyText:
              language === 'en'
                ? 'You are asking too quickly. Wait a moment and try again.'
                : 'Bạn đang gửi câu hỏi quá nhanh. Vui lòng đợi một lát rồi thử lại.',
            createdAt,
          };
        }

        if (data.fallbackTemplate) {
          return {
            id,
            userMessageId,
            replyText:
              language === 'en'
                ? 'Could not get advice right now. Please try again.'
                : data.fallbackTemplate,
            createdAt,
          };
        }
        if (data.message)
          return {
            id,
            userMessageId,
            replyText:
              language === 'en'
                ? 'Could not get advice right now. Please try again.'
                : data.message,
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
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn('Proxy request failed at', this.baseUrl, networkError);
      }
      const fallbackPayload = await this.fallbackService.sendMessage(
        prompt,
        context,
        userMessageId,
        history,
      );
      return applyAdviceDisclaimer(
        {
          ...fallbackPayload,
          replyText: `${usePreferences.getState().language === 'en' ? `[Could not reach the AI server at ${this.baseUrl}; showing on-device guidance]` : `[Không thể kết nối máy chủ AI tại ${this.baseUrl} - đang hiển thị phân tích dữ liệu trên máy]`}\n\n${fallbackPayload.replyText}`,
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
  return withDatabase(async (db) => {
    const dashboard = await readDashboard(db, currentMonth);
    return {
      balance: dashboard.balance,
      monthlyIncome: dashboard.current.income,
      monthlyExpense: dashboard.current.expense,
      monthlyNet: dashboard.current.net,
      topCategories: dashboard.topCategories.map((row) => ({
        name: row.name ?? 'Chưa phân loại',
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
