import {
  classifyAdviceScope,
  parseEntry,
  type AdviceScopeDecision,
} from '@pfm/domain';
import { foldSearchText } from '@/data/search-text';

export type ChatRoute =
  | 'transaction'
  | 'advice'
  | 'ambiguous'
  | 'restricted'
  | 'out_of_scope'
  | 'empty';

export interface RouteChatResult {
  route: ChatRoute;
  parsed: ReturnType<typeof parseEntry>;
  scopeDecision: AdviceScopeDecision | null;
}

// Advice and hypothetical questions take priority over financial amounts, without an AI call.
export function routeChatInput(
  input: string,
  ctx: Parameters<typeof parseEntry>[1],
  adviceFollowup = false,
): RouteChatResult {
  const parsed = parseEntry(input, ctx);
  if (!input.trim()) {
    return { route: 'empty', parsed, scopeDecision: null };
  }

  const scopeDecision = classifyAdviceScope(input);

  // Strict scope policy priority
  if (scopeDecision.status === 'out_of_scope') {
    return { route: 'out_of_scope', parsed, scopeDecision };
  }
  if (scopeDecision.status === 'restricted') {
    return { route: 'restricted', parsed, scopeDecision };
  }
  if (scopeDecision.status === 'allowed') {
    return { route: 'advice', parsed, scopeDecision };
  }

  // If advice scope is ambiguous, check for transaction candidates
  const text = ` ${foldSearchText(input).replace(/[^a-z0-9?]+/g, ' ')} `;

  if (
    adviceFollowup &&
    !/\b(ghi giao dich|luu giao dich|them giao dich|ghi thu|ghi chi|tra no|tra tien)\b/.test(
      text,
    )
  ) {
    return { route: 'advice', parsed, scopeDecision };
  }

  if (/\b(khong|chua|huy)\b/.test(text)) {
    return { route: 'ambiguous', parsed, scopeDecision };
  }

  if (
    /\b(ghi giao dich|luu giao dich|them giao dich|ghi thu|ghi chi|tra no|tra tien)\b/.test(
      text,
    ) ||
    parsed.candidates.some(
      (candidate) =>
        candidate.amount.value !== null && candidate.kindConfidence >= 0.8,
    )
  ) {
    return { route: 'transaction', parsed, scopeDecision };
  }

  return { route: 'ambiguous', parsed, scopeDecision };
}
