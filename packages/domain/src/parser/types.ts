export type Confidence = 'high' | 'medium' | 'low';
export type ParseWarning =
  | 'ASSUMED_THOUSANDS'
  | 'NON_INTEGER_VND'
  | 'ZERO_AMOUNT'
  | 'AMOUNT_TOO_LARGE'
  | 'INVALID_DATE'
  | 'FUTURE_DATE'
  | 'MULTIPLE_AMOUNTS'
  | 'NO_AMOUNT'
  | 'AMBIGUOUS_KIND';

export interface ParsedEntry {
  kind:
    | 'expense'
    | 'income'
    | 'transfer'
    | 'debt_borrow'
    | 'debt_lend'
    | 'debt_repay_paid'
    | 'debt_repay_received'
    | 'unknown';
  kindConfidence: number;
  amount: {
    value: number | null;
    currency?: 'VND' | 'USD';
    confidence: Confidence;
    matchedText: string | null;
  };
  date: {
    value: string | null;
    confidence: Confidence;
    matchedText: string | null;
    defaulted: boolean;
  };
  occurredAtHint: string | null;
  categoryKey: string | null;
  categoryIdHint: string | null;
  categoryConfidence: number;
  walletHint: string | null;
  noteText: string;
  // Stable rule identifiers; the UI translates them when smart entry is added.
  explanation: string[];
}

export interface ParseResult {
  raw: string;
  candidates: ParsedEntry[];
  warnings: ParseWarning[];
}

export interface Span {
  start: number;
  end: number;
}
