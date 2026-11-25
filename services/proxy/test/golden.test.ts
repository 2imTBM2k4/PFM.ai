import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  AdviceDataGroupSchema,
  AdvicePlanSelectionSchema,
  type ConversationFact,
} from '@pfm/contracts';
import {
  classifyFinancialIntent,
  parseEntry,
  type AdviceInputContext,
} from '@pfm/domain';
import { buildApp } from '../src/app';
import { quotaService } from '../src/services/quota-service';
import { rateLimitService } from '../src/services/rate-limit-service';
import { upstreamAiService } from '../src/services/upstream-ai';

const databaseAccess = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Draft generation must not access the database');
  }),
);
vi.mock('@/data/connection', () => ({ withDatabase: databaseAccess }));

interface Fixture {
  id: string;
  input_messages: { id: string; role: 'user' | 'assistant'; text: string }[];
  app_context: Partial<AdviceInputContext> & {
    open_draft?: string;
    receipt?: unknown;
  };
  model_facts?: Partial<ConversationFact>[];
  expected_conversationFacts: Partial<ConversationFact>[];
  metrics?: string[];
  expected_metrics?: Record<string, number>;
  groups?: unknown[];
  dataGroups?: unknown[];
  model_answer?: string;
  expected_intent: string;
  expected_answer_constraints: {
    contains?: string[];
    excludes?: string[];
    status?: number;
    code?: string;
    draft_amounts?: string[];
    draft_action?: string;
    unconfirmed_field?: string;
    saved?: boolean;
  };
}
const fixtures = JSON.parse(
  readFileSync(
    new URL('./fixtures/financial-assistant-golden.json', import.meta.url),
    'utf8',
  ),
) as Fixture[];
const requestId = 'c47ac10b-58cc-4372-a567-0e02b2c3d470';
const clock = {
  now: () => new Date('2026-11-16T09:00:00+07:00'),
  timeZone: 'Asia/Ho_Chi_Minh',
};
const mobile = '../../../apps/mobile/src';
const { routeChatInput } = await import(`${mobile}/features/chat/intent.ts`);
const { makeEntryDrafts, applyDraftMessage, unconfirmedDraftFields } =
  await import(`${mobile}/features/quick-entry/draft.ts`);
const { receiptToParseResult } = await import(
  `${mobile}/features/quick-entry/receipt.ts`
);
const { resolveAdviceMetrics } = await import(
  `${mobile}/services/advice-metrics.ts`
);
const references = {
  wallets: [],
  categories: [],
  debts: [],
  lastWalletId: null,
};

beforeEach(() => {
  databaseAccess.mockClear();
  quotaService.resetForTesting();
  rateLimitService.resetForTesting();
});
afterEach(() => {
  upstreamAiService.setFetchForTesting(async () => {
    throw new Error('Unexpected model call after golden case');
  });
});

