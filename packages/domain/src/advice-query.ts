import {
  addDays,
  addMonths,
  daysInMonth,
  startOfWeek,
  type Clock,
} from './dates';
import { matchingText, normalizeText } from './parser/text';

export type AdviceQueryKind = 'expense_by_category' | 'cash_flow' | 'advice';

export type AdviceRangeKind =
  | 'last_7_days'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'last_30_days';

export interface AdviceDateRange {
  kind: AdviceRangeKind;
  from: string;
  to: string;
}

export interface AdviceQuery {
  kind: AdviceQueryKind;
  range: AdviceDateRange | null;
  category: string | null;
  needsClarification: boolean;
}

export type AdviceHistoryTurn = { role: 'user' | 'assistant'; text: string };

// Explicitly supported periods only; anything else must be clarified or carried over.
const RANGE_PATTERNS: { kind: AdviceRangeKind; patterns: RegExp[] }[] = [
  {
    kind: 'last_7_days',
    // Text is folded, so "bảy" arrives as "bay".
    patterns: [/\b(7|bay)\s*ngay\b/, /\b(last|past)\s*(7|seven)\s*days?\b/],
  },
  {
    kind: 'last_30_days',
    patterns: [/\b30\s*ngay\b/, /\b(last|past)\s*(30|thirty)\s*days?\b/],
  },
  {
    kind: 'last_week',
    patterns: [/\btuan truoc\b/, /\blast week\b/],
  },
  {
    kind: 'this_week',
    patterns: [/\btuan nay\b/, /\bthis week\b/],
  },
  {
    kind: 'last_month',
    patterns: [/\bthang truoc\b/, /\bthang roi\b/, /\blast month\b/],
  },
  {
    kind: 'this_month',
    patterns: [/\bthang nay\b/, /\bthis month\b/],
  },
  {
    kind: 'yesterday',
    patterns: [/\bhom qua\b/, /\byesterday\b/],
  },
  {
    kind: 'today',
    patterns: [/\bhom nay\b/, /\btoday\b/],
  },
  {
    kind: 'last_7_days',
    patterns: [
      /\b(nhung|may|vai|moi)\s*ngay\s*(qua|nay|gan day)\b/,
      /\bgan\s*day\b/,
      /\b(recent|recently|lately|these days|past few days|last few days)\b/,
    ],
  },
];

// A vague period ("những ngày qua") defaults to the last 7 days including today.
export const DEFAULT_ADVICE_RANGE_KIND: AdviceRangeKind = 'last_7_days';

const CATEGORY_QUERY_PATTERNS: RegExp[] = [
  /\btieu\s+(gi|gi the|nhung gi|khoan nao|mon nao|mat nao)\b/,
  /\bchi\s+(gi|nhung gi|khoan nao)\b/,
  /\b(tieu|chi)\s+(nhieu nhat|nhieu nhat vao|cai gi)\b/,
  /\bnhieu nhat\b/,
  /\b(tieu|chi|mua)\s+(vao|cho)\s+(cai gi|khoan nao|gi)\b/,
  /\b(top|which|what)\b[^?]{0,24}\b(categor|spend|spent|spending|expense)/,
  /\bspen[dt]?\s+(the\s+)?most\b/,
  /\bwhat did i spend\b/,
  /\b(major|biggest|largest|highest)\s+(spend|spending|expense)/,
  /\bbreakdown\b/,
  /\bphan tich chi tieu\b/,
];

// Source/breakdown questions need explanation, not the local cash-flow totals.
const INCOME_SOURCE_PATTERNS: RegExp[] = [
  /\bthu nhap\s+cua\s+toi\s+(den tu dau|tu dau)\b/,
  /\b(nguon thu nhap|nguon thu)\s+cua\s+toi\b/,
  /\bwhere\s+(does|do)\s+my\s+income\s+come\s+from\b/,
];

const CASH_FLOW_PATTERNS: RegExp[] = [
  /\b(tong thu|tong chi|thu nhap|thu vao|tien vao|tien ra)\b/,
  /\b(tiet kiem duoc|con lai duoc|de ra duoc)\b/,
  /\b(thu|chi)\s+bao nhieu\b/,
  /\bchi\s+het\s+bao nhieu\b/,
  /\b(bao nhieu|het bao nhieu)\b[^?]{0,20}\b(tien|dong|vnd)\b/,
  /\b(income|earn|earned|earnings|salary|revenue)\b/,
  /\b(total|net)\s+(income|expense|expenses|spending|cash ?flow)\b/,
  /\bhow much\b[^?]{0,24}\b(spend|spent|spending|earn|earned|income|make)\b/,
  /\bhow much\s+(did|do|have)\s+i\b/,
  /\bspend(ing)?\s+(and|vs|versus)\s+(income|earning)/,
];

