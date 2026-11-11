import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, parseAdviceQuery, today } from '@pfm/domain';

import { migrate, type Database } from '@/data/migrate';
import { seed } from '@/data/seed';
import { en } from '@/messages/en';
import { vi as viMessages } from '@/messages/vi';
import { setActiveLanguage } from '@/messages/language';
import { usePreferences } from '@/state/preferences';

const WALLET = '00000000-0000-4000-8000-000000000001';
const CLOCK = {
  now: () => new Date(),
  timeZone: 'Asia/Ho_Chi_Minh',
} as const;

const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/features/budgets/mobile', () => ({ checkBudgetAlerts: vi.fn() }));
vi.mock('@/state/app', () => ({ useApp: { setState: vi.fn() } }));

vi.mock('@/data/connection', () => ({
  withDatabase: async (fn: (db: unknown) => unknown) => fn(holder.db),
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => '11111111-2222-4333-8444-555555555555',
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { hostUri: '127.0.0.1:8081' } },
}));

vi.mock('@/services/device-id', () => ({
  getOrCreateDeviceId: async () => 'integration-device',
}));

// Imported after the mocks so the module graph picks them up.
const { tryFactualAdvice } = await import('./ai-service');

describe('factual advice pipeline on real SQLite', () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const currentDay = () => today(CLOCK);

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    db = {
      execAsync: async (sql) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql, ...params) => sqlite.prepare(sql).run(...params),
      getAllAsync: async <T>(
        sql: string,
        ...params: (string | number | null)[]
      ) => sqlite.prepare(sql).all(...params) as T[],
      getFirstAsync: async <T>(
        sql: string,
        ...params: (string | number | null)[]
      ) => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
      transaction: async (task) => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          await task(db);
          sqlite.exec('COMMIT');
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    };
    holder.db = db;
    await migrate(db);
    await seed(db, '2026-01-01T00:00:00Z');
    usePreferences.setState({
      language: 'vi',
      currency: 'VND',
      exchangeRate: null,
    });
    setActiveLanguage('vi');
  });

  afterEach(() => {
    setActiveLanguage('vi');
  });

  async function categoryId(systemKey: string): Promise<string> {
    const row = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM categories WHERE system_key = ?',
      systemKey,
    );
    if (!row) throw new Error(`missing ${systemKey}`);
    return row.id;
  }

  async function addExpense(
    amount: number,
    occurredOn: string,
    categorySystemKey: string | null,
  ): Promise<void> {
    await db.runAsync(
      `INSERT INTO transactions
         (id, kind, amount, original_currency, original_amount_minor, wallet_id, category_id,
          occurred_on, occurred_at, source, created_at, updated_at)
       VALUES (?, 'expense', ?, 'VND', ?, ?, ?, ?, ?, 'manual', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      randomUUID(),
      amount,
      amount,
      WALLET,
      categorySystemKey ? await categoryId(categorySystemKey) : null,
      occurredOn,
      `${occurredOn}T10:00:00+07:00`,
    );
  }

  async function addIncome(
    amount: number,
    occurredOn: string,
    categorySystemKey: string,
  ): Promise<void> {
    await db.runAsync(
      `INSERT INTO transactions
         (id, kind, amount, original_currency, original_amount_minor, wallet_id, category_id,
          occurred_on, occurred_at, source, created_at, updated_at)
       VALUES (?, 'income', ?, 'VND', ?, ?, ?, ?, ?, 'manual', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      randomUUID(),
      amount,
      amount,
      WALLET,
      await categoryId(categorySystemKey),
      occurredOn,
      `${occurredOn}T10:00:00+07:00`,
    );
  }

  it('answers the reported question with the last 7 days of real rows', async () => {
    const now = currentDay();
    await addExpense(3_500_000, addDays(now, -1), 'expense.housing.rent');
    await addExpense(900_000, addDays(now, -2), 'expense.food.eating_out');
    await addExpense(400_000, now, 'expense.transport.fuel');
    // Outside the window and in the future: neither may be counted.
    await addExpense(9_000_000, addDays(now, -10), 'expense.shopping');
    await addExpense(7_000_000, addDays(now, 3), 'expense.shopping');

    const reply = await tryFactualAdvice({
      prompt: 'Cho tôi biết những ngày qua tôi tiêu gì nhiều',
      history: [],
      userMessageId: 'msg-report',
    });

    expect(reply).not.toBeNull();
    expect(reply!.replyText).toContain('4.800.000 ₫');
    expect(reply!.replyText).toContain('Nhà ở');
    expect(reply!.replyText).toContain('3.500.000 ₫');
    expect(reply!.replyText).not.toContain('9.000.000');
    expect(reply!.replyText).not.toContain('7.000.000');
    expect(reply!.chartItems?.[0]).toMatchObject({
      category: 'Nhà ở',
      amount: 3_500_000,
    });
    // The range label names the exact start and end dates.
    expect(reply!.replyText).toContain(
      String(Number(addDays(now, -6).slice(8))),
    );
    expect(reply!.replyText).toContain(String(Number(now.slice(8))));
  });

  it('answers a follow-up with the previous subject and the new period', async () => {
    const now = currentDay();
    const lastMonth = `${addDays(`${now.slice(0, 7)}-01`, -1).slice(0, 7)}-15`;
    await addExpense(1_000_000, lastMonth, 'expense.shopping');
    await addExpense(2_000_000, addDays(now, -1), 'expense.housing.rent');

    const history = [
      {
        role: 'user' as const,
        text: 'Cho tôi biết những ngày qua tôi tiêu gì nhiều',
      },
      {
        role: 'assistant' as const,
        text: 'Trong 7 ngày qua bạn chi nhiều nhất cho Nhà ở.',
      },
    ];
    const reply = await tryFactualAdvice({
      prompt: 'Thế tháng trước?',
      history,
      userMessageId: 'msg-follow-up',
    });

    expect(reply).not.toBeNull();
    expect(reply!.replyText).toContain('1.000.000 ₫');
    expect(reply!.replyText).not.toContain('2.000.000 ₫');
    expect(reply!.chartItems?.[0].category).toBe('Mua sắm');
  });

  it('answers a cash-flow question from the same window', async () => {
    const now = currentDay();
    await addIncome(15_000_000, addDays(now, -1), 'income.salary');
    await addExpense(5_000_000, now, 'expense.food');

    const reply = await tryFactualAdvice({
      prompt: 'Tháng này tôi chi bao nhiêu?',
      history: [],
      userMessageId: 'msg-flow',
    });
    expect(reply!.replyText).toContain('15.000.000 ₫');
    expect(reply!.replyText).toContain('5.000.000 ₫');
    expect(reply!.replyText).toContain('10.000.000 ₫');
    expect(reply!.chartItems).toBeUndefined();
  });

  it('says there is no data instead of inventing spending', async () => {
    const reply = await tryFactualAdvice({
      prompt: 'Hôm nay tôi chi gì nhiều',
      history: [],
      userMessageId: 'msg-empty',
    });
    expect(reply!.replyText).toContain('chưa ghi khoản chi nào');
    expect(reply!.chartItems).toBeUndefined();
  });

  it('switches the answer to English and USD without touching stored VND', async () => {
    const now = currentDay();
    await addExpense(2_500_000, now, 'expense.housing.rent');
    usePreferences.setState({
      language: 'en',
      currency: 'USD',
      exchangeRate: 25_000,
    });
    setActiveLanguage('en');

    const reply = await tryFactualAdvice({
      prompt: 'What did I spend the most on today?',
      history: [],
      userMessageId: 'msg-en',
    });
    expect(reply!.replyText).toContain('$100.00');
    // The rent subcategory rolls up to its Housing parent.
    expect(reply!.replyText).toContain('Housing');
    expect(reply!.replyText).toContain('From');
  });

  it('asks for a period before querying when the user gave none', async () => {
    const reply = await tryFactualAdvice({
      prompt: 'Tôi tiêu gì nhiều?',
      history: [],
      userMessageId: 'msg-ask',
    });
    expect(reply!.replyText).toBe(viMessages.aiFactPeriodQuestion);
  });

  it('leaves advice questions to the model path', async () => {
    expect(
      await tryFactualAdvice({
        prompt: 'Mua xe 40 triệu thì bao lâu đủ?',
        history: [],
        userMessageId: 'msg-advice',
      }),
    ).toBeNull();
  });

  it('keeps the period resolver aligned with the parser', () => {
    const query = parseAdviceQuery('Tháng này tôi chi bao nhiêu?', [], CLOCK);
    expect(query.range?.from).toBe(`${currentDay().slice(0, 7)}-01`);
    expect(query.range?.to).toBe(currentDay());
    expect(en.aiFactExpenseHeadline).toContain('{range}');
  });
});
