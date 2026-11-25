import { expect, it } from 'vitest';
import { KNOWLEDGE_BASE, selectTopics } from './financial-knowledge';

it('keeps seven sourced educational topics without product prices', () => {
  expect(KNOWLEDGE_BASE).toHaveLength(7);
  expect(new Set(KNOWLEDGE_BASE.map((topic) => topic.id)).size).toBe(7);
  for (const topic of KNOWLEDGE_BASE) {
    expect(topic.source_urls.length).toBeGreaterThan(0);
    expect(topic.checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$|^pending$/);
    expect(topic.content.length).toBeGreaterThan(30);
  }
});
it('matches accents, caps and phrases deterministically and bounds results', () => {
  expect(selectTopics('quỹ dự phòng là gì')[0].id).toBe('emergency_fund');
  expect(selectTopics('QUY DU PHONG')).toEqual(selectTopics('quỹ dự phòng'));
  expect(selectTopics('tiết kiệm và đầu tư khác gì nhau')).toHaveLength(2);
  expect(selectTopics('thời tiết hôm nay')).toEqual([]);
  expect(selectTopics('quỹ dự phòng', 0)).toEqual([]);
  expect(
    selectTopics('tiết kiệm và đầu tư khác gì nhau', 99).length,
  ).toBeLessThanOrEqual(2);
});