// Counselling intent wins over a numeric one so "mỗi tháng" goals stay advice.
// Vowels are dropped ("co nen" not "nen") so common words such as "còn" never
// look like advice wording.
const ADVICE_QUESTION_PATTERNS: RegExp[] = [
  /\b(lam sao|cach nao|co nen|nen mua|nen chi|nen tiet kiem|kha nang|bao lau|co on khong|co on|phu hop|hop ly|goi y|tu van|chuyen gia)\b/,
  /\b(ke hoach|muc tieu|ngan sach|quy khan cap|tra gop|khoan vay|lai suat)\b/,
  /\b(save|saving|savings|afford|budget|plan|should|advise|advice|goal|loan|installment|debt|how long|how can|how should)\b/,
];

// A concrete scenario (buy X for Y, repay Z a month) is advice even without "nên".
// Money must carry a unit so "tháng trước" can never look like a scenario.
const MONEY_AMOUNT_SOURCE =
  '(?:\\d+(?:[.,]\\d+)?\\s*(?:trieu|tr|m|ty|nghin|k|dong|vnd|usd|\\$|%)|\\$\\s*\\d+(?:[.,]\\d+)?)';
const SCENARIO_PATTERNS: RegExp[] = [
  new RegExp(
    `\\b(?:mua|vay|tra gop|de danh|danh rieng)\\b[^?]{0,24}?${MONEY_AMOUNT_SOURCE}`,
  ),
  new RegExp(
    `\\b(?:buy|purchase|borrow|repay|save|saving)\\b[^?]{0,24}?${MONEY_AMOUNT_SOURCE}`,
  ),
];

const TRANSACTION_COMMAND_PATTERNS: RegExp[] = [
  /\b(ghi|luu|them|nhap)\s+(giao dich|thu|chi|khoan|vao)\b/,
  /\b(ghi thu|ghi chi|tra no|tra tien|chuyen vi|cho .* muon|vay .* tra)\b/,
  /\b(record|log|add|save)\s+(a\s+)?(transaction|expense|income|payment)\b/,
];

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function detectRangeKind(folded: string): AdviceRangeKind | null {
  for (const { kind, patterns } of RANGE_PATTERNS) {
    if (matchesAny(patterns, folded)) return kind;
  }
  return null;
}

// Resolve a supported period into concrete local dates that never pass today.
export function resolveAdviceRange(
  kind: AdviceRangeKind,
  today: string,
): AdviceDateRange {
  switch (kind) {
    case 'today':
      return { kind, from: today, to: today };
    case 'yesterday': {
      const yesterday = addDays(today, -1);
      return { kind, from: yesterday, to: yesterday };
    }
    case 'this_week': {
      const monday = startOfWeek(today);
      return { kind, from: monday, to: today };
    }
    case 'last_week': {
      const monday = startOfWeek(today);
      return { kind, from: addDays(monday, -7), to: addDays(monday, -1) };
    }
    case 'this_month':
      return { kind, from: `${today.slice(0, 7)}-01`, to: today };
    case 'last_month': {
      const previousMonthStart = addMonths(`${today.slice(0, 7)}-01`, -1);
      const [previousYear, previousMonth] = previousMonthStart
        .split('-')
        .map(Number);
      const lastDay = String(daysInMonth(previousYear, previousMonth)).padStart(
        2,
        '0',
      );
      return {
        kind,
        from: previousMonthStart,
        to: `${previousMonthStart.slice(0, 7)}-${lastDay}`,
      };
    }
    case 'last_30_days':
      return { kind, from: addDays(today, -29), to: today };
    case 'last_7_days':
    default:
      return { kind: 'last_7_days', from: addDays(today, -6), to: today };
  }
}

function buildQuery(
  kind: AdviceQueryKind,
  rangeKind: AdviceRangeKind | null,
  today: string,
  category: string | null,
  needsClarification: boolean,
): AdviceQuery {
  return {
    kind,
    range: rangeKind ? resolveAdviceRange(rangeKind, today) : null,
    category,
    needsClarification,
  };
}

// Validate a caller-supplied ISO date so the range builder cannot receive garbage.
function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return day >= 1 && day <= daysInMonth(year, month);
}

