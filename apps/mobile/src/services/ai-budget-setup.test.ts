(globalThis as any).__DEV__ = true;
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/data/connection', () => ({
  withDatabase: vi.fn(),
}));
vi.mock('@/state/app', () => ({
  useApp: { setState: vi.fn() },
}));
vi.mock('@/features/budgets/mobile', () => ({
  checkBudgetAlerts: vi.fn(),
}));

import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '@/data/migrate';
import { seed } from '@/data/seed';
import { readBudgetMonth } from '@/data/budgets';
import {
  isBudgetSetupIntent,
  extractCustomDateRange,
  tryAIBudgetSetup,
} from './ai-budget-setup';

let sqlite: DatabaseSync;
let dbPath: string;
let testDb: any;

beforeEach(async () => {
  dbPath = join(
    tmpdir(),
    `pfm-test-ai-budget-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  sqlite = new DatabaseSync(dbPath);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  testDb = {
    runAsync: async (sql: string, ...params: unknown[]) => {
      sqlite.prepare(sql).run(...(params as any[]));
      return { changes: 1 };
    },
    getFirstAsync: async <T>(sql: string, ...params: unknown[]) => {
      return (sqlite.prepare(sql).get(...(params as any[])) as T) ?? null;
    },
    getAllAsync: async <T>(sql: string, ...params: unknown[]) => {
      return sqlite.prepare(sql).all(...(params as any[])) as T[];
    },
    execAsync: async (sql: string) => {
      sqlite.exec(sql);
    },
    transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      sqlite.exec('BEGIN TRANSACTION;');
      try {
        const res = await fn(testDb);
        sqlite.exec('COMMIT;');
        return res;
      } catch (err) {
        sqlite.exec('ROLLBACK;');
        throw err;
      }
    },
  };
  await migrate(testDb);
  await seed(testDb, '2026-10-26T00:00:00Z');
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    sqlite.close();
    rmSync(dbPath, { force: true });
  } catch {
    /* ignore cleanup errors */
  }
});

describe('isBudgetSetupIntent', () => {
  it('detects budget setup intent for Vietnamese and English phrases', () => {
    expect(isBudgetSetupIntent('Thiết lập ngân sách ăn uống 2 triệu mỗi tháng')).toBe(true);
    expect(isBudgetSetupIntent('Tạo ngân sách mua sắm 1tr từ 01-11-2026 đến 30-11-2026')).toBe(true);
    expect(isBudgetSetupIntent('Setup ngân sách 3m cho cafe')).toBe(true);
    expect(isBudgetSetupIntent('Đặt ngân sách 5 triệu hàng tháng')).toBe(true);
    expect(isBudgetSetupIntent('Thêm ngân sách 500k')).toBe(true);
    expect(isBudgetSetupIntent('Create budget 2000000 for dining')).toBe(true);
  });

  it('excludes inquiries and 50/30/20 advice planning', () => {
    expect(isBudgetSetupIntent('Ngân sách còn bao nhiêu?')).toBe(false);
    expect(isBudgetSetupIntent('Tôi còn lại bao nhiêu ngân sách tháng này?')).toBe(false);
    expect(isBudgetSetupIntent('Lập kế hoạch ngân sách 50/30/20')).toBe(false);
    expect(isBudgetSetupIntent('Hôm nay ăn gì')).toBe(false);
  });
});

describe('extractCustomDateRange', () => {
  it('extracts date ranges formatted with dashes or slashes', () => {
    const range1 = extractCustomDateRange('từ 01-11-2026 đến 30-11-2026');
    expect(range1).toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });

    const range2 = extractCustomDateRange('từ 5/11/2026 tới 20/11/2026');
    expect(range2).toEqual({ startDate: '2026-11-05', endDate: '2026-11-20' });

    const range3 = extractCustomDateRange('01/11/2026 - 15/11/2026');
    expect(range3).toEqual({ startDate: '2026-11-01', endDate: '2026-11-15' });
  });

  it('rejects invalid or reversed date ranges', () => {
    expect(extractCustomDateRange('từ 30-11-2026 đến 01-11-2026')).toBeNull();
    expect(extractCustomDateRange('mỗi tháng 2 triệu')).toBeNull();
  });
});

describe('tryAIBudgetSetup', () => {
  it('creates a monthly budget when no date range is given', async () => {
    const res = await tryAIBudgetSetup({
      prompt: 'Thiết lập ngân sách ăn uống 2 triệu mỗi tháng',
      userMessageId: 'test-1',
      db: testDb,
    });
    expect(res).not.toBeNull();
    expect(res?.replyText).toContain('Ăn uống');
    expect(res?.replyText).toContain('2.000.000 ₫');
    expect(res?.replyText).toContain('Reset theo tháng');

    const currentMonth = new Date().toISOString().slice(0, 7);
    const budgets = await readBudgetMonth(testDb, currentMonth);
    const created = budgets.find((b) => b.amount === 2000000);
    expect(created).toBeDefined();
    expect(created?.period_type).toBe('monthly');
  });

  it('creates a custom date range budget when a valid date range is supplied', async () => {
    const res = await tryAIBudgetSetup({
      prompt: 'Tạo ngân sách mua sắm 1tr từ 01-11-2026 đến 30-11-2026 cảnh báo khi đạt 70%',
      userMessageId: 'test-2',
      db: testDb,
    });
    expect(res).not.toBeNull();
    expect(res?.replyText).toContain('Mua sắm');
    expect(res?.replyText).toContain('1.000.000 ₫');
    expect(res?.replyText).toContain('Từ 01/11/2026 đến 30/11/2026');
    expect(res?.replyText).toContain('70%');

    const budgets = await readBudgetMonth(testDb, '2026-11');
    const created = budgets.find((b) => b.amount === 1000000);
    expect(created).toBeDefined();
    expect(created?.period_type).toBe('custom');
    expect(created?.start_date).toBe('2026-11-01');
    expect(created?.end_date).toBe('2026-11-30');
    expect(created?.warn_percent).toBe(70);
  });

  it('prompts the user to specify amount when no amount is given', async () => {
    const res = await tryAIBudgetSetup({
      prompt: 'Thiết lập ngân sách ăn uống',
      userMessageId: 'test-3',
      db: testDb,
    });
    expect(res).not.toBeNull();
    expect(res?.replyText).toContain('Bạn muốn thiết lập ngân sách bao nhiêu');
  });
});
