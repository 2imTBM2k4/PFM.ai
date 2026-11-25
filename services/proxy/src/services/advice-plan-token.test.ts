import { expect, it } from 'vitest';
import type { AdvicePlanSelection } from '@pfm/contracts';
import {
  createAdvicePlanToken,
  verifyAdvicePlanToken,
} from './advice-plan-token';

const selection: AdvicePlanSelection = {
  metrics: [],
  scenario: {
    conversationFacts: [
      {
        id: 'fact',
        source_message_id: 'message',
        kind: 'income',
        amount: 15000000,
        currency: 'VND',
        period: 'monthly',
        source: 'user_statement',
        mode: 'actual',
      },
    ],
  },
};

it('preserves reserved savings and rejects tampering after signing', () => {
  const reserved: AdvicePlanSelection = {
    metrics: ['savings_required_monthly'],
    scenario: { savingsForGoal: 0 },
  };
  const token = createAdvicePlanToken(
    'request',
    'question',
    'device',
    reserved,
  );
  expect(verifyAdvicePlanToken(token, 'request', 'question', 'device')).toEqual(
    reserved,
  );
  const [payload, signature] = token.split('.');
  const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
  forged.selection.scenario.savingsForGoal = 1000000;
  const altered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
  expect(
    verifyAdvicePlanToken(altered, 'request', 'question', 'device'),
  ).toBeNull();
});

it('binds conversation facts and their sources to the signed question, history and device', () => {
  const history = [{ id: 'message', role: 'user', text: 'Lương 15 triệu' }];
  const token = createAdvicePlanToken(
    'request',
    'Tư vấn tiết kiệm',
    'device-a',
    selection,
    history,
  );
  expect(
    verifyAdvicePlanToken(
      token,
      'request',
      'Tư vấn tiết kiệm',
      'device-a',
      history,
    ),
  ).toEqual(selection);
  expect(
    verifyAdvicePlanToken(
      token,
      'request',
      'Tư vấn tiết kiệm',
      'device-b',
      history,
    ),
  ).toBeNull();
  expect(
    verifyAdvicePlanToken(token, 'request', 'Tư vấn tiết kiệm', 'device-a', []),
  ).toBeNull();
  const [payload, signature] = token.split('.');
  const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
  forged.selection.scenario.conversationFacts[0].amount = 99000000;
  const altered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
  expect(
    verifyAdvicePlanToken(
      altered,
      'request',
      'Tư vấn tiết kiệm',
      'device-a',
      history,
    ),
  ).toBeNull();
});

it('does not issue a plan token that its existing size boundary would refuse', () => {
  const oversized: AdvicePlanSelection = {
    metrics: [],
    scenario: {
      conversationFacts: Array.from({ length: 32 }, (_, index) => ({
        ...selection.scenario.conversationFacts![0],
        id: `fact-${index}`,
      })),
    },
  };
  expect(() =>
    createAdvicePlanToken('request', 'question', 'device', oversized),
  ).toThrow();
});
