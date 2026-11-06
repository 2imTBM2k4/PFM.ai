import type { Span } from './types';

// Preserve original offsets even for combining marks and surrogate pairs.
export function matchingText(text: string): {
  folded: string;
  span(start: number, end: number): Span;
} {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of text) {
    const token = character
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd');
    folded += token;
    for (let i = 0; i < token.length; i++) {
      starts.push(offset);
      ends.push(offset + character.length);
    }
    offset += character.length;
  }
  return {
    folded,
    span: (start, end) => ({ start: starts[start], end: ends[end - 1] }),
  };
}

export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function withoutSpans(
  text: string,
  spans: Span[],
  mask = false,
): string {
  const chars = text.split('');
  for (const { start, end } of spans) {
    for (let i = start; i < end; i++) chars[i] = ' ';
  }
  const value = chars.join('');
  return mask ? value : normalizeText(value);
}
