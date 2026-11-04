import { MAX_AMOUNT_VND } from '../money';
import { matchingText } from './text';
import type { Confidence, ParsedEntry, ParseWarning, Span } from './types';

const units: Record<string, { multiplier: bigint; confidence: Confidence }> = {
  k: { multiplier: 1000n, confidence: 'high' },
  nghin: { multiplier: 1000n, confidence: 'high' },
  ngan: { multiplier: 1000n, confidence: 'high' },
  tr: { multiplier: 1000000n, confidence: 'high' },
  trieu: { multiplier: 1000000n, confidence: 'high' },
  m: { multiplier: 1000000n, confidence: 'medium' },
  cu: { multiplier: 1000000n, confidence: 'medium' },
  ty: { multiplier: 1000000000n, confidence: 'high' },
  ti: { multiplier: 1000000000n, confidence: 'high' },
  lit: { multiplier: 100000n, confidence: 'low' },
  d: { multiplier: 1n, confidence: 'medium' },
  vnd: { multiplier: 1n, confidence: 'medium' },
  dong: { multiplier: 1n, confidence: 'medium' },
  '₫': { multiplier: 1n, confidence: 'medium' },
};

export interface AmountMatch {
  amount: ParsedEntry['amount'];
  span: Span;
  marked: boolean;
  quantity: boolean;
  warnings: ParseWarning[];
  rule: string;
}

// Parse complete numeric tokens; invalid separators must never yield a partial amount.
export function extractAmounts(text: string, defaultCurrency: 'VND' | 'USD' = 'VND'): AmountMatch[] {
  const view = matchingText(text);
  const results: AmountMatch[] = [];
  for (const match of view.folded.matchAll(/\d+(?:[.,]+\d+)*/g)) {
    const start = match.index;
    const literal = match[0];
    const afterNumber = start + literal.length;
    const previous = view.folded[start - 1] ?? '';
    if (
      /[a-z0-9.,/\-]/.test(previous) ||
      /\d{9}/.test(literal.replace(/[.,]/g, ' '))
    )
      continue;
    const suffix = view.folded.slice(afterNumber);
    const unitMatch =
      /^ ?(trieu|nghin|ngan|dong|dollars|dollar|usd|vnd|lit|tr|ty|ti|cu|k|m|d|₫)(\d+)?(?: (ruoi))?(?![a-z0-9])/.exec(
        suffix,
      );
    const validUnit =
      unitMatch && !(unitMatch[1] === 'm' && unitMatch[0].startsWith(' '))
        ? unitMatch
        : null;
    const dollarPrefix = /\$\s*$/.exec(view.folded.slice(0, start));
    const usdUnit = validUnit && /^(usd|dollar|dollars)$/.test(validUnit[1]);
    const isUsd = Boolean(dollarPrefix || usdUnit || (!validUnit && defaultCurrency === 'USD'));
    if (!validUnit && /^[a-z0-9/]/.test(suffix)) continue;
    const unit = validUnit ? units[validUnit[1]] : null;
    if (isUsd) {
      const normalized = literal.replace(/,/g, '');
      const valid = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(literal);
      const [whole, fraction = ''] = normalized.split('.');
      const cents = valid ? BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0') : 0n;
      const span = view.span(start - (dollarPrefix?.[0].length ?? 0), afterNumber + (validUnit?.[0].length ?? 0));
      results.push({
        amount: {
          value: valid && cents > 0n && cents <= BigInt(MAX_AMOUNT_VND) ? Number(cents) : null,
          currency: 'USD',
          confidence: valid ? 'high' : 'low',
          matchedText: text.slice(span.start, span.end),
        },
        span,
        marked: Boolean(dollarPrefix || usdUnit),
        quantity: false,
        warnings: !valid ? ['NON_INTEGER_VND'] : cents === 0n ? ['ZERO_AMOUNT'] : cents > BigInt(MAX_AMOUNT_VND) ? ['AMOUNT_TOO_LARGE'] : [],
        rule: 'amount.usd',
      });
      continue;
    }
    const grouped = /^\d{1,3}(?:[.,]\d{3})+$/.test(literal);
    const plain = /^\d+$/.test(literal);
    const decimal = /^(\d+)[.,](\d{1,2})$/.exec(literal);
    let confidence: Confidence = unit?.confidence ?? 'medium';
    const warnings: ParseWarning[] = [];
    let value: number | null = null;
    let rule = unit ? `amount.unit.${validUnit![1]}` : 'amount.bare';
    if (!plain && !grouped && !(decimal && unit && unit.multiplier > 1n)) {
      confidence = 'low';
      warnings.push('NON_INTEGER_VND');
      rule = 'amount.invalid_format';
    } else {
      const fraction = !grouped && decimal ? decimal[2] : '';
      const whole = grouped
        ? literal.replace(/[.,]/g, '')
        : decimal
          ? decimal[1]
          : literal;
      let denominator = 10n ** BigInt(fraction.length);
      let numerator = BigInt(whole) * denominator + BigInt(fraction || '0');
      const multiplier = unit?.multiplier ?? 1n;
      numerator *= multiplier;
      const compound = validUnit?.[2];
      if (compound) {
        const compoundScale = 10n ** BigInt(compound.length);
        numerator =
          numerator * compoundScale +
          BigInt(compound) * multiplier * denominator;
        denominator *= compoundScale;
      }
      if (validUnit?.[3]) {
        numerator = numerator * 2n + multiplier * denominator;
        denominator *= 2n;
      }
      if (!unit && plain && numerator < 1000n && numerator > 0n) {
        numerator *= 1000n;
        confidence = 'low';
        warnings.push('ASSUMED_THOUSANDS');
        rule = 'amount.assumed_thousands';
      } else if (
        unit?.multiplier === 1n &&
        (grouped || numerator >= 1000n * denominator)
      )
        confidence = 'high';
      const remainder = numerator % denominator;
      const rounded =
        numerator / denominator + (remainder * 2n >= denominator ? 1n : 0n);
      if (remainder !== 0n) {
        warnings.push('NON_INTEGER_VND');
        confidence = 'low';
      }
      if (numerator > BigInt(MAX_AMOUNT_VND) * denominator)
        warnings.push('AMOUNT_TOO_LARGE');
      else if (rounded === 0n) warnings.push('ZERO_AMOUNT');
      else value = Number(rounded);
    }
    const end = afterNumber + (validUnit?.[0].length ?? 0);
    const span = view.span(start, end);
    results.push({
      amount: {
        value,
        ...(validUnit && defaultCurrency === 'USD' ? { currency: 'VND' as const } : {}),
        confidence,
        matchedText: text.slice(span.start, span.end),
      },
      span,
      marked: !!unit,
      quantity: !unit && /^ (ly|cai)(?![a-z])/.test(suffix),
      warnings,
      rule,
    });
  }
  return results.some((result) => result.marked)
    ? results.filter((result) => !result.quantity)
    : results;
}
