import {
  ParseLearningInputSchema,
  type ParseLearningInput,
} from '@pfm/contracts';
import {
  learningTokens,
  type EntryKind,
  type LearningIndex,
} from '@pfm/domain';
import { requireActiveCategory } from './categories';
import type { Database, Queries } from './migrate';

// Read history without learning; inactive targets count toward totals but cannot win.
export async function readClassifierContext(
  db: Queries,
): Promise<{ learned: LearningIndex; knownCounterparties: string[] }> {
  const rows = await db.getAllAsync<{
    token_key: string;
    kind: EntryKind;
    category_id: string | null;
    category_key: string | null;
    hit_count: number;
    available: number;
  }>(`SELECT l.*,c.system_key category_key,
    CASE WHEN l.category_id IS NULL THEN 1
      WHEN c.id IS NOT NULL AND c.kind=l.kind AND c.is_archived=0
      AND (c.parent_id IS NULL OR (p.id IS NOT NULL AND p.kind=c.kind AND p.is_archived=0)) THEN 1 ELSE 0 END available
    FROM parse_learning l LEFT JOIN categories c ON c.id=l.category_id
    LEFT JOIN categories p ON p.id=c.parent_id ORDER BY l.token_key,l.kind,COALESCE(l.category_id,'')`);
  const learned = rows.map((row) => {
    const validation = ParseLearningInputSchema.safeParse({
      noteText: '',
      kind: row.kind,
      categoryId: row.category_id,
    });
    if (
      !validation.success ||
      !Number.isSafeInteger(row.hit_count) ||
      row.hit_count < 0
    )
      throw new Error('PARSE_LEARNING_INVALID');
    return {
      tokenKey: row.token_key,
      kind: validation.data.kind,
      categoryKey: row.category_key,
      categoryId: row.category_id,
      hitCount: row.hit_count,
      available: row.available === 1,
    };
  });
  const names = await db.getAllAsync<{ counterparty_label: string }>(
    'SELECT DISTINCT counterparty_label FROM debts ORDER BY counterparty_label',
  );
  return {
    learned,
    knownCounterparties: names.map((row) => row.counterparty_label),
  };
}

// Called inside the same SQL transaction as a confirmed parsed-entry write in T3.3.
export async function recordParseLearningQueries(
  db: Queries,
  input: ParseLearningInput,
  timestamp: string,
): Promise<void> {
  const value = ParseLearningInputSchema.parse(input);
  if (value.categoryId && (value.kind === 'expense' || value.kind === 'income'))
    await requireActiveCategory(db, value.categoryId, value.kind);
  for (const token of learningTokens(value.noteText)) {
    const previous = await db.getFirstAsync<{ hit_count: number }>(
      'SELECT hit_count FROM parse_learning WHERE token_key=? AND kind=? AND category_id IS ?',
      token,
      value.kind,
      value.categoryId,
    );
    if (
      previous &&
      (!Number.isSafeInteger(previous.hit_count) ||
        previous.hit_count < 0 ||
        previous.hit_count >= Number.MAX_SAFE_INTEGER)
    )
      throw new Error('PARSE_LEARNING_OVERFLOW');
    // The expression index also catches NULL categories; no conflict target is needed.
    await db.runAsync(
      `INSERT INTO parse_learning (token_key,kind,category_id,hit_count,updated_at) VALUES (?,?,?,1,?)
      ON CONFLICT DO UPDATE SET hit_count=parse_learning.hit_count+1,updated_at=excluded.updated_at`,
      token,
      value.kind,
      value.categoryId,
      timestamp,
    );
  }
}

// Explicit confirmed-choice API; previews must only call the read function.
export function recordParseLearning(
  db: Database,
  input: ParseLearningInput,
  timestamp: string,
): Promise<void> {
  return db.transaction((tx) =>
    recordParseLearningQueries(tx, input, timestamp),
  );
}
