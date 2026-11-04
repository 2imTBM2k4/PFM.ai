import type { ParsedEntry, ParseWarning } from '../parser/types';

export type EntryKind = Exclude<ParsedEntry['kind'], 'unknown'>;
export interface Lexicon {
  version: number;
  ambiguousPhrases: string[];
  entries: {
    phrases: string[];
    kind: EntryKind;
    category: string | null;
    weight: number;
  }[];
  debtRepayPatterns: { pattern: string; kind: EntryKind }[];
  stopwords: string[];
  walletHints: Record<string, string>;
}
export type LearningIndex = readonly {
  tokenKey: string;
  kind: EntryKind;
  categoryKey: string | null;
  categoryId: string | null;
  hitCount: number;
  available: boolean;
}[];
export interface ClassifierContext {
  lexicon?: Lexicon;
  learned?: LearningIndex;
  knownCounterparties?: readonly string[];
}
export type Classification = Pick<
  ParsedEntry,
  | 'kind'
  | 'kindConfidence'
  | 'categoryKey'
  | 'categoryConfidence'
  | 'walletHint'
  | 'explanation'
  | 'categoryIdHint'
> & { warnings: ParseWarning[] };
