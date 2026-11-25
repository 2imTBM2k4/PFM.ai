import { expect, it } from 'vitest';
import { isMoneyFact } from '@pfm/contracts';
import {
  buildAdviceContext,
  adviceContextToHistory,
  createInitialAdviceState,
} from './advice-context';
import { adviceStateFixture } from './advice-context.fixtures';

const options = { language: 'vi' as const, currency: 'VND' as const };
it('builds only the active scenario and evidence, excluding replaced and unrelated facts', () => {
  const { state, sourceMessages } = adviceStateFixture();
  if (!isMoneyFact(state.facts[0])) throw Error('Expected MoneyFact');
  state.facts.unshift({
    ...state.facts[0],
    id: 'income-old',
    amount: 12_000_000,
  });
  state.facts[1].supersedes_id = 'income-old';
  state.facts.push({ ...state.facts[0], id: 'unrelated' });
  const result = buildAdviceContext(
    state,
    'Mỗi tháng cần tiết kiệm bao nhiêu?',
    { ...options, sourceMessages },
  );
  expect(Object.keys(result).sort()).toEqual(
    [
      'activeFacts',
      'isIncomplete',
      'pendingFields',
      'revision',
      'scenario',
      'sessionId',
      'sourceEvidence',
      'wasTrimmed',
    ].sort(),
  );
  expect(result.activeFacts.map(({ id }) => id)).toEqual([
    'saved',
    'months',
    'goal',
    'expense',
    'income',
  ]);
  expect(result.scenario).toEqual(state.activeScenario);
  expect(result.sourceEvidence).toEqual(
    sourceMessages.map(({ id, text }) => ({ id, text })),
  );
  expect(result.isIncomplete).toBe(false);
  expect(adviceContextToHistory(result)).toEqual(
    sourceMessages.map(({ id, text }) => ({ id, text, role: 'user' })),
  );
});

it('keeps pending fields and an incomplete marker without guessing zero', () => {
  const { state, sourceMessages } = adviceStateFixture();
  state.activeScenario.savingsForGoal = { status: 'unknown' };
  state.pendingFields = ['savingsForGoal'];
  const result = buildAdviceContext(state, 'Cần dành bao nhiêu?', {
    ...options,
    sourceMessages,
  });
  expect(result.pendingFields).toEqual(['savingsForGoal']);
  expect(result.isIncomplete).toBe(true);
  expect(result.activeFacts.some(({ id }) => id === 'saved')).toBe(false);
  expect(result.sourceEvidence.some(({ id }) => id === 'm4')).toBe(false);
});

it('selects the newest 32 referenced facts without changing storage or sending unbounded scenario items', () => {
  const { state, sourceMessages } = adviceStateFixture();
  const expenseBase = state.facts[1];
  if (!isMoneyFact(expenseBase)) throw Error('Expected MoneyFact');
  const expenses = Array.from({ length: 40 }, (_, i) => ({
    ...expenseBase,
    id: `expense-${i}`,
  }));
  state.facts.push(...expenses);
  state.activeScenario.expenseItems = expenses;
  const result = buildAdviceContext(state, 'Cho tôi xem chi tiêu', {
    ...options,
    sourceMessages,
  });
  expect(result.activeFacts).toHaveLength(32);
  expect(result.activeFacts.map(({ id }) => id)).toEqual(
    Array.from({ length: 32 }, (_, i) => `expense-${39 - i}`),
  );
  expect(result.scenario.expenseItems).toHaveLength(32);
  expect(state.activeScenario.expenseItems).toHaveLength(40);
  expect(result.wasTrimmed).toBe(true);
  expect(result.isIncomplete).toBe(true);
  expect(() => adviceContextToHistory(result)).toThrow(
    'ADVICE_CONTEXT_TRIMMED',
  );
});

it('initializes an empty incomplete scenario without extracting user facts', () => {
  const state = createInitialAdviceState(
    'session-1',
    'Tôi muốn tiết kiệm 24 triệu trong 6 tháng',
    options,
  );
  expect(state.revision).toBe(0);
  expect(state.facts).toEqual([]);
  expect(state.activeScenario.topic).toBe('savings_plan');
  expect(state.activeScenario.goalTarget).toEqual({ status: 'unknown' });
  const result = buildAdviceContext(state, 'Tính giúp tôi', {
    ...options,
    sourceMessages: [],
  });
  expect(result.isIncomplete).toBe(true);
  expect(result.activeFacts).toEqual([]);
  expect(adviceContextToHistory(result)).toEqual([]);
});

it('keeps source negations, units and periods and never forwards unrelated history', () => {
  const { state, sourceMessages } = adviceStateFixture();
  sourceMessages[0].text =
    'Thu nhập 15 triệu mỗi tháng, không phải 15 triệu mỗi năm.';
  sourceMessages.push({
    ...sourceMessages[0],
    id: 'private-unrelated',
    text: 'Không liên quan.',
  });
  const result = buildAdviceContext(state, 'Tính giúp tôi', {
    ...options,
    sourceMessages,
  });
  expect(result.sourceEvidence[0].text).toContain('không phải');
  expect(result.sourceEvidence).toHaveLength(4);
});

it('refuses evidence exceeding the old wire limits rather than cutting required text', () => {
  const { state, sourceMessages } = adviceStateFixture();
  sourceMessages[0].text = 'Thu nhập 15 triệu/tháng. ' + 'x'.repeat(500);
  const result = buildAdviceContext(state, 'Tính giúp tôi', {
    ...options,
    sourceMessages,
  });
  expect(() => adviceContextToHistory(result)).toThrow(
    'ADVICE_CONTEXT_WIRE_LIMIT',
  );
});

it('refuses more than eight evidence messages and missing source evidence', () => {
  const { state, sourceMessages } = adviceStateFixture();
  const base = buildAdviceContext(state, 'Tính giúp tôi', {
    ...options,
    sourceMessages,
  });
  expect(() => adviceContextToHistory({ ...base, sourceEvidence: [] })).toThrow(
    'ADVICE_CONTEXT_SOURCE_MISSING',
  );
  expect(() =>
    adviceContextToHistory({
      ...base,
      sourceEvidence: [
        ...base.sourceEvidence,
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `extra-${i}`,
          text: 'Thu nhập 1 triệu',
        })),
      ],
    }),
  ).toThrow('ADVICE_CONTEXT_WIRE_LIMIT');
});

it('does not mutate existing facts or slots when the current message is a correction', () => {
  const { state, sourceMessages } = adviceStateFixture();
  const before = structuredClone(state);
  const result = buildAdviceContext(state, 'Thực ra thu nhập 12 triệu', {
    ...options,
    sourceMessages,
  });
  expect(result.scenario.income).toMatchObject({
    status: 'known',
    value: 15_000_000,
  });
  expect(state).toEqual(before);
});

it('does not send savings evidence into an unrelated independent budget question', () => {
  const { state, sourceMessages } = adviceStateFixture();
  expect(() =>
    buildAdviceContext(
      state,
      'Ngân sách Ăn uống tháng 11/2026 đã dùng bao nhiêu?',
      { ...options, sourceMessages },
    ),
  ).toThrow('ADVICE_CONTEXT_TOPIC_MISMATCH');
});
