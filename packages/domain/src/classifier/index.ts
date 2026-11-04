import seed from './lexicon.json';
import { matchingText, normalizeText, withoutSpans } from '../parser/text';
import { dateMentions } from '../parser/dates';
import type {
  Classification,
  ClassifierContext,
  EntryKind,
  Lexicon,
} from './types';

export type {
  Classification,
  ClassifierContext,
  EntryKind,
  LearningIndex,
  Lexicon,
} from './types';
// Trusted seed data is versioned and exercised by the normative tests.
export const DEFAULT_LEXICON = seed as Lexicon;
export const CONFIDENCE_HIGH = 0.8;
export const CONFIDENCE_LOW = 0.5;
const KIND_LABELS: Record<Classification['kind'], string> = {
  expense: 'chi tiêu',
  income: 'thu nhập',
  transfer: 'chuyển ví',
  debt_borrow: 'đi vay',
  debt_lend: 'cho vay',
  debt_repay_paid: 'trả nợ',
  debt_repay_received: 'nhận trả nợ',
  unknown: 'chưa xác định',
};
const WALLET_LABELS: Record<string, string> = {
  cash: 'tiền mặt',
  bank: 'ngân hàng',
  ewallet: 'ví điện tử',
};

interface Token {
  key: string;
  original: string;
}
interface Cue {
  kind: EntryKind;
  categoryKey: string | null;
  categoryId: string | null;
  categoryEvidence: boolean;
  weight: number;
  key: string;
}

function tokens(input: string): Token[] {
  const text = normalizeText(input);
  const view = matchingText(text);
  return [...view.folded.matchAll(/[a-z0-9]+/g)].map((match) => {
    const span = view.span(match.index, match.index + match[0].length);
    return { key: match[0], original: text.slice(span.start, span.end) };
  });
}

const ambiguousTokens = new Set(['tra', 'lai', 'be']);
const nonLearningTokens = new Set([
  'k',
  'm',
  'd',
  'vnd',
  'dong',
  'nghin',
  'ngan',
  'tr',
  'trieu',
  'cu',
  'ty',
  'ti',
  'lit',
  'ruoi',
  'ngay',
  'thang',
  'nam',
  'thu',
  'tuan',
  'truoc',
  'kia',
  'mai',
  'muon',
  'vay',
]);

// Learn each meaningful folded word once per confirmation, never amounts or dates.
export function learningTokens(
  noteText: string,
  lexicon = DEFAULT_LEXICON,
): string[] {
  const stopwords = new Set(lexicon.stopwords);
  const folded = matchingText(normalizeText(noteText)).folded;
  const clean = withoutSpans(
    folded,
    dateMentions(folded).map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    })),
  );
  return [
    ...new Set(
      tokens(clean)
        .map((token) => token.key)
        .filter(
          (key) =>
            /^[a-z]{2,}$/.test(key) &&
            !stopwords.has(key) &&
            !nonLearningTokens.has(key) &&
            !ambiguousTokens.has(key),
        ),
    ),
  ];
}

function phraseAt(words: Token[], phrase: string, start: number): boolean {
  const keys = phrase.split(' ');
  return keys.every((key, index) => words[start + index]?.key === key);
}

// Preserve explicit diacritics: “muốn”, “muộn” and “vậy” are not loan words.
function isLoanWord(word: Token): boolean {
  const original = word.original.toLowerCase();
  return word.key === 'muon'
    ? original === 'muon' || original === 'mượn'
    : word.key === 'vay' && original === 'vay';
}

function confidence(scores: { score: number; cues: Set<string> }[]): number {
  const [best, second] = scores;
  if (!best) return 0;
  const margin = (best.score - (second?.score ?? 0)) / best.score;
  return Math.min(
    1,
    0.5 + 0.3 * margin + 0.1 * Math.min(2, best.cues.size - 1),
  );
}

