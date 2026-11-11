import {
  formatVnd,
  monthKey,
  today,
  validateDate,
  extractAmounts,
} from '@pfm/domain';

function generateUuid(): string {
  if (typeof globalThis !== 'undefined' && typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
import { formatDisplayDate } from '@/utils/display';
import { withDatabase } from '@/data/connection';
import { createBudget } from '@/data/budgets';
import { listCategories, type CategoryRow } from '@/data/categories';
import { foldSearchText } from '@/data/search-text';
import { en } from '@/messages/en';
import { vi } from '@/messages/vi';
import { displayCategoryName } from '@/messages/seed-labels';
import { usePreferences } from '@/state/preferences';
import { useApp } from '@/state/app';
import { checkBudgetAlerts } from '@/features/budgets/mobile';
import type { AIResponsePayload } from './ai-service';

export const ADVICE_CLOCK = {
  now: () => new Date(),
  timeZone: 'Asia/Ho_Chi_Minh',
} as const;

function pickStrings(language: 'vi' | 'en') {
  return language === 'en' ? en : vi;
}

/**
 * Checks whether the prompt is asking to set up or create a budget.
 */
export function isBudgetSetupIntent(prompt: string): boolean {
  const folded = foldSearchText(prompt);
  // Exclude 50/30/20 general planning
  if (folded.includes('50/30/20') || folded.includes('50-30-20') || folded.includes('50 30 20')) {
    return false;
  }
  const mentionsBudget =
    /\b(ngan sach|budget|dinh muc|han muc)\b/.test(folded) ||
    folded.includes('ngan sach') ||
    folded.includes('budget');

  if (!mentionsBudget) return false;

  const hasSetupKeyword =
    /(thiet lap|tao|dat|cai dat|setup|set up|lap|them|create|add|make|new|danh cho|cho)/.test(
      folded,
    );

  // If asking a question like "còn bao nhiêu" without setup keyword, not setup
  if (
    /(con bao nhieu|con lai|hop ly khong|xem|kiem tra|check|the nao|bao nhieu tien)/.test(
      folded,
    ) &&
    !hasSetupKeyword
  ) {
    return false;
  }

  return hasSetupKeyword;
}

interface ParsedDateRange {
  startDate: string;
  endDate: string;
}

/**
 * Attempts to extract a custom date range from the prompt (e.g. "từ 01-11-2026 đến 30-11-2026").
 */
export function extractCustomDateRange(
  prompt: string,
  referenceDate: string = today(ADVICE_CLOCK),
): ParsedDateRange | null {
  const refYear = Number(referenceDate.slice(0, 4));
  const folded = foldSearchText(prompt);

  // Patterns like:
  // "từ 01-11-2026 đến 30-11-2026"
  // "từ 1/11/2026 tới 30/11/2026"
  // "01/11/2026 - 30/11/2026"
  // "from 01/11/2026 to 30/11/2026"
  const rangeRegex =
    /(?:tu|from)?\s*(?:ngay\s*)?(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\s*(?:den|toi|to|-|–)\s*(?:ngay\s*)?(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)/i;

  const match = rangeRegex.exec(folded);
  if (!match) return null;

  const parseOne = (raw: string): string | null => {
    const parts = raw.split(/[/-]/).map(Number);
    if (parts.length === 2) {
      const [day, month] = parts;
      const iso = `${refYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      try {
        validateDate(iso);
        return iso;
      } catch {
        return null;
      }
    }
    if (parts.length === 3) {
      const [day, month, yearPart] = parts;
      const fullYear = yearPart < 100 ? 2000 + yearPart : yearPart;
      const iso = `${fullYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      try {
        validateDate(iso);
        return iso;
      } catch {
        return null;
      }
    }
    return null;
  };

  const start = parseOne(match[1]);
  const end = parseOne(match[2]);

  if (start && end && end >= start) {
    return { startDate: start, endDate: end };
  }
  return null;
}

/**
 * Attempts to automatically set up a budget from a user's natural prompt.
 * If the prompt is a budget setup request, it creates the budget in the database
 * and returns an AIResponsePayload. If not, returns null.
 */
export async function tryAIBudgetSetup({
  prompt,
  userMessageId = `msg-${Date.now()}`,
  db: customDb,
}: {
  prompt: string;
  userMessageId?: string;
  db?: any;
}): Promise<AIResponsePayload | null> {
  if (!isBudgetSetupIntent(prompt)) {
    return null;
  }

  const { language, currency } = usePreferences.getState();
  const strings = pickStrings(language);
  const createdAt = new Date().toISOString();
  const id = `ai-${userMessageId}`;

  // 1. Extract amount
  const amounts = extractAmounts(prompt, currency);
  const amountMatch = amounts.find(
    (item) => item.amount.value !== null && item.amount.value > 0,
  );

  if (!amountMatch || !amountMatch.amount.value) {
    // User wants to set up a budget, but didn't provide an amount
    return {
      id,
      userMessageId,
      replyText: strings.aiBudgetAskDetails,
      createdAt,
    };
  }

  const budgetAmount = amountMatch.amount.value;

  // 2. Extract warn percent if specified (e.g. "cảnh báo 70%" or "ngưỡng 90%")
  let warnPercent = 80;
  const foldedText = foldSearchText(prompt);
  const warnMatch = /(?:canh bao|nguong|warn)(?:\s*khi\s*dat)?\s*(\d{1,2})%/i.exec(
    foldedText,
  );
  if (warnMatch) {
    const parsedWarn = Number(warnMatch[1]);
    if (parsedWarn >= 1 && parsedWarn <= 100) {
      warnPercent = parsedWarn;
    }
  }

  // 3. Extract custom date range vs monthly
  const dateRange = extractCustomDateRange(prompt);
  const periodType: 'monthly' | 'custom' = dateRange ? 'custom' : 'monthly';

  let startDate: string | null = null;
  let endDate: string | null = null;
  let startMonth: string = monthKey(today(ADVICE_CLOCK));
  let endMonth: string | null = null;

  if (dateRange) {
    startDate = dateRange.startDate;
    endDate = dateRange.endDate;
    startMonth = startDate.slice(0, 7);
    endMonth = endDate.slice(0, 7);
  } else {
    // Check if a specific month is mentioned (e.g. "tháng 11/2026" or "tháng 12")
    const folded = foldSearchText(prompt);
    const monthMatch = /(?:thang|month)\s*(\d{1,2})(?:[/-](\d{4}))?/.exec(folded);
    if (monthMatch) {
      const targetMonth = Number(monthMatch[1]);
      const currentYear = Number(startMonth.slice(0, 4));
      const targetYear = monthMatch[2] ? Number(monthMatch[2]) : currentYear;
      if (targetMonth >= 1 && targetMonth <= 12) {
        startMonth = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
      }
    }
  }

  const runWithDb = async <T>(fn: (db: any) => Promise<T>): Promise<T> => {
    if (customDb) return fn(customDb);
    return withDatabase(fn);
  };

  // 4. Match category
  let matchedCategory: CategoryRow | null = null;
  const categories = await runWithDb((db) => listCategories(db, true));
  const expenseCategories = categories.filter((c) => c.kind === 'expense');

  const foldedPrompt = foldSearchText(prompt);

  // Check if explicitly overall budget
  const isOverall = /(tong|chung|tat ca|overall|all|general)/.test(foldedPrompt);

  if (!isOverall) {
    // Find matching categories, choosing the longest match
    let bestMatchLength = 0;
    for (const cat of expenseCategories) {
      const foldedCat = foldSearchText(cat.name);
      if (foldedPrompt.includes(foldedCat) && foldedCat.length > bestMatchLength) {
        bestMatchLength = foldedCat.length;
        matchedCategory = cat;
      }
    }
  }

  // 5. Create budget in database
  const budgetId = generateUuid();
  await runWithDb(async (db) => {
    await createBudget(
      db,
      budgetId,
      {
        amount: budgetAmount,
        warnPercent,
        periodType,
        startDate,
        endDate,
        startMonth,
        endMonth,
        categoryId: matchedCategory ? matchedCategory.id : null,
      },
      createdAt,
    );
  });

  // 6. Update app state & schedule budget alert check
  try {
    useApp?.setState?.((s) => ({ recurringVersion: s.recurringVersion + 1 }));
  } catch {
    /* ignore in test environments */
  }
  try {
    void checkBudgetAlerts?.();
  } catch {
    /* ignore in test environments */
  }

  // 7. Format friendly confirmation reply
  const periodLabel =
    periodType === 'custom' && startDate && endDate
      ? `Từ ${formatDisplayDate(startDate)} đến ${formatDisplayDate(endDate)}`
      : `${strings.budgetPeriodMonthly} (${strings.budgetRecurringMonthly})`;

  const categoryName = matchedCategory
    ? displayCategoryName(matchedCategory.name, language)
    : strings.budgetOverall;

  const replyLines = [
    strings.aiBudgetSetupSuccess,
    `• ${strings.aiBudgetCategoryLabel}: ${categoryName}`,
    `• ${strings.aiBudgetLimitLabel}: ${formatVnd(budgetAmount)}`,
    `• ${strings.aiBudgetPeriodLabel}: ${periodLabel}`,
    `• ${strings.aiBudgetWarnAtLabel}: ${warnPercent}%`,
    '',
    language === 'en'
      ? 'You can view or manage this budget in the Budgets tab.'
      : 'Bạn có thể xem hoặc quản lý ngân sách tại mục Ngân sách.',
  ];

  return {
    id,
    userMessageId,
    replyText: replyLines.join('\n'),
    createdAt,
  };
}
