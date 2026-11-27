import { classifyAdviceScope, type AdviceTopic } from './advice-scope';
import { addDays, validateDate } from './dates';
import { parseAdviceQuery } from './advice-query';
import { matchingText, normalizeText } from './parser/text';

export type SnapshotField =
  | 'monthly_income_avg'
  | 'monthly_expense_avg'
  | 'liquid_balance'
  | 'months_with_data';
export interface AdviceToolBinding {
  sessionId: string;
  scenarioId: string | null;
  stateRevision: number;
}
export type AdviceToolGrant =
  | {
      name: 'get_financial_snapshot';
      params: { months: number; fields: SnapshotField[] };
    }
  | {
      name: 'get_transactions';
      params: {
        from: string;
        to: string;
        kind: 'income' | 'expense' | null;
        category_id: string | null;
        limit: number;
      };
    }
  | {
      name: 'calculate_budget_status';
      params: { month: string; budget_id: string | null };
    }
  | { name: 'plan_savings_goal'; params: Record<string, never> }
  | {
      name: 'get_spending_breakdown';
      params: { from: string; to: string };
    }
  | {
      name: 'get_upcoming_obligations';
      params: { days_ahead: number };
    }
  | {
      name: 'get_savings_goals';
      params: { include_achieved: boolean };
    };
export interface AdviceToolPolicy extends AdviceToolBinding {
  grants: AdviceToolGrant[];
}
export interface AdviceToolPolicyInput extends AdviceToolBinding {
  question: string;
  today: string;
  categories?: { id: string; name: string }[];
  budgets?: { id: string; name: string }[];
  scenarioTopic?: AdviceTopic;
  requestedTools?: string[];
}
export type AdviceToolPolicyDecision =
  | { status: 'allowed'; policy: AdviceToolPolicy }
  | { status: 'needs_clarification'; fields: string[] }
  | {
      status: 'rejected';
      reason:
        'INVALID_INPUT' | 'OUT_OF_SCOPE' | 'RESTRICTED' | 'UNSUPPORTED_REQUEST';
    };

