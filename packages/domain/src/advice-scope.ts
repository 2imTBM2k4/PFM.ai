import { matchingText, normalizeText } from './parser/text';

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

// Patterns that indicate specific product, bank, stock, crypto or insurance recommendations
const RESTRICTED_PATTERNS: RegExp[] = [
  /\b(which|best|choose|recommend)\s+(bank|stock|crypto|insurance|credit card)\b/i,
  /\b(stock|bitcoin|cryptocurrency|forex|insurance policy)\b/i,
  /(ngan hang nao|chon ngan hang|so sanh .*ngan hang|tieu chi .*ngan hang|lai vay ngan hang)/i,
  /(quy dau tu|dau tu|co phieu|chung khoan|bao hiem|forex)/i,
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
const SPENDING_PATTERNS: RegExp[] = [
  /\b(how much .*\b(spend|spent|earn|income)|spending (this|last) (month|week)|income and expenses|expense report)\b/i,
  /(tong quan chi tieu|chi tieu het bao nhieu|tieu het bao nhieu|da tieu bao nhieu)/i,
  /(chi tieu|tieu tien|da chi|tong chi|tong thu|phan tich chi tieu) .*(tuan nay|thang nay|hom nay|hom qua)/i,
  /(thang nay|tuan nay|hom nay|hom qua) .*(chi|tieu|thu) .*bao nhieu/i,
  /(tong chi|tong thu|phan tich chi tieu)/i,
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

const SAVINGS_PATTERNS: RegExp[] = [
  /\b(how (can|should|do) i save|save more|savings plan|saving goal|emergency fund)\b/i,
  /\b(how much .*save|how long .*save|save .* for (a|the|my) purchase)\b/i,
  /(ke hoach|muc tieu) tiet kiem/i,
  /\bmuc tieu\s+cua\s+toi\s+the nao\b/i,
  /(lam sao|cach nao|lam cach nao) de tiet kiem/i,
  /tiet kiem .* (trong|de mua|mua nha|mua xe|nghi huu)/i,
  /(de danh|danh rieng|tich luy) .* (moi thang|hang thang|moi tuan|de mua|cho muc tieu)/i,
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
    if (pattern.test(folded)) {
      return {
        status: 'restricted',
        topic: null,
        reason: 'SPECIFIC_PRODUCT_RECOMMENDATION',
      };
    }
  }

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
  if (matchesAny(SPENDING_PATTERNS)) {
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
