/**
 * Which spending counts as essential for emergency-fund sizing.
 *
 * Everything is treated as essential except an explicit discretionary list, so
 * an unclassified or freshly created category is never assumed cuttable. The
 * parent key is used when a transaction is booked on a child category.
 */
export const DISCRETIONARY_EXPENSE_KEYS: readonly string[] = [
  'expense.food.eating_out',
  'expense.food.coffee',
  'expense.shopping',
  'expense.entertainment',
  'expense.family_gifts',
  'expense.other',
];

/** SQL predicate that keeps only essential expense rows; pass the keys as params. */
export function essentialExpensePredicate(keys = DISCRETIONARY_EXPENSE_KEYS): {
  sql: string;
  params: string[];
} {
  const placeholders = keys.map(() => '?').join(', ');
  return {
    sql: `COALESCE(p.system_key, c.system_key) IS NULL OR COALESCE(p.system_key, c.system_key) NOT IN (${placeholders})`,
    params: [...keys],
  };
}