/** Resolve minimal read permissions; server PII checks must run independently first. */
export function resolveAdviceToolPolicy(
  input: AdviceToolPolicyInput,
): AdviceToolPolicyDecision {
  const clarify = (fields: string[]): AdviceToolPolicyDecision => ({
    status: 'needs_clarification',
    fields,
  });
  try {
    validateDate(input.today);
  } catch {
    return { status: 'rejected', reason: 'INVALID_INPUT' };
  }
  if (
    !input.question.trim() ||
    input.question.length > 500 ||
    !input.sessionId.trim() ||
    input.sessionId.length > 64 ||
    (input.scenarioId !== null &&
      (typeof input.scenarioId !== 'string' ||
        !input.scenarioId.trim() ||
        input.scenarioId.length > 64)) ||
    !Number.isSafeInteger(input.stateRevision) ||
    input.stateRevision < 0
  )
    return { status: 'rejected', reason: 'INVALID_INPUT' };
  const text = matchingText(normalizeText(input.question)).folded;
  const scope = classifyAdviceScope(input.question);
  if (scope.status === 'out_of_scope')
    return { status: 'rejected', reason: 'OUT_OF_SCOPE' };
  if (scope.status === 'restricted')
    return { status: 'rejected', reason: 'RESTRICTED' };
  if (
    /\b(?:dung|khong|chua)\s+(?:(?:can|muon|co)\s+)?(?:xem|doc|liet ke|kiem tra|tinh|cho biet|biet|hien thi|so du)\b/.test(
      text,
    )
  )
    return clarify(['toolIntent']);
  const grants: AdviceToolGrant[] = [];
  const inheritedSavings =
    scope.status === 'ambiguous' &&
    scope.reason === 'INSUFFICIENT_FINANCIAL_CONTEXT' &&
    input.scenarioTopic === 'savings_plan' &&
    Boolean(input.scenarioId) &&
    /\b(?:thuc ra|sua lai|dinh chinh|nham)\b/.test(text) &&
    /\btinh lai\b/.test(text);
  if (scope.status !== 'allowed' && !inheritedSavings)
    return clarify(['toolIntent']);
  if (
    scope.topic === 'savings_plan' ||
    inheritedSavings ||
    /\bmoi thang (?:can|phai) (?:de )?danh bao nhieu\b/.test(text)
  )
    grants.push({ name: 'plan_savings_goal', params: {} });
  if (scope.status === 'allowed' && /\btrung binh\b/.test(text)) {
    if ([...text.matchAll(/\btrung binh\b/g)].length !== 1)
      return clarify(['snapshotMonths']);
    const clause =
      text
        .split(/[!?;]|\.(?!\d)/)
        .find((part) => /\btrung binh\b/.test(part)) ?? '';
    const averageIndex = clause.indexOf('trung binh');
    const horizonText = clause
      .slice(averageIndex + 'trung binh'.length)
      .split(/\b(?:muc tieu|tiet kiem|muon du|de danh)\b/)[0];
    const months = horizonText.match(/\b(?:trong|qua)\s+(\d+)\s+thang\b/);
    if (!months || Number(months[1]) < 1 || Number(months[1]) > 12)
      return clarify(['snapshotMonths']);
    const fields: SnapshotField[] = [];
    // A stated amount is evidence, not permission to read that field's history.
    const subjects = clause
      .slice(0, averageIndex)
      .replace(
        /\b(?:thu nhap|chi tieu|tong chi)\s+(?:(?:cua toi|la)\s+)*\d[\d.,]*\s*(?:trieu|tr|dong|vnd|nghin|ngan|k)\b/g,
        '',
      );
    if (/\bthu nhap\b/.test(subjects)) fields.push('monthly_income_avg');
    if (/\b(?:chi tieu|tong chi)\b/.test(subjects))
      fields.push('monthly_expense_avg');
    if (fields.length)
      grants.push({
        name: 'get_financial_snapshot',
        params: { months: Number(months[1]), fields },
      });
  }
  if (/\bso du kha dung\b/.test(text)) {
    // Balance has no observation horizon; use the smallest supported read window.
    grants.push({
      name: 'get_financial_snapshot',
      params: { months: 1, fields: ['liquid_balance'] },
    });
  }
  const budget = text.match(
    /\bngan sach\s+(.*?)\bthang\s+(\d{1,2})\/(\d{4})\b/,
  );
  if (/\bngan sach\b/.test(text)) {
    if (!budget) return clarify(['budgetMonth']);
    const month = `${budget[3]}-${budget[2].padStart(2, '0')}`;
    try {
      validateDate(`${month}-01`);
    } catch {
      return clarify(['budgetMonth']);
    }
    const name = budget[1].trim();
    const matches = (input.budgets ?? []).filter(
      (item) => matchingText(normalizeText(item.name)).folded === name,
    );
    if (
      name &&
      name !== 'tat ca' &&
      (matches.length !== 1 ||
        !matches[0].id.trim() ||
        matches[0].id.length > 120)
    )
      return clarify(['budget_id']);
    grants.push({
      name: 'calculate_budget_status',
      params: { month, budget_id: matches[0]?.id ?? null },
    });
  }
  const list = text.match(
    /\b(?:liet ke|danh sach|(?:xem\s+)?\d+\s+khoan chi)\b/,
  );
  if (list) {
    const segment = text.slice(list.index);
    const count = segment.match(
      /\b(\d+)\s+(?:giao dich|khoan chi|khoan thu)\b/,
    );
    if (!count || Number(count[1]) < 1 || Number(count[1]) > 20)
      return clarify(['transactionLimit']);
    const dates = [...segment.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)].map(
      (match) => `${match[3]}-${match[2]}-${match[1]}`,
    );
    let range: { from: string; to: string } | null = null;
    if (dates.length === 2 && /\btu\b/.test(segment) && /\bden\b/.test(segment))
      range = { from: dates[0], to: dates[1] };
    else if (!dates.length) {
      const query = parseAdviceQuery(segment, [], input.today);
      if (!query.needsClarification) range = query.range;
    }
    try {
      if (!range || range.from > range.to) return clarify(['observationRange']);
      validateDate(range.from);
      validateDate(range.to);
    } catch {
      return clarify(['observationRange']);
    }
    const prefixCategory = segment
      .match(
        /\b(?:giao dich(?:\s+(?:chi|thu))?|khoan (?:chi|thu)|chi tieu)\s+(.+?)\s+(?:gan nhat|tu(?: ngay)?|trong)\b/,
      )?.[1]
      ?.trim();
    const suffixCategory = segment
      .match(/\b(?:danh muc|nhom)\s+(.+?)(?=[,.!?;]|$)/)?.[1]
      ?.trim();
    if (prefixCategory && suffixCategory && prefixCategory !== suffixCategory)
      return clarify(['category_id']);
    const categoryText = suffixCategory ?? prefixCategory;
    if (!categoryText && /\b(?:danh muc|nhom)\b/.test(segment))
      return clarify(['category_id']);
    const matches = (input.categories ?? []).filter(
      (item) => matchingText(normalizeText(item.name)).folded === categoryText,
    );
    if (
      categoryText &&
      (matches.length !== 1 ||
        !matches[0].id.trim() ||
        matches[0].id.length > 120)
    )
      return clarify(['category_id']);
    const hasExpense =
      /\b(?:giao dich chi|khoan chi|chi tieu|loai chi|chi chi)\b/.test(segment);
    const hasIncome = /\b(?:giao dich thu|khoan thu|loai thu|chi thu)\b/.test(
      segment,
    );
    if (hasExpense && hasIncome) return clarify(['transactionKind']);
    const kind = hasExpense ? 'expense' : hasIncome ? 'income' : null;
    grants.push({
      name: 'get_transactions',
      params: {
        ...range,
        kind,
        category_id: matches[0]?.id ?? null,
        limit: Number(count[1]),
      },
    });
  }
  if (
    scope.status === 'allowed' &&
    !list &&
    /\b(?:co cau chi tieu|phan tich chi tieu|tieu nhieu nhat|chi nhieu nhat|tong thu chi|dong tien|nhom chi|danh muc chi|chi tieu theo danh muc|chi bao nhieu cho|tieu gi nhieu)\b/.test(
      text,
    )
  ) {
    const dates = [...text.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)].map(
      (match) => `${match[3]}-${match[2]}-${match[1]}`,
    );
    let range: { from: string; to: string } | null = null;
    if (dates.length === 2 && /\btu\b/.test(text) && /\bden\b/.test(text))
      range = { from: dates[0], to: dates[1] };
    else if (!dates.length) {
      const query = parseAdviceQuery(text, [], input.today);
      if (!query.needsClarification) range = query.range;
    }
    try {
      if (!range || range.from > range.to || range.to > addDays(range.from, 365))
        return clarify(['observationRange']);
      validateDate(range.from);
      validateDate(range.to);
    } catch {
      return clarify(['observationRange']);
    }
    grants.push({
      name: 'get_spending_breakdown',
      params: range,
    });
  }
  if (
    scope.status === 'allowed' &&
    /\b(?:dinh ky|sap den han|hoa don sap|nghia vu|du no|khoan no|no phai tra|dang no|cho vay|khoan vay)\b/.test(
      text,
    )
  ) {
    const daysMatch = text.match(/\b(?:trong\s+)?(\d{1,2})\s+ngay(?:\s+toi)?\b/);
    const daysAhead = daysMatch ? Number(daysMatch[1]) : 30;
    if (daysAhead < 7 || daysAhead > 31) return clarify(['daysAhead']);
    grants.push({
      name: 'get_upcoming_obligations',
      params: { days_ahead: daysAhead },
    });
  }
  if (
    scope.status === 'allowed' &&
    /\b(?:tien do muc tieu|xem (?:cac )?muc tieu|danh sach muc tieu|cac muc tieu|muc tieu hien tai|muc tieu dang co|muc tieu trong app|quy tiet kiem cua toi)\b/.test(
      text,
    )
  ) {
    const includeAchieved = /\b(?:da dat|hoan thanh|tat ca)\b/.test(text);
    grants.push({
      name: 'get_savings_goals',
      params: { include_achieved: includeAchieved },
    });
  }
  const narrowed = input.requestedTools
    ? grants.filter((grant) => input.requestedTools!.includes(grant.name))
    : grants;
  if (grants.length && !narrowed.length)
    return { status: 'rejected', reason: 'UNSUPPORTED_REQUEST' };
  return narrowed.length
    ? {
        status: 'allowed',
        policy: {
          sessionId: input.sessionId,
          scenarioId: input.scenarioId,
          stateRevision: input.stateRevision,
          grants: narrowed,
        },
      }
    : clarify(['toolIntent']);
}

