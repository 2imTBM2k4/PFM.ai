import type { Clock } from '../dates';
import { classifyEntry } from '../classifier';
import type { ClassifierContext } from '../classifier';
import { extractAmounts } from './amounts';
import { extractDate } from './dates';
import { normalizeText, withoutSpans } from './text';
import type { ParseResult, ParseWarning } from './types';

export type {
  Confidence,
  ParsedEntry,
  ParseResult,
  ParseWarning,
} from './types';

// Parse local text using an injected clock, phrase lexicon and confirmed learning only.
export function parseEntry(
  input: string,
  ctx: { clock: Clock; currency?: 'VND' | 'USD' } & ClassifierContext,
): ParseResult {
  const text = normalizeText(input);
  const date = extractDate(text, ctx.clock);
  const amounts = extractAmounts(withoutSpans(text, date.excluded, true), ctx.currency);
  const warnings: ParseWarning[] = [
    ...date.warnings,
    ...amounts.flatMap((match) => match.warnings),
  ];
  if (amounts.length > 1) warnings.push('MULTIPLE_AMOUNTS');
  if (amounts.length === 0) warnings.push('NO_AMOUNT');
  const matches = amounts.length ? amounts : [null];
  const candidates = matches.map((match) => {
    const noteText = withoutSpans(text, [
      ...date.removed,
      ...(match ? [match.span] : []),
    ]);
    const {
      warnings: classificationWarnings,
      explanation,
      ...classification
    } = classifyEntry(noteText, ctx);
    warnings.push(...classificationWarnings);
    return {
      ...classification,
      amount: match?.amount ?? {
        value: null,
        confidence: 'low',
        matchedText: null,
      },
      date: date.date,
      occurredAtHint: date.occurredAtHint,
      noteText,
      explanation: [
        date.rule,
        match?.rule ?? 'amount.not_found',
        ...explanation,
      ],
    };
  });
  return { raw: input, warnings: [...new Set(warnings)], candidates };
}