// Rank distinct targets while preventing repeated copies of one cue from inflating confidence.
function ranked(cues: Cue[], key: (cue: Cue) => string) {
  const groups = new Map<
    string,
    { key: string; score: number; cues: Set<string>; cue: Cue }
  >();
  for (const cue of cues) {
    const target = key(cue);
    const group = groups.get(target) ?? {
      key: target,
      score: 0,
      cues: new Set<string>(),
      cue,
    };
    if (!group.cues.has(cue.key)) group.score += cue.weight;
    group.cues.add(cue.key);
    groups.set(target, group);
  }
  return [...groups.values()].sort(
    (a, b) => b.score - a.score || a.key.localeCompare(b.key, 'en'),
  );
}

// Classify only from local phrases and confirmed mappings; wallet hints never select a wallet.
export function classifyEntry(
  noteText: string,
  ctx: ClassifierContext = {},
): Classification {
  const lexicon = ctx.lexicon ?? DEFAULT_LEXICON;
  const words = tokens(noteText);
  const explanation: string[] = [];
  const cues: Cue[] = [];
  const matches = lexicon.entries
    .flatMap((entry) =>
      entry.phrases.flatMap((phrase) => {
        const length = phrase.split(' ').length;
        if (length === 1 && ambiguousTokens.has(phrase)) return [];
        return words.flatMap((_, start) =>
          phraseAt(words, phrase, start) &&
          !words
            .slice(start, start + length)
            .some(
              (word) =>
                (word.key === 'muon' || word.key === 'vay') &&
                !isLoanWord(word),
            )
            ? [{ entry, phrase, start, length }]
            : [],
        );
      }),
    )
    .sort(
      (a, b) =>
        b.length - a.length ||
        b.entry.weight - a.entry.weight ||
        a.start - b.start,
    );
  const occupied = new Set<number>();
  for (const match of matches) {
    if (
      Array.from({ length: match.length }, (_, i) => match.start + i).some(
        (i) => occupied.has(i),
      )
    )
      continue;
    for (let i = 0; i < match.length; i++) occupied.add(match.start + i);
    const original = words
      .slice(match.start, match.start + match.length)
      .map((word) => word.original)
      .join(' ');
    cues.push({
      kind: match.entry.kind,
      categoryKey: match.entry.category,
      categoryId: null,
      categoryEvidence: match.entry.category !== null,
      weight: match.entry.weight,
      key: match.phrase,
    });
    explanation.push(
      `Cụm “${original}” gợi ý ${KIND_LABELS[match.entry.kind]}${match.entry.category ? ` / ${match.entry.category}` : ''}.`,
    );
  }

  const learned = ctx.learned ?? [];
  for (const token of learningTokens(noteText, lexicon)) {
    const rows = learned.filter(
      (row) =>
        row.tokenKey === token &&
        Number.isSafeInteger(row.hitCount) &&
        row.hitCount > 0,
    );
    const total = rows.reduce((sum, row) => sum + BigInt(row.hitCount), 0n);
    const winner = rows.find(
      (row) =>
        row.available &&
        row.hitCount >= 2 &&
        BigInt(row.hitCount) * 10n >= total * 7n,
    );
    if (!winner) continue;
    const weight =
      lexicon.entries.find(
        (entry) =>
          entry.kind === winner.kind && entry.category === winner.categoryKey,
      )?.weight ?? 1;
    cues.push({
      kind: winner.kind,
      categoryKey: winner.categoryKey,
      categoryId: winner.categoryId,
      categoryEvidence: true,
      weight: weight * 2,
      key: `learned:${token}`,
    });
    explanation.push(
      `Đã xác nhận “${token}” ${winner.hitCount}/${total} lần cho ${KIND_LABELS[winner.kind]}${winner.categoryKey ? ` / ${winner.categoryKey}` : ''}.`,
    );
  }

  const kinds = ranked(cues, (cue) => cue.kind);
  let kind: Classification['kind'] = kinds[0]?.cue.kind ?? 'expense';
  let kindConfidence = kinds.length ? confidence(kinds) : 0.4;
  const warnings: Classification['warnings'] = [];
  const debt = debtDirection(words, ctx, lexicon);
  const ambiguous = lexicon.ambiguousPhrases.some((phrase) =>
    words.some((_, i) => phraseAt(words, phrase, i)),
  );
  if (
    debt === null &&
    !ambiguous &&
    kinds.length > 1 &&
    kinds[0].score === kinds[1].score
  ) {
    kind = 'unknown';
    kindConfidence = 0;
    warnings.push('AMBIGUOUS_KIND');
    explanation.push('Các loại giao dịch có điểm bằng nhau; cần chọn lại.');
  }
  if (!kinds.length && debt === null && !ambiguous)
    explanation.push(
      'Chưa có dấu hiệu loại giao dịch; tạm gợi ý chi tiêu với độ tin cậy 0.4.',
    );
  if (debt !== null || ambiguous) {
    kind = ambiguous ? 'unknown' : debt!;
    kindConfidence = kind === 'unknown' ? 0 : 0.95;
    if (kind === 'unknown') warnings.push('AMBIGUOUS_KIND');
    explanation.push(
      kind === 'unknown'
        ? 'Chưa xác định được chiều trả/nhận nợ hoặc tiền hoàn lại; cần chọn loại giao dịch.'
        : `Hướng cho mượn/vay hoặc vị trí tên đã lưu cạnh “trả nợ” xác định ${KIND_LABELS[kind]}.`,
    );
  }
  const categories = ranked(
    cues.filter((cue) => cue.kind === kind && cue.categoryEvidence),
    (cue) =>
      cue.categoryKey ?? (cue.categoryId ? `id:${cue.categoryId}` : 'none'),
  );
  const category =
    categories.length &&
    (categories.length === 1 || categories[0].score > categories[1].score)
      ? categories[0].cue
      : null;
  const hints = new Set<string>();
  for (const [phrase, hint] of Object.entries(lexicon.walletHints)) {
    if (words.some((_, start) => phraseAt(words, phrase, start))) {
      hints.add(hint);
      explanation.push(
        `“${phrase}” chỉ gợi ý loại ví ${WALLET_LABELS[hint] ?? hint}; chưa chọn ví.`,
      );
    }
  }
  const financialCategory = kind === 'expense' || kind === 'income';
  return {
    kind,
    kindConfidence,
    categoryKey: financialCategory ? (category?.categoryKey ?? null) : null,
    categoryIdHint: financialCategory ? (category?.categoryId ?? null) : null,
    categoryConfidence:
      financialCategory && category ? confidence(categories) : 0,
    walletHint: hints.size === 1 ? [...hints][0] : null,
    explanation,
    warnings: [...new Set(warnings)],
  };
}

// Names must already exist locally; unknown or conflicting directions stay explicit.
function debtDirection(
  words: Token[],
  ctx: ClassifierContext,
  lexicon: Lexicon,
): Classification['kind'] | null {
  const directions = new Set<EntryKind>();
  let repayment = false;
  for (const rule of lexicon.debtRepayPatterns) {
    const phrase = rule.pattern.replace('<name>', '').trim();
    const before = rule.pattern.startsWith('<name>');
    for (let i = 0; i < words.length; i++) {
      if (!phraseAt(words, phrase, i)) continue;
      repayment = true;
      for (const name of ctx.knownCounterparties ?? []) {
        const normalized = tokens(name)
          .map((token) => token.key)
          .join(' ');
        if (!normalized) continue;
        const start = before
          ? i - normalized.split(' ').length
          : i + phrase.split(' ').length;
        if (start >= 0 && phraseAt(words, normalized, start))
          directions.add(rule.kind);
      }
    }
  }
  if (repayment) return directions.size === 1 ? [...directions][0] : 'unknown';
  const loan = words.findIndex(isLoanWord);
  if (loan >= 0)
    return words.slice(0, loan).some((word) => word.key === 'cho')
      ? 'debt_lend'
      : 'debt_borrow';
  return null;
}