export interface AdviceToolPolicyCall {
  id: string;
  name: string;
  params: unknown;
}
export type AdviceToolBatchDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: 'TOOL_NOT_ALLOWED' | 'INVALID_PARAMS' | 'STATE_ERROR';
      deniedToolCallIds: string[];
    };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesGrant(grant: AdviceToolGrant, raw: unknown): boolean {
  if (!record(raw)) return false;
  const params = { ...raw };
  if (grant.name === 'get_transactions') {
    if (!Object.hasOwn(params, 'kind')) params.kind = null;
    if (!Object.hasOwn(params, 'category_id')) params.category_id = null;
    if (!Object.hasOwn(params, 'limit')) params.limit = 20;
  }
  if (
    grant.name === 'calculate_budget_status' &&
    !Object.hasOwn(params, 'budget_id')
  )
    params.budget_id = null;
  if (
    grant.name === 'get_upcoming_obligations' &&
    !Object.hasOwn(params, 'days_ahead')
  )
    params.days_ahead = 30;
  if (
    grant.name === 'get_savings_goals' &&
    !Object.hasOwn(params, 'include_achieved')
  )
    params.include_achieved = false;
  if (Object.keys(params).length !== Object.keys(grant.params).length)
    return false;
  for (const [key, expected] of Object.entries(grant.params)) {
    const actual = params[key];
    if (grant.name === 'get_financial_snapshot' && key === 'fields') {
      if (
        !Array.isArray(actual) ||
        !actual.length ||
        actual.length > 4 ||
        new Set(actual).size !== actual.length ||
        !actual.every((field) => grant.params.fields.includes(field))
      )
        return false;
    } else if (grant.name === 'get_transactions' && key === 'limit') {
      if (
        typeof actual !== 'number' ||
        !Number.isInteger(actual) ||
        actual < 1 ||
        actual > grant.params.limit
      )
        return false;
    } else if (grant.name === 'get_upcoming_obligations' && key === 'days_ahead') {
      if (
        typeof actual !== 'number' ||
        !Number.isInteger(actual) ||
        actual < 7 ||
        actual > grant.params.days_ahead
      )
        return false;
    } else if (grant.name === 'get_savings_goals' && key === 'include_achieved') {
      if (typeof actual !== 'boolean' || (actual && !grant.params.include_achieved))
        return false;
    } else if (actual !== expected) return false;
  }
  return true;
}

