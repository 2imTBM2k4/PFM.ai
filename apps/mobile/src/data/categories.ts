import { CategoryInputSchema, type CategoryInput } from '@pfm/contracts';
import type { Database, Queries } from './migrate';

export const CATEGORY_ICONS = [
  'tag',
  'food',
  'home',
  'car',
  'cart',
  'cash',
] as const;
export const CATEGORY_COLORS = [
  '#195DB7',
  '#287D45',
  '#A35319',
  '#8855A5',
] as const;

export interface CategoryRow {
  id: string;
  system_key: string | null;
  parent_id: string | null;
  name: string;
  kind: 'expense' | 'income';
  is_fixed_cost: number;
  icon: string | null;
  color: string | null;
  is_archived: number;
  sort_order: number;
}

/**
 * Orders categories so each parent is immediately followed by its child categories,
 * preserving relative sort_order and appending any orphan children safely at the end.
 */
export function orderCategoriesByParent(
  categories: readonly CategoryRow[],
): CategoryRow[] {
  const byId = new Set(categories.map((category) => category.id));
  const childrenByParent = new Map<string, CategoryRow[]>();
  const topLevel: CategoryRow[] = [];
  const orphans: CategoryRow[] = [];

  for (const category of categories) {
    if (!category.parent_id) {
      topLevel.push(category);
    } else if (byId.has(category.parent_id)) {
      const group = childrenByParent.get(category.parent_id) ?? [];
      group.push(category);
      childrenByParent.set(category.parent_id, group);
    } else {
      orphans.push(category);
    }
  }

  const ordered: CategoryRow[] = [];
  for (const parent of topLevel) {
    ordered.push(parent);
    const children = childrenByParent.get(parent.id);
    if (children) {
      ordered.push(...children);
    }
  }
  ordered.push(...orphans);
  return ordered;
}

export function listCategories(db: Queries, includeArchived = false) {
  return db.getAllAsync<CategoryRow>(
    'SELECT * FROM categories WHERE (? = 1 OR is_archived = 0) ORDER BY sort_order, id',
    includeArchived ? 1 : 0,
  );
}

export async function requireActiveCategory(
  db: Queries,
  id: string,
  kind: CategoryRow['kind'],
) {
  const category = await db.getFirstAsync<CategoryRow>(
    'SELECT * FROM categories WHERE id = ?',
    id,
  );
  if (!category) throw new Error('CATEGORY_NOT_FOUND');
  if (category.is_archived) throw new Error('CATEGORY_ARCHIVED');
  if (category.kind !== kind) throw new Error('CATEGORY_KIND');
  if (category.parent_id) {
    const parent = await db.getFirstAsync<CategoryRow>(
      'SELECT * FROM categories WHERE id = ?',
      category.parent_id,
    );
    if (!parent || parent.is_archived) throw new Error('CATEGORY_ARCHIVED');
    if (parent.kind !== kind) throw new Error('CATEGORY_KIND');
  }
  return category;
}

function validateCategory(input: CategoryInput) {
  const category = CategoryInputSchema.parse(input);
  if (
    category.icon !== null &&
    !CATEGORY_ICONS.some((icon) => icon === category.icon)
  )
    throw new Error('CATEGORY_ICON');
  if (
    category.color !== null &&
    !CATEGORY_COLORS.some((color) => color === category.color)
  )
    throw new Error('CATEGORY_COLOR');
  return category;
}

export async function createCategory(
  db: Database,
  id: string,
  input: CategoryInput,
  timestamp: string,
) {
  const category = validateCategory(input);
  await db.transaction(async (transaction) => {
    if (category.parentId) {
      const parent = await requireActiveCategory(
        transaction,
        category.parentId,
        category.kind,
      );
      if (parent.parent_id) throw new Error('CATEGORY_DEPTH');
    }
    await transaction.runAsync(
      `INSERT INTO categories (id,name,kind,parent_id,is_fixed_cost,icon,color,sort_order,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM categories),?,?)`,
      id,
      category.name,
      category.kind,
      category.parentId,
      category.isFixedCost ? 1 : 0,
      category.icon,
      category.color,
      timestamp,
      timestamp,
    );
  });
}

export type CategoryChanges = Pick<
  CategoryInput,
  'name' | 'isFixedCost' | 'icon' | 'color'
>;

export async function updateCategory(
  db: Database,
  id: string,
  changes: CategoryChanges,
  timestamp: string,
) {
  await db.transaction(async (transaction) => {
    const current = await transaction.getFirstAsync<CategoryRow>(
      'SELECT * FROM categories WHERE id = ?',
      id,
    );
    if (!current) throw new Error('CATEGORY_NOT_FOUND');
    await requireActiveCategory(transaction, id, current.kind);
    const category = validateCategory({
      ...changes,
      kind: current.kind,
      parentId: current.parent_id,
    });
    await transaction.runAsync(
      'UPDATE categories SET name=?,is_fixed_cost=?,icon=?,color=?,updated_at=? WHERE id=?',
      category.name,
      category.isFixedCost ? 1 : 0,
      category.icon,
      category.color,
      timestamp,
      id,
    );
  });
}

export async function archiveCategory(
  db: Database,
  id: string,
  replacementId: string | null,
  timestamp: string,
) {
  await db.transaction(async (transaction) => {
    const category = await transaction.getFirstAsync<CategoryRow>(
      'SELECT * FROM categories WHERE id = ?',
      id,
    );
    if (!category) throw new Error('CATEGORY_NOT_FOUND');
    await requireActiveCategory(transaction, id, category.kind);
    if (replacementId !== null) {
      const replacement = await requireActiveCategory(
        transaction,
        replacementId,
        category.kind,
      );
      if (replacement.id === id || replacement.parent_id === id)
        throw new Error('CATEGORY_REPLACEMENT');
      await transaction.runAsync(
        `UPDATE transactions SET category_id=?,updated_at=? WHERE category_id IN
         (SELECT id FROM categories WHERE id=? OR parent_id=?)`,
        replacementId,
        timestamp,
        id,
        id,
      );
    }
    // Budgets retain their original category, including when transactions are reassigned.
    await transaction.runAsync(
      'UPDATE categories SET is_archived=1,updated_at=? WHERE id=? OR parent_id=?',
      timestamp,
      id,
      id,
    );
  });
}

// Restore the selected category and its required parent, leaving siblings archived.
export async function restoreCategory(
  db: Database,
  id: string,
  timestamp: string,
) {
  await db.transaction(async (transaction) => {
    const category = await transaction.getFirstAsync<CategoryRow>(
      'SELECT * FROM categories WHERE id=?',
      id,
    );
    if (!category) throw new Error('CATEGORY_NOT_FOUND');
    if (category.parent_id) {
      const parent = await transaction.getFirstAsync<CategoryRow>(
        'SELECT * FROM categories WHERE id=?',
        category.parent_id,
      );
      if (!parent || parent.parent_id || parent.kind !== category.kind)
        throw new Error('CATEGORY_PARENT');
    }
    await transaction.runAsync(
      'UPDATE categories SET is_archived=0,updated_at=? WHERE (id=? OR id=?) AND is_archived=1',
      timestamp,
      id,
      category.parent_id,
    );
  });
}
