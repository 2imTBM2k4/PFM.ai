import type { ReceiptData } from '@pfm/contracts';
import { classifyEntry, type ParseResult } from '@pfm/domain';

export function receiptToParseResult(receipt: ReceiptData): ParseResult {
  const merchant = receipt.merchant?.trim() ?? '';
  const category = classifyEntry(merchant);
  const total = receipt.totalMinor !== undefined ? receipt.totalMinor : receipt.totalVnd ?? null;
  const currency = receipt.totalMinor !== undefined ? receipt.currency ?? 'VND' : 'VND';
  return {
    raw: merchant ? `Hóa đơn: ${merchant}` : 'Hóa đơn',
    warnings: total === null ? ['NO_AMOUNT'] : [],
    candidates: [{
      kind: 'expense',
      kindConfidence: 1,
      amount: { value: total, currency, confidence: total === null ? 'low' : 'medium', matchedText: null },
      date: { value: receipt.occurredOn, confidence: receipt.occurredOn === null ? 'low' : 'medium', matchedText: null, defaulted: false },
      occurredAtHint: null,
      categoryKey: receipt.categoryKey ?? (category.kind === 'expense' && category.categoryConfidence >= 0.8 ? category.categoryKey : null),
      categoryIdHint: receipt.categoryKey ? null : category.kind === 'expense' && category.categoryConfidence >= 0.8 ? category.categoryIdHint : null,
      categoryConfidence: receipt.categoryKey ? 0.8 : category.kind === 'expense' ? category.categoryConfidence : 0,
      walletHint: null,
      noteText: merchant,
      explanation: [],
    }],
  };
}