function readToday(source: string | Clock): string {
  if (typeof source === 'string') {
    if (!isValidDate(source)) throw new RangeError('Expected YYYY-MM-DD.');
    return source;
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: source.timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(source.now());
  const fields = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${fields.year.padStart(4, '0')}-${fields.month}-${fields.day}`;
}

// Extract a category the user named explicitly, without guessing.
export function extractMentionedCategory(question: string): string | null {
  const normalized = normalizeText(question);
  if (!normalized) return null;
  const match = normalized.match(
    /(?:danh mục|mục|nhóm|category|loại)\s+([\p{L}][\p{L}\s&]{1,30}?)(?=$|[,.;:?!]|\s+(?:trong|tháng|tuần|này|khoảng|bao|chiếm|hết|nhất|và|la|là|theo|vào|từ)|$)/iu,
  );
  const raw = match?.[1]?.trim().replace(/\s+/g, ' ');
  if (!raw || raw.length < 2 || raw.length > 30) return null;
  return raw;
}

/**
 * Classify one factual question, optionally inheriting the topic of the previous
 * factual turn so "Thế tháng trước?" keeps the earlier subject.
 */
export function parseAdviceQuery(
  question: string,
  history: AdviceHistoryTurn[] = [],
  today: string | Clock,
): AdviceQuery {
  const resolvedToday = readToday(today);
  const normalized = normalizeText(question ?? '');
  if (!normalized) {
    return {
      kind: 'advice',
      range: null,
      category: null,
      needsClarification: true,
    };
  }

  const { folded } = matchingText(normalized);
  const explicitRange = detectRangeKind(folded);
  const explicitCategory = extractMentionedCategory(normalized);
  const isTransactionCommand = matchesAny(TRANSACTION_COMMAND_PATTERNS, folded);
  const looksLikeAdvice = matchesAny(ADVICE_QUESTION_PATTERNS, folded);
  const hasScenario = matchesAny(SCENARIO_PATTERNS, folded);
  const wantsCategories = matchesAny(CATEGORY_QUERY_PATTERNS, folded);
  const wantsCashFlow =
    !matchesAny(INCOME_SOURCE_PATTERNS, folded) &&
    matchesAny(CASH_FLOW_PATTERNS, folded);

  // A factual chain already open in this conversation carries a bare follow-up.
  const carryOver = findPreviousFactQuery(question, history, resolvedToday);
  const canFollowUp =
    Boolean(carryOver) &&
    !isTransactionCommand &&
    (explicitRange !== null || explicitCategory !== null) &&
    (!looksLikeAdvice || hasScenario);

  let kind: AdviceQueryKind = 'advice';
  if (canFollowUp) {
    kind = carryOver!.kind;
  } else if (!isTransactionCommand && !looksLikeAdvice && !hasScenario) {
    if (wantsCategories) kind = 'expense_by_category';
    else if (wantsCashFlow) kind = 'cash_flow';
  }

  // `isFactual` marks a turn that asks for numbers, so a follow-up that only
  // carries a period (for example "Còn tháng trước thì sao?") stays counselling
  // while its inherited kind still lets the device answer it.
  if (kind === 'advice') {
    return {
      kind,
      range: explicitRange
        ? resolveAdviceRange(explicitRange, resolvedToday)
        : null,
      category: explicitCategory,
      needsClarification: false,
    };
  }

  const rangeKind =
    explicitRange ??
    carryOver?.range?.kind ??
    (wantsCategories || wantsCashFlow ? DEFAULT_ADVICE_RANGE_KIND : null);
  // A bare period such as "tháng này" only makes sense as a follow-up.
  const needsClarification = explicitRange === null && !carryOver;
  const category =
    explicitCategory ??
    (kind === 'expense_by_category' ? (carryOver?.category ?? null) : null);

  return buildQuery(
    kind,
    rangeKind,
    resolvedToday,
    category,
    needsClarification,
  );
}

export function isFactQueryKind(kind: AdviceQueryKind): boolean {
  return kind === 'expense_by_category' || kind === 'cash_flow';
}

/**
 * Look back for the last user turn that already asked for numbers, so a short
 * follow-up inherits its subject and period instead of inventing new ones.
 */
export function findPreviousFactQuery(
  question: string,
  history: AdviceHistoryTurn[] = [],
  today: string | Clock,
): AdviceQuery | null {
  const resolvedToday = readToday(today);
  const normalized = normalizeText(question ?? '');
  for (let index = history.length - 1; index >= 0; index--) {
    const turn = history[index];
    if (turn.role !== 'user') continue;
    const text = normalizeText(turn.text ?? '');
    if (!text || text === normalized) continue;
    const { folded } = matchingText(text);
    if (matchesAny(TRANSACTION_COMMAND_PATTERNS, folded)) continue;
    const previous = parseAdviceQuery(turn.text, [], resolvedToday);
    if (isFactQueryKind(previous.kind)) return previous;
  }
  return null;
}
