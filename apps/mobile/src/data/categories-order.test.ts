import { describe, expect, it } from 'vitest';
import { orderCategoriesByParent, type CategoryRow } from './categories';

function makeCategory(overrides: Partial<CategoryRow> & { id: string; name: string }): CategoryRow {
  return {
    system_key: null,
    parent_id: null,
    kind: 'expense',
    is_fixed_cost: 0,
    icon: null,
    color: null,
    is_archived: 0,
    sort_order: 0,
    ...overrides,
  };
}

describe('orderCategoriesByParent', () => {
  it('groups newly added child categories directly under their parent', () => {
    const categories = [
      makeCategory({ id: 'food', name: 'Food', sort_order: 1 }),
      makeCategory({ id: 'transport', name: 'Transport', sort_order: 2 }),
      makeCategory({ id: 'coffee', name: 'Coffee', parent_id: 'food', sort_order: 99 }),
      makeCategory({ id: 'taxi', name: 'Taxi', parent_id: 'transport', sort_order: 100 }),
      makeCategory({ id: 'lunch', name: 'Lunch', parent_id: 'food', sort_order: 101 }),
    ];

    const ordered = orderCategoriesByParent(categories);
    expect(ordered.map((c) => c.id)).toEqual([
      'food',
      'coffee',
      'lunch',
      'transport',
      'taxi',
    ]);
  });

  it('keeps orphan children when parent is filtered out', () => {
    const categories = [
      makeCategory({ id: 'food', name: 'Food', sort_order: 1 }),
      makeCategory({ id: 'orphan', name: 'Archived parent child', parent_id: 'missing', sort_order: 2 }),
    ];

    const ordered = orderCategoriesByParent(categories);
    expect(ordered.map((c) => c.id)).toEqual(['food', 'orphan']);
  });
});
