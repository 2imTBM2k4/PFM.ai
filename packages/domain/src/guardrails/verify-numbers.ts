export const APPROX_TOLERANCE_BPS = 500; // 5% tolerance

export interface VerifyNumbersResult {
  isValid: boolean;
  violations: number[];
  extracted: number[];
}

const APPROX_WORDS = new Set([
  'khoảng',
  'khoang',
  'xấp xỉ',
  'xap xi',
  'xấp',
  'tầm',
  'tam',
  'gần',
  'gan',
  'khoảng chừng',
  'about',
  'around',
  'approximately',
  'roughly',
]);

// Normalize number strings like "1.500.000", "1,5", "500k", "2 triệu".
function parseVietnameseNumber(raw: string): number | null {
  const clean = raw
    .trim()
    .toLowerCase()
    .replace(/^\$/, '')
    .replace(/(?:₫|đ|vnđ|vnd|đồng|dong|usd|\$)$/i, '')
    .trim();

  // Percentage e.g. 12% or 12,5%
  if (clean.endsWith('%')) {
    const numPart = clean.slice(0, -1).replace(',', '.');
    const val = parseFloat(numPart);
    return Number.isFinite(val) ? val : null;
  }

  // Vietnamese money unit suffixes
  if (clean.endsWith('tỷ') || clean.endsWith('ty')) {
    const numPart = clean.replace(/tỷ|ty/, '').trim().replace(',', '.');
    const val = parseFloat(numPart);
    return Number.isFinite(val) ? Math.round(val * 1_000_000_000) : null;
  }

  if (
    clean.endsWith('triệu') ||
    clean.endsWith('trieu') ||
    clean.endsWith('tr') ||
    /^\d+(?:[.,]\d+)?m$/.test(clean)
  ) {
    const numPart = clean
      .replace(/triệu|trieu|tr|m$/, '')
      .trim()
      .replace(',', '.');
    const val = parseFloat(numPart);
    return Number.isFinite(val) ? Math.round(val * 1_000_000) : null;
  }

  if (
    clean.endsWith('k') ||
    clean.endsWith('ngàn') ||
    clean.endsWith('ngan') ||
    clean.endsWith('nghìn') ||
    clean.endsWith('nghin')
  ) {
    const numPart = clean
      .replace(/k|ngàn|ngan|nghìn|nghin/, '')
      .trim()
      .replace(',', '.');
    const val = parseFloat(numPart);
    return Number.isFinite(val) ? Math.round(val * 1_000) : null;
  }

  // Number with dots or commas as thousand separators, e.g. 8.884.879 or 8,884,879
  if (/^\d{1,3}(,\d{3})+\.\d+$/.test(clean)) {
    return Number(clean.replace(/,/g, ''));
  }
  if (/^\d{1,3}([.,]\d{3})+$/.test(clean)) {
    const digitsOnly = clean.replace(/[.,]/g, '');
    const val = parseInt(digitsOnly, 10);
    return Number.isSafeInteger(val) ? val : null;
  }

  // Decimal with comma, e.g. 21,4
  if (/^\d+,\d+$/.test(clean)) {
    const val = parseFloat(clean.replace(',', '.'));
    return Number.isFinite(val) ? val : null;
  }

  // Plain digits
  if (/^\d+(\.\d+)?$/.test(clean)) {
    const val = parseFloat(clean);
    return Number.isFinite(val) ? val : null;
  }

  return null;
}

// Extract and verify numbers in model response against an allowed set.
export function verifyNumbers(
  answerText: string,
  allowedNumbers: number[],
  toleranceBps = APPROX_TOLERANCE_BPS,
  strictSmallCounts = false,
): VerifyNumbersResult {
  const toleranceRatio = toleranceBps / 10000;
  const allowedSet = new Set(allowedNumbers);

  // Tokenize text into words/tokens
  const words = answerText
    .replace(/[()[\]{}!?:;/]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const extracted: number[] = [];
  const violations: number[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    // Check if preceded by month indicator, e.g. "tháng 12" -> skip
    if (
      i > 0 &&
      (words[i - 1].toLowerCase() === 'tháng' ||
        words[i - 1].toLowerCase() === 'thang')
    ) {
      continue;
    }

    // Try combining current word with next word for units like "2 triệu", "50 ngàn"
    let candidateStr = word.replace(/^[“”"'‘’.,]+|[“”"'‘’.,]+$/g, '');
    if (i + 1 < words.length) {
      const nextWord = words[i + 1].toLowerCase().replace(/[“”"'‘’.,]+$/g, '');
      const bareNumber = /^\$?\d+(?:[.,]\d+)*$/.test(candidateStr);
      if (
        bareNumber &&
        [
          'triệu',
          'trieu',
          'tr',
          'tỷ',
          'ty',
          'k',
          'ngàn',
          'ngan',
          'nghìn',
          'nghin',
        ].includes(nextWord)
      ) {
        candidateStr = `${candidateStr} ${nextWord}`;
      }
    }

    const parsed = parseVietnameseNumber(candidateStr);
    if (parsed === null) {
      continue;
    }

    // Advance index if two words were merged
    if (candidateStr.includes(' ')) {
      i++;
    }

    // Rule: always accept integers below 100 without currency or % suffix (bullet lists, counts)
    const isSmallCount =
      Number.isInteger(parsed) &&
      parsed >= 0 &&
      parsed < 100 &&
      !candidateStr.includes('%') &&
      !candidateStr.includes('đ') &&
      !candidateStr.includes('vnd') &&
      !candidateStr.includes('$') &&
      !candidateStr.includes('k') &&
      !candidateStr.includes('tr');

    if (!strictSmallCounts && isSmallCount && !allowedSet.has(parsed)) {
      continue;
    }

    extracted.push(parsed);

    // Check exact match
    let isAllowed = false;
    for (const allowed of allowedNumbers) {
      if (Math.abs(parsed - allowed) < 0.01) {
        isAllowed = true;
        break;
      }
    }

    // Check approximate match if preceded by approximation word within 3 tokens
    if (!isAllowed) {
      let isApprox = false;
      const startIdx = Math.max(0, i - 4);
      for (let k = startIdx; k < i; k++) {
        if (APPROX_WORDS.has(words[k].toLowerCase())) {
          isApprox = true;
          break;
        }
      }

      if (isApprox) {
        for (const allowed of allowedNumbers) {
          if (allowed !== 0) {
            const diffRatio = Math.abs(parsed - allowed) / Math.abs(allowed);
            if (diffRatio <= toleranceRatio) {
              isAllowed = true;
              break;
            }
          }
        }
      }
    }

    if (!isAllowed) {
      violations.push(parsed);
    }
  }

  return {
    isValid: violations.length === 0,
    violations,
    extracted,
  };
}
