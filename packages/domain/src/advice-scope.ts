import { matchingText, normalizeText } from './parser/text';
import { extractAmounts } from './parser';

export type AdviceScopeStatus =
  'allowed' | 'restricted' | 'out_of_scope' | 'ambiguous';

export type AdviceTopic =
  | 'purchase_affordability'
  | 'loan_estimate'
  | 'savings_plan'
  | 'budget_review'
  | 'spending_overview'
  | 'general';

export type AdviceScopeReason =
  | 'SUPPORTED_PURCHASE'
  | 'SUPPORTED_LOAN'
  | 'SUPPORTED_SAVINGS'
  | 'SUPPORTED_BUDGET'
  | 'SUPPORTED_SPENDING'
  | 'SUPPORTED_GENERAL_FINANCE'
  | 'SPECIFIC_PRODUCT_RECOMMENDATION'
  | 'OUT_OF_SCOPE_CONTENT'
  | 'INSUFFICIENT_FINANCIAL_CONTEXT'
  | 'MULTIPLE_TOPICS';

export interface AdviceScopeDecision {
  status: AdviceScopeStatus;
  topic: AdviceTopic | null;
  reason: AdviceScopeReason;
}

/** Reject promises or claims of writes from the read-only assistant. */
export function isUnsafeAdviceAnswer(input: string): boolean {
  const text = matchingText(normalizeText(input)).folded;
  const affirmative = text.replace(
    /(?:khong|chua|never|cannot|can't|do not)\s+(?:the\s+)?(?:cam ket|dam bao|bao dam|guarantee)/g,
    '',
  );
  return (
    /(?:cam ket|dam bao|chac chan|bao dam).{0,40}(?:loi nhuan|sinh loi)|guaranteed (?:profit|returns)/.test(
      affirmative,
    ) ||
    /(?:toi|tro ly|he thong|i|we)\s+(?:da|vua|have|has)\s+(?:tao|luu|ghi|xoa|cap nhat|created|saved|deleted|updated)\b/.test(
      text,
    )
  );
}

/** Classify financial intent without opening or saving a draft. */
export function classifyFinancialIntent(
  input: string,
  options: { draftOpen?: boolean } = {},
): {
  intent: 'entry' | 'advice' | 'unknown';
  draftAction: 'correct' | 'cancel' | null;
} {
  const text = matchingText(normalizeText(input)).folded;
  const result = (
    intent: 'entry' | 'advice' | 'unknown',
    draftAction: 'correct' | 'cancel' | null = null,
  ) => ({ intent, draftAction });
  if (
    options.draftOpen &&
    /^(?:thoi de sau|huy|cancel|never mind)[.!\s]*$/.test(text)
  )
    return result('unknown', 'cancel');
  if (
    options.draftOpen &&
    /^(?:a nham|nham|sua lai|actually|correction)\b/.test(text)
  )
    return result('unknown', 'correct');
  if (
    /\b(?:toi (?:tieu|chi|thu)|luong toi|thu nhap)\b/.test(text) &&
    !/^(?:(?:hay|vui long|giup toi|toi muon)\s+)?(?:ghi|them|nhap|luu)\b/.test(
      text,
    )
  )
    return result('advice');
  if (
    /\b(?:dung|khong|chua|lam sao|cach nao|how do|how can|do not|dont)\b/.test(
      text,
    ) ||
    /[?"“”]/.test(input)
  )
    return result(
      classifyAdviceScope(input).status === 'allowed' ? 'advice' : 'unknown',
    );
  if (/\b(?:ngan sach|muc tieu|budget|goal)\b/.test(text))
    return result('advice');
  if (
    /^(?:(?:hay|vui long|giup toi|toi muon)\s+)?(?:ghi|them|nhap|luu)\b/.test(
      text,
    ) &&
    extractAmounts(input, 'VND').some(
      (item) => item.amount.value !== null && item.amount.value > 0,
    )
  )
    return result('entry');
  if (
    /\b(?:toi (?:tieu|chi|thu)|luong toi|thu nhap cua toi)\b/.test(text) ||
    classifyAdviceScope(input).status === 'allowed'
  )
    return result('advice');
  return result('unknown');
}

// Patterns that indicate specific product, bank, stock, crypto or insurance recommendations
const BROAD_INVESTMENT_PATTERN = /(quy dau tu|dau tu|co phieu|chung khoan)/i;
const RESTRICTED_PATTERNS: RegExp[] = [
  /\bvay\s+(?:tien mat|nhanh|online|app|khong the chap|tin chap nhanh)\b/i,
  /\brut tien mat\s+(?:tu\s+)?the tin dung\b/i,
  /\b(which|best|choose|recommend)\s+(bank|stock|crypto|insurance|credit card)\b/i,
  /\b(stock|bitcoin|cryptocurrency|forex|insurance policy)\b/i,
  /(ngan hang nao|chon ngan hang|so sanh .*ngan hang|tieu chi .*ngan hang|lai vay ngan hang)/i,
  BROAD_INVESTMENT_PATTERN,
  /(bao hiem|forex)/i,
  /ngan hang nao (tot|uy tin|lai suat thap|uu dai)/i,
  /(chon|nen vay|vay o) ngan hang nao/i,
  /(ma co phieu|co phieu|ma chung khoan|chung khoan) nao/i,
  /nen mua (ma|co phieu|chung khoan) /i,
  /co phieu (vin|fpt|vcb|hpg|vic|vhm)/i,
  /(tien ao|tien dien tu|\bcoin\b|bitcoin|\bbtc\b|ethereum|\beth\b|\bcrypto\b)/i,
  /(goi bao hiem|bao hiem nhan tho|bao hiem) .* (nao tot|nao uy tin|prudential|manulife|dai-ichi|bao viet)/i,
  /san (giao dich|crypto|forex) nao/i,
];

// Patterns for non-financial topics
const OUT_OF_SCOPE_PATTERNS: RegExp[] = [
  /\b(legal advice|lawyer|contract law|medical advice|diagnos\w*|weather forecast|write code|programming help)\b/i,
  /(phap ly|luat phap|tu van luat|quy dinh phap luat|dieu khoan hop dong|quyen loi hop dong)/i,
  /(tu van|hoi|giai thich|quy dinh) .* (luat|phap ly|thua ke|hop dong)/i,
  /(viet|lap trinh|code|coding) (python|javascript|typescript|c\+\+|java|html|css|ung dung|website|tool|bot|script)/i,
  /(viet code|lap trinh code|chay code)/i,
  /(hack|be khoa|crack|tan cong|lay cap|ddos|sql injection) /i,
  /(dich|translate) (van ban|doan van|tieng anh|sang tieng|tieng viet)/i,
  /(tu van benh|uong thuoc|kham benh|dau dau|chua benh|benh vien|trieu chung benh)/i,
  /(thoi tiet|du bao thoi tiet|nhiet do)/i,
  /(huong dan nau|cong thuc nau|cach nau|cach lam) .*(mon|bun bo|pho)/i,
  /(viet tho|viet truyen|ke chuyen|sang tac nhac)/i,
];

// Supported topic patterns
const READ_ONLY_SPENDING_PATTERNS: RegExp[] = [
  /\b(?:thu nhap|chi tieu|thu|chi)\b[^!?;]{0,120}\btrung binh\b/i,
  /\btrung binh\s+(?:moi|hang)\s+thang\b[^!?;]{0,80}\b(?:thu nhap|chi tieu|thu|chi)\b/i,
  /\b(?:thu nhap|chi tieu|thu|chi)\b(?:[^,.;!?]|\.(?=\d)){0,100}\b(?:qua cac thang|trong\s+[1-9]\d*\s+thang)\b/i,
  /\b(?:liet ke|danh sach)\b[^.!?;]{0,80}\b(?:giao dich|chi tieu)\b/i,
  /\bgiao dich\b[^.!?;]{0,80}\bgan nhat\b|\bgan nhat\b[^.!?;]{0,80}\bgiao dich\b/i,
  /\b(?:cac|\d+)\s+khoan chi\b[^.!?;]{0,100}\b(?:gan nhat|ngay\s+\d|\d{1,2}\/\d{1,2}\/\d{4})/i,
];
const SPENDING_PATTERNS: RegExp[] = [
  /\b(how much .*\b(spend|spent|earn|income)|spending (this|last) (month|week)|income and expenses|expense report)\b/i,
  /(tong quan chi tieu|chi tieu het bao nhieu|tieu het bao nhieu|da tieu bao nhieu)/i,
  /(chi tieu|tieu tien|da chi|tong chi|tong thu|phan tich chi tieu) .*(tuan nay|thang nay|hom nay|hom qua)/i,
  /(thang nay|tuan nay|hom nay|hom qua) .*(chi|tieu|thu) .*bao nhieu/i,
  /(tong chi|tong thu|phan tich chi tieu|phan tich ty trong chi tieu|ty trong chi tieu|co cau chi tieu)/i,
  /(thong ke chi tieu|bao cao chi tieu|lich su chi tieu)/i,
  /\bthu nhap\s+cua\s+toi\s+(den tu dau|tu dau|the nao)\b/i,
  // Category questions: "tôi tiêu gì nhiều", "chi vào đâu nhiều nhất".
  /(tieu|chi|mua)\s+(gi|nhung gi|vao dau|khoan nao)\s+(nhieu|nhieu nhat)/i,
  /(nhung|may|vai)\s+ngay\s+(qua|nay)\b.{0,40}\b(tieu|chi|mua)\b/i,
  /\b(tieu|chi|mua)\b.{0,40}\b(nhung|may|vai)\s+ngay\s+(qua|nay)\b/i,
  /\b(spend|spent|spending)\s+(the\s+)?most\b/i,
  /\bwhat did i spend\b/i,
  /\b(which|what)\s+categor\w*/i,
];

const BUDGET_PATTERNS: RegExp[] = [
  /\b(budget|budgeting)\b/i,
  /(ngan sach|dinh muc chi tieu|han muc chi tieu)/i,
  /(thiet lap|lap|cai dat) ngan sach/i,
  /ngan sach .* (con bao nhieu|co hop ly|hop ly khong)/i,
];

const EXPLICIT_SAVINGS_REQUEST =
  /\b(?:tinh (?:muc|ke hoach) tiet kiem|(?:moi|hang) thang can (?:de )?danh bao nhieu)\b/i;

const SUMMARY_AMOUNT = String.raw`(?:\d{1,3}(?:\.\d{3})+|\d+)(?:\s*(?:trieu|tr|dong|vnd))?`;
const SAVINGS_FACT_SUMMARY = new RegExp(
  `^tong chi\\s+${SUMMARY_AMOUNT},\\s*muc tieu\\s+${SUMMARY_AMOUNT}\\s+trong\\s+[1-9]\\d*\\s+thang,\\s*danh rieng\\s+${SUMMARY_AMOUNT}[.!?]?$`,
);
const SHORT_SAVINGS_FIELDS = [
  new RegExp(`^thu nhap\\s+${SUMMARY_AMOUNT}(?:\\s*\\/\\s*thang)?$`),
  new RegExp(
    `^(?:chi|tong chi|chi phi)\\s+${SUMMARY_AMOUNT}(?:\\s*\\/\\s*thang)?$`,
  ),
  new RegExp(`^muc tieu\\s+${SUMMARY_AMOUNT}\\s+trong\\s+[1-9]\\d*\\s+thang$`),
];

const SAVINGS_PATTERNS: RegExp[] = [
  /\b(how (can|should|do) i save|save more|savings plan|saving goal|emergency fund)\b/i,
  /\b(how much .*save|how long .*save|save .* for (a|the|my) purchase)\b/i,
  /(ke hoach|muc tieu) tiet kiem/i,
  /\bmuc tieu\s+cua\s+toi\s+the nao\b/i,
  /(lam sao|cach nao|lam cach nao) de tiet kiem/i,
  /tiet kiem (?:[^.!?;]|\.(?=\d))*?\b(trong\s+\d+\s*(?:thang|nam|tuan)\b|de mua|mua nha|mua xe|nghi huu)/i,
  /(de danh|danh rieng|tich luy) (?:[^.!?;]|\.(?=\d))*?\b(moi thang|hang thang|moi tuan|de mua|cho muc tieu)/i,
  EXPLICIT_SAVINGS_REQUEST,
  /\bde danh\s+\d+\s*(?:m|tr|trieu|k)\s+moi thang\b/i,
];

const PURCHASE_PATTERNS: RegExp[] = [
  /\b(can i afford|afford to buy|should i buy|how long .*buy)\b/i,
  /(co nen mua|co nen mua moi|kha nang mua|du kha nang mua)/i,
  /(thu nhap .* co nen mua|luong .* co nen mua)/i,
  /(mua noi .* khong|mua duoc .* khong)/i,
  /(du dinh mua|dinh mua|toi muon mua) .* (dien thoai|xe|nha|laptop|may tinh)/i,
  /toi muon mua (xe|dien thoai|nha|laptop|may tinh).* (tiet kiem|bao lau)/i,
];

const LOAN_PATTERNS: RegExp[] = [
  /\b(borrow .*repay|loan payment|repay monthly|afford .*loan|loan affordability)\b/i,
  /vay .*tra gop/i,
  /(vay|tra gop|khoan vay) .* (thang|nam|lai suat|on khong|phu hop|chiu duoc|tu van|moi thang|bao nhieu|the nao|nhu the nao|tinh sao|tinh the nao|ra sao)/i,
  /tinh khoan vay/i,
  /lai vay ngan hang/i,
  /tieu chi so sanh lai vay/i,
  /vay .* lai suat/i,
  /(moi thang tra bao nhieu|tra no bao nhieu)/i,
];

const GENERAL_FINANCE_PATTERNS: RegExp[] = [
  /\b(personal finance|manage my money|50\/30\/20 rule)\b/i,
  /(lai suat kep|quy khan cap|tai chinh ca nhan)/i,
  /(quy tac|nguyen tac) (50 30 20|50\/30\/20|tai chinh)/i,
  /quan ly tai chinh/i,
  /(?:nen|can|phai)\s+(?:kiem|thu|chi tieu|chi|tieu)\s+(?:them\s+)?bao nhieu\b/i,
  /(?:kiem|thu)\s+(?:them\s+)?bao nhieu\s+(?:1|mot|moi|hang)\s+(?:ngay|tuan|thang)\b/i,
  /(?:chia|phan bo|can doi|sap xep)\s+(?:tien|chi tieu|thu nhap|luong|dong tien)\b/i,
  /(?:ke hoach|chien luoc|cach)\s+(?:kiem tien|tang thu nhap|quan ly chi tieu|can doi thu chi|chia tien)\b/i,
  /\b(?:daily (?:income|earning|spending) (?:target|goal|plan)|split my (?:income|spending|money)|balance my (?:income|cash flow))\b/i,
];

export function classifyAdviceScope(input: string): AdviceScopeDecision {
  const normalized = normalizeText(input);
  if (!normalized) {
    return {
      status: 'ambiguous',
      topic: null,
      reason: 'INSUFFICIENT_FINANCIAL_CONTEXT',
    };
  }

  const { folded } = matchingText(normalized);
  const education =
    /(?:la gi|khac gi|khac nhau|da dang hoa|nguyen ly|co ban|rui ro|thoi han|what is|difference|diversification|basics|risk|time horizon)/.test(
      folded,
    ) && /(?:dau tu|tiet kiem|investment|diversification)/.test(folded);

  // Check for amount-only or gibberish inputs
  const strippedOfNumbersAndSymbols = folded
    .replace(/[0-9kmt₫$,.?!%+\-*/=]/g, '')
    .replace(/\b(trieu|ty|nghin|tram|dong|vnd)\b/g, '')
    .trim();

  if (strippedOfNumbersAndSymbols.length < 3) {
    return {
      status: 'ambiguous',
      topic: null,
      reason: 'INSUFFICIENT_FINANCIAL_CONTEXT',
    };
  }

  // Precedence 1: Out of scope patterns (even if wrapped with financial keywords)
  for (const pattern of OUT_OF_SCOPE_PATTERNS) {
    if (pattern.test(folded)) {
      return {
        status: 'out_of_scope',
        topic: null,
        reason: 'OUT_OF_SCOPE_CONTENT',
      };
    }
  }

  // Precedence 2: Specific product recommendation (restricted)
  for (const pattern of RESTRICTED_PATTERNS) {
    if (education && pattern === BROAD_INVESTMENT_PATTERN) continue;
    if (pattern.test(folded)) {
      return {
        status: 'restricted',
        topic: null,
        reason: 'SPECIFIC_PRODUCT_RECOMMENDATION',
      };
    }
  }

  const affirmative = folded.replace(
    /(?:khong|chua|never|cannot|can't|do not)\s+(?:the\s+)?(?:cam ket|dam bao|bao dam|guarantee)/g,
    'refusal',
  );
  if (
    /(?:cam ket|dam bao|chac chan|bao dam).{0,40}(?:loi nhuan|sinh loi|lai)|(?:loi nhuan|sinh loi|lai).{0,25}(?:chac chan|bao dam)|guaranteed (?:profit|returns)/.test(
      affirmative,
    )
  )
    return {
      status: 'restricted',
      topic: null,
      reason: 'SPECIFIC_PRODUCT_RECOMMENDATION',
    };
  if (
    education ||
    /quy du phong|quy du tru|emergency fund|lai kep|compound interest|toi (?:tieu|chi|thu).{0,25}(?:an uong|tien|trieu|dong)|chua phan loai|sap den han|den han|uncategorized|due soon/.test(
      folded,
    )
  )
    return {
      status: 'allowed',
      topic: 'general',
      reason: 'SUPPORTED_GENERAL_FINANCE',
    };

  // Personal financial snapshots combine topics without asking for a product or calculation.
  if (
    /(tinh hinh|tong quan)\s+(no|khoan no)\s+va\s+tiet kiem\s+cua\s+toi\b/i.test(
      folded,
    )
  ) {
    return {
      status: 'allowed',
      topic: 'general',
      reason: 'SUPPORTED_GENERAL_FINANCE',
    };
  }

  // Accept only complete declarations; extra clauses must retain normal topic checks.
  const summaryClauses = folded
    .replace(/[.!]$/, '')
    .split(',')
    .map((part) => part.trim());
  if (
    SAVINGS_FACT_SUMMARY.test(folded) ||
    (summaryClauses.length === 3 &&
      SHORT_SAVINGS_FIELDS.every((pattern) =>
        summaryClauses.some((clause) => pattern.test(clause)),
      ))
  ) {
    return {
      status: 'allowed',
      topic: 'savings_plan',
      reason: 'SUPPORTED_SAVINGS',
    };
  }

  // Precedence 3: Detect financial topics
  const detectedTopics: { topic: AdviceTopic; reason: AdviceScopeReason }[] =
    [];

  const matchesAny = (patterns: RegExp[]) =>
    patterns.some((p) => p.test(folded));

  if (matchesAny(PURCHASE_PATTERNS)) {
    detectedTopics.push({
      topic: 'purchase_affordability',
      reason: 'SUPPORTED_PURCHASE',
    });
  }
  if (matchesAny(LOAN_PATTERNS)) {
    detectedTopics.push({ topic: 'loan_estimate', reason: 'SUPPORTED_LOAN' });
  }
  if (matchesAny(SAVINGS_PATTERNS)) {
    detectedTopics.push({ topic: 'savings_plan', reason: 'SUPPORTED_SAVINGS' });
  }
  if (matchesAny(BUDGET_PATTERNS)) {
    detectedTopics.push({ topic: 'budget_review', reason: 'SUPPORTED_BUDGET' });
  }
  if (
    matchesAny(SPENDING_PATTERNS) ||
    matchesAny(READ_ONLY_SPENDING_PATTERNS)
  ) {
    detectedTopics.push({
      topic: 'spending_overview',
      reason: 'SUPPORTED_SPENDING',
    });
  }
  if (matchesAny(GENERAL_FINANCE_PATTERNS)) {
    detectedTopics.push({
      topic: 'general',
      reason: 'SUPPORTED_GENERAL_FINANCE',
    });
  }

  if (detectedTopics.length === 1) {
    return {
      status: 'allowed',
      topic: detectedTopics[0].topic,
      reason: detectedTopics[0].reason,
    };
  }

  if (detectedTopics.length > 1) {
    // A budget check may include supporting read-only data, but no independent legacy spending request.
    if (
      detectedTopics.length === 2 &&
      detectedTopics.some(({ topic }) => topic === 'budget_review') &&
      detectedTopics.some(({ topic }) => topic === 'spending_overview') &&
      /\bkiem tra ngan sach\b/.test(folded) &&
      matchesAny(READ_ONLY_SPENDING_PATTERNS) &&
      !matchesAny(SPENDING_PATTERNS) &&
      !/\b(?:tao|thiet lap|lap|xoa|cap nhat) ngan sach\b/.test(folded)
    ) {
      return {
        status: 'allowed',
        topic: 'budget_review',
        reason: 'SUPPORTED_BUDGET',
      };
    }
    // Only declared monetary inputs may accompany a clear savings request.
    if (
      detectedTopics.length === 2 &&
      detectedTopics.some(({ topic }) => topic === 'savings_plan') &&
      detectedTopics.some(({ topic }) => topic === 'spending_overview')
    ) {
      const spendingClauses = folded
        .split(/[,.;!?]/)
        .map((clause) => clause.trim())
        .filter((clause) => SPENDING_PATTERNS.some((p) => p.test(clause)));
      const declaredExpense =
        /^(?:tong chi|chi phi)\s+(?:la\s+)?\d+\s*(?:trieu|tr|ty|nghin|ngan|k|dong|vnd)(?:\s+dong)?(?:\s*(?:\/\s*thang|moi thang))?(?:\s+da (?:bao )?gom tra no)?$/;
      if (
        EXPLICIT_SAVINGS_REQUEST.test(folded) &&
        !matchesAny(READ_ONLY_SPENDING_PATTERNS) &&
        spendingClauses.length > 0 &&
        spendingClauses.every((clause) => declaredExpense.test(clause))
      ) {
        return {
          status: 'allowed',
          topic: 'savings_plan',
          reason: 'SUPPORTED_SAVINGS',
        };
      }
    }
    return {
      status: 'ambiguous',
      topic: null,
      reason: 'MULTIPLE_TOPICS',
    };
  }

  // Precedence 4: Insufficient context or unrecognized
  return {
    status: 'ambiguous',
    topic: null,
    reason: 'INSUFFICIENT_FINANCIAL_CONTEXT',
  };
}
