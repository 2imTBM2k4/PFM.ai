import { describe, expect, it } from 'vitest';
import type { AdviceToolPolicy } from '@pfm/domain';
import {
  inspectTurnTranscript,
  type AgentMessage,
} from './agent-turn-protocol';

function transcript(
  name: string,
  params: unknown,
  data: unknown,
): AgentMessage[] {
  return [
    { role: 'user', content: 'Câu hỏi tài chính' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name, arguments: JSON.stringify(params) },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call-1',
      content: JSON.stringify({
        status: 'ok',
        data,
        stateRevision: 1,
        calculationVersion: 1,
      }),
    },
  ];
}
const binding = { sessionId: 's', scenarioId: 'scenario', stateRevision: 1 };
const transactionParams = {
  from: '2026-11-01',
  to: '2026-11-16',
  kind: 'expense' as const,
  category_id: 'food',
  limit: 3,
};
const transaction = {
  id: 'transaction',
  date: '2026-11-15',
  amount: 50000,
  currency: 'VND',
  kind: 'expense',
  category_id: 'food',
};
const budget = {
  id: 'budget',
  category_id: 'food',
  limit_amount: 3000000,
  spent_amount: 3500000,
  remaining_amount: 0,
  overspent_amount: 500000,
};
describe('server validation of bounded local tool results', () => {
  it('accepts a transaction result within the granted read bounds', () => {
    const policy: AdviceToolPolicy = {
      ...binding,
      grants: [{ name: 'get_transactions', params: transactionParams }],
    };
    expect(
      inspectTurnTranscript(
        transcript('get_transactions', transactionParams, {
          transactions: [transaction],
          truncated: false,
        }),
        policy,
        true,
      ).successfulTools,
    ).toBe(1);
  });
  it.each([
    { date: '2026-10-31' },
    { date: '2026-11-17' },
    { category_id: 'other' },
    { kind: 'income' },
    { note: 'private note' },
    { amount: 0.1 },
  ])(
    'rejects transaction data outside the bounds or whitelist: %j',
    (overrides) => {
      const policy: AdviceToolPolicy = {
        ...binding,
        grants: [{ name: 'get_transactions', params: transactionParams }],
      };
      expect(() =>
        inspectTurnTranscript(
          transcript('get_transactions', transactionParams, {
            transactions: [{ ...transaction, ...overrides }],
            truncated: false,
          }),
          policy,
          true,
        ),
      ).toThrow();
    },
  );
  it('rejects more transactions than the granted limit', () => {
    const policy: AdviceToolPolicy = {
      ...binding,
      grants: [{ name: 'get_transactions', params: transactionParams }],
    };
    expect(() =>
      inspectTurnTranscript(
        transcript('get_transactions', transactionParams, {
          transactions: [transaction, transaction, transaction, transaction],
          truncated: true,
        }),
        policy,
        true,
      ),
    ).toThrow();
  });
  it('accepts actual budget overspending without imposing an unrelated 32-fact limit', () => {
    const params = { month: '2026-11', budget_id: null };
    const policy: AdviceToolPolicy = {
      ...binding,
      grants: [{ name: 'calculate_budget_status', params }],
    };
    expect(
      inspectTurnTranscript(
        transcript('calculate_budget_status', params, {
          budgets: Array.from({ length: 33 }, (_, index) => ({
            ...budget,
            id: `budget-${index}`,
          })),
        }),
        policy,
        true,
      ).successfulTools,
    ).toBe(1);
  });
  it('rejects a different budget when a specific budget was granted', () => {
    const params = { month: '2026-11', budget_id: 'other' };
    const policy: AdviceToolPolicy = {
      ...binding,
      grants: [{ name: 'calculate_budget_status', params }],
    };
    expect(() =>
      inspectTurnTranscript(
        transcript('calculate_budget_status', params, { budgets: [budget] }),
        policy,
        true,
      ),
    ).toThrow();
  });
  it('accepts only the requested snapshot indicators, including missing averages', () => {
    const params = { months: 6, fields: ['monthly_income_avg' as const] };
    const policy: AdviceToolPolicy = {
      ...binding,
      grants: [{ name: 'get_financial_snapshot', params }],
    };
    const data = {
      indicators: { monthly_income_avg: null },
      period: { from: '2026-05-01', to: '2026-10-31' },
      currency: 'VND',
      dataQuality: 'insufficient',
    };
    expect(
      inspectTurnTranscript(
        transcript('get_financial_snapshot', params, data),
        policy,
        true,
      ).successfulTools,
    ).toBe(1);
    expect(() =>
      inspectTurnTranscript(
        transcript('get_financial_snapshot', params, {
          ...data,
          indicators: { monthly_income_avg: null, liquid_balance: 100 },
        }),
        policy,
        true,
      ),
    ).toThrow();
  });
});