/** Deny every call in a batch before execution if any call exceeds its permission. */
export function checkAdviceToolBatch(
  policy: AdviceToolPolicy,
  binding: AdviceToolBinding,
  calls: AdviceToolPolicyCall[],
): AdviceToolBatchDecision {
  const deny = (
    code: 'TOOL_NOT_ALLOWED' | 'INVALID_PARAMS' | 'STATE_ERROR',
  ): AdviceToolBatchDecision => ({
    allowed: false,
    code,
    deniedToolCallIds: calls.map((call) => call.id),
  });
  if (
    policy.sessionId !== binding.sessionId ||
    policy.scenarioId !== binding.scenarioId ||
    policy.stateRevision !== binding.stateRevision
  )
    return deny('STATE_ERROR');
  if (
    !calls.length ||
    calls.length > 2 ||
    calls.some((call) => !call.id || call.id.length > 128) ||
    new Set(calls.map((call) => call.id)).size !== calls.length
  )
    return deny('INVALID_PARAMS');
  if (
    calls.some(
      (call) => !policy.grants.some((grant) => grant.name === call.name),
    )
  )
    return deny('TOOL_NOT_ALLOWED');
  if (
    calls.some(
      (call) =>
        !policy.grants.some(
          (grant) =>
            grant.name === call.name && matchesGrant(grant, call.params),
        ),
    )
  )
    return deny('TOOL_NOT_ALLOWED');
  return { allowed: true };
}
