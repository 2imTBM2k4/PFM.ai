import { describe, expect, it } from 'vitest';
import type { Database, Queries } from './migrate';
import {
  applyDevSeedData,
  DEV_BANK_WALLET_ID,
  DEV_SEED_PREFIX,
  removeDevSeedData,
} from './seed-data';

describe('Dev Seed Data Toggle (Stage 4 & Stage 6)', () => {
  it('inserts deterministic seed records and removes only dev seed records without touching user records', async () => {
    const executedSql: { sql: string; params: unknown[] }[] = [];
    const fakeQueries: Queries = {
      execAsync: async () => undefined,
      runAsync: async (sql: string, ...params: unknown[]) => {
        executedSql.push({ sql, params });
        return { changes: 1 };
      },
      getFirstAsync: async () => null,
      getAllAsync: async () => [],
    };
    const fakeDb: Database = {
      ...fakeQueries,
      transaction: async (task) => {
        await task(fakeQueries);
      },
    };

    await applyDevSeedData(fakeDb, '2026-10-28');

    const walletInsert = executedSql.find((call) =>
      call.params.includes(DEV_BANK_WALLET_ID),
    );
    expect(walletInsert).toBeDefined();

    // Verify all seeded transaction amounts are positive integers
    const txInserts = executedSql.filter((call) =>
      call.sql.includes('INSERT INTO transactions'),
    );
    expect(txInserts.length).toBeGreaterThanOrEqual(10);
    for (const txCall of txInserts) {
      const [id, , amount] = txCall.params as [string, string, number];
      expect(id.startsWith(DEV_SEED_PREFIX)).toBe(true);
      expect(Number.isInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThan(0);
    }

    executedSql.length = 0;
    await removeDevSeedData(fakeDb);

    const deletes = executedSql.filter((call) =>
      call.sql.includes('DELETE FROM'),
    );
    expect(deletes).toHaveLength(6);
    for (const delCall of deletes) {
      expect(delCall.sql).toContain('DELETE FROM');
      expect(delCall.params[0]).toBe(`${DEV_SEED_PREFIX}%`);
    }
    expect(
      executedSql.find((call) => call.sql.includes('INSERT INTO settings'))
        ?.params,
    ).toEqual(['false']);
  });
});