it('contains exactly fifteen distinct cases', () => {
  expect(fixtures).toHaveLength(15);
  expect(new Set(fixtures.map((value) => value.id)).size).toBe(15);
});
it('runs the complete draft correction and cancellation sequence locally without a model call', async () => {
  let modelCalls = 0;
  upstreamAiService.setFetchForTesting(async () => {
    modelCalls++;
    throw new Error('Unexpected remote call');
  });
  const routed = routeChatInput('Ghi chi ăn sáng 30k', { clock });
  expect(routed.route).toBe('transaction');
  const initial = makeEntryDrafts(
    routed.parsed,
    references,
    () => 'local-draft',
  );
  const corrected = applyDraftMessage('à nhầm 35k', initial, clock);
  expect(corrected.action).toBe('correct');
  if (corrected.action !== 'correct')
    throw new Error('Expected a corrected draft');
  expect(corrected.drafts[0].amount).toBe('35.000');
  expect(corrected.drafts[0].amountConfirmed).toBe(false);
  expect(initial[0].amount).toBe('30.000');
  expect(applyDraftMessage('thôi để sau', corrected.drafts, clock)).toEqual({
    action: 'cancel',
  });
  expect(modelCalls).toBe(0);
  expect(databaseAccess).not.toHaveBeenCalled();
});
for (const fixture of fixtures)
  it(`golden ${fixture.id}`, async () => {
    const current = fixture.input_messages.at(-1)!;
    const constraints = fixture.expected_answer_constraints;
    const app = buildApp();
    let calls = 0;
    const records: string[] = [];
    try {
      const draftOnly =
        fixture.expected_intent === 'entry' || !!fixture.app_context.open_draft;
      if (draftOnly) {
        upstreamAiService.setFetchForTesting(async () => {
          calls++;
          throw new Error('Drafts cannot call the model');
        });
        let drafts;
        if (fixture.app_context.receipt) {
          drafts = makeEntryDrafts(
            receiptToParseResult(fixture.app_context.receipt),
            references,
            () => 'golden-id',
          );
        } else if (fixture.app_context.open_draft) {
          const initial = makeEntryDrafts(
            parseEntry(fixture.app_context.open_draft, { clock }),
            references,
            () => 'golden-id',
          );
          const intent = classifyFinancialIntent(current.text, {
            draftOpen: true,
          });
          expect(intent.intent).toBe(fixture.expected_intent);
          const changed = applyDraftMessage(current.text, initial, clock);
          expect(changed.action).toBe(constraints.draft_action);
          drafts = changed.action === 'correct' ? changed.drafts : [];
        } else {
          const route = routeChatInput(current.text, { clock });
          expect(route.route).toBe('transaction');
          drafts = makeEntryDrafts(route.parsed, references, () => 'golden-id');
        }
        if (fixture.expected_intent === 'entry')
          expect(
            drafts.every((draft: { kind: string }) => draft.kind === 'expense'),
          ).toBe(true);
        if (constraints.draft_amounts)
          expect(
            drafts.map((draft: { amount: string }) => draft.amount),
          ).toEqual(constraints.draft_amounts);
        if (constraints.unconfirmed_field)
          expect(unconfirmedDraftFields(drafts[0])).toContain(
            constraints.unconfirmed_field,
          );
        expect(calls).toBe(0);
        expect(databaseAccess).not.toHaveBeenCalled();
        expect(fixture.expected_conversationFacts).toEqual([]);
        return;
      }
      const route = routeChatInput(
        current.text,
        { clock },
        fixture.input_messages.length > 1,
      );
      expect(route.route).toBe(fixture.expected_intent);
      const modelFacts = (fixture.model_facts ?? []).map((fact) => ({
        source_message_id: requestId,
        currency: 'VND',
        period: 'monthly',
        source: 'user_statement',
        mode: 'actual',
        ...fact,
      }));
      const selection = AdvicePlanSelectionSchema.parse({
        metrics: fixture.metrics ?? [],
        scenario: { conversationFacts: modelFacts },
        groups: fixture.groups ?? [],
      });
      upstreamAiService.setFetchForTesting(async (_url, options) => {
        const body = JSON.parse(options!.body as string);
        const output =
          calls++ === 0 ? JSON.stringify(selection) : fixture.model_answer;
        records.push(body.messages[0].content);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: output } }] }),
        );
      });
      const payload = {
        requestId,
        question: current.text,
        history: fixture.input_messages.slice(0, -1),
      };
      const headers = { 'x-device-id': fixture.id };
      const plan = await app.inject({
        method: 'POST',
        url: '/v1/advice/plan',
        headers,
        payload,
      });
      expect(plan.statusCode).toBe(200);
      const actualSelection = AdvicePlanSelectionSchema.parse(
        plan.json().selection,
      );
      expect(actualSelection.scenario.conversationFacts).toEqual(
        fixture.expected_conversationFacts,
      );
      let results = {};
      if (fixture.expected_metrics) {
        const resolved = resolveAdviceMetrics(null, actualSelection, {
          period: { kind: 'month', from: '2026-11-01', to: '2026-11-30' },
          mode: 'actual',
          currency: 'VND',
          ...fixture.app_context,
        });
        expect(resolved.ok).toBe(true);
        if (!resolved.ok)
          throw new Error(
            `Clarification required: ${resolved.needsClarification.join(',')}`,
          );
        results = resolved.result.metrics;
        expect(results).toEqual(fixture.expected_metrics);
      }
      const complete = await app.inject({
        method: 'POST',
        url: '/v1/advice/complete',
        headers,
        payload: {
          ...payload,
          planToken: plan.json().planToken,
          results,
          ...(fixture.dataGroups
            ? {
                dataGroups: fixture.dataGroups.map((group) =>
                  AdviceDataGroupSchema.parse(group),
                ),
              }
            : {}),
        },
      });
      expect(complete.statusCode).toBe(constraints.status ?? 200);
      if (constraints.code) expect(complete.json().code).toBe(constraints.code);
      if (fixture.id.startsWith('13')) {
        const blocked = await app.inject({
          method: 'POST',
          url: '/v1/advice/plan',
          headers,
          payload: {
            ...payload,
            requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d471',
          },
        });
        expect(blocked.statusCode).toBe(429);
        expect(calls).toBe(2);
      }
      const answer = complete.json().answer ?? '';
      for (const value of constraints.contains ?? [])
        expect(answer).toContain(value);
      for (const value of constraints.excludes ?? [])
        expect(answer).not.toContain(value);
      if (fixture.id.startsWith('15')) {
        expect(records.at(-1)).toContain('untrusted data');
        expect(complete.json()).not.toHaveProperty('tool_calls');
      }
    } finally {
      await app.close();
    }
  });
