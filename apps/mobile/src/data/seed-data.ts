import { addMonths, monthKey, today } from '@pfm/domain';
import type { Database } from './migrate';
import { DEFAULT_WALLET_ID, seed } from './seed';
import { foldSearchText } from './search-text';

export const DEV_SEED_PREFIX = '00000000-0000-4000-8999-';
export const DEV_BANK_WALLET_ID = `${DEV_SEED_PREFIX}000000000001`;
const SEED_PREFERENCE_SQL = `INSERT INTO settings (key,value) VALUES ('pref_seed_enabled',?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`;

const CAT_FOOD_EATING_OUT = '00000000-0000-4000-8001-000000000002';
const CAT_FOOD_COFFEE = '00000000-0000-4000-8001-000000000003';
const CAT_FOOD_GROCERIES = '00000000-0000-4000-8001-000000000004';
const CAT_TRANSPORT_RIDE = '00000000-0000-4000-8001-000000000007';
const CAT_HOUSING_RENT = '00000000-0000-4000-8001-000000000010';
const CAT_HOUSING_UTILITIES = '00000000-0000-4000-8001-000000000011';
const CAT_SHOPPING = '00000000-0000-4000-8001-000000000013';
const CAT_ENTERTAINMENT = '00000000-0000-4000-8001-000000000016';
const CAT_INCOME_SALARY = '00000000-0000-4000-8001-000000000020';
const CAT_INCOME_BONUS = '00000000-0000-4000-8001-000000000022';

function seedId(seq: number): string {
  return `${DEV_SEED_PREFIX}${String(seq).padStart(12, '0')}`;
}

/**
 * Inserts toggleable development sample data (wallets, previous & current month transactions,
 * budgets, goals, and sample AI chat prompt) using deterministic IDs so it can be toggled
 * on or off without touching user-created records.
 */
export async function applyDevSeedData(
  db: Database,
  referenceDate = today({
    now: () => new Date(),
    timeZone: 'Asia/Ho_Chi_Minh',
  }),
): Promise<void> {
  const nowIso = new Date().toISOString();
  const currentMonth = monthKey(referenceDate);
  const previousMonth = monthKey(addMonths(`${currentMonth}-01`, -1));

  await seed(db, nowIso);

  await db.transaction(async (tx) => {
    await tx.runAsync(
      `INSERT INTO wallets (id, name, kind, initial_balance, sort_order, created_at, updated_at)
       VALUES (?, 'Ngân hàng Số (Mẫu)', 'bank', 5000000, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET is_archived = 0, updated_at = excluded.updated_at`,
      DEV_BANK_WALLET_ID,
      nowIso,
      nowIso,
    );

    const sampleTransactions: {
      seq: number;
      kind: 'income' | 'expense';
      amount: number;
      walletId: string;
      categoryId: string;
      occurredOn: string;
      timeOfDay?: string;
      note: string;
    }[] = [
      // Previous month transactions (for month-over-month comparison)
      {
        seq: 10,
        kind: 'income',
        amount: 22_000_000,
        walletId: DEV_BANK_WALLET_ID,
        categoryId: CAT_INCOME_SALARY,
        occurredOn: `${previousMonth}-05`,
        timeOfDay: '09:00:00',
        note: 'Lương tháng trước (Mẫu)',
      },
      {
        seq: 11,
        kind: 'expense',
        amount: 4_500_000,
        walletId: DEV_BANK_WALLET_ID,
        categoryId: CAT_HOUSING_RENT,
        occurredOn: `${previousMonth}-06`,
        timeOfDay: '10:15:00',
        note: 'Tiền thuê nhà tháng trước (Mẫu)',
      },
      {
        seq: 12,
        kind: 'expense',
        amount: 2_800_000,
        walletId: DEFAULT_WALLET_ID,
        categoryId: CAT_FOOD_GROCERIES,
        occurredOn: `${previousMonth}-14`,
        timeOfDay: '18:30:00',
        note: 'Đi siêu thị & thực phẩm (Mẫu)',
      },
      // Current month transactions
      {
        seq: 20,
        kind: 'income',
        amount: 25_000_000,
        walletId: DEV_BANK_WALLET_ID,
        categoryId: CAT_INCOME_SALARY,
        occurredOn: `${currentMonth}-01`,
        timeOfDay: '09:00:00',
        note: 'Lương chính tháng này (Mẫu)',
      },
      {
        seq: 21,
        kind: 'income',
        amount: 3_500_000,
        walletId: DEV_BANK_WALLET_ID,
        categoryId: CAT_INCOME_BONUS,
        occurredOn: `${currentMonth}-02`,
        timeOfDay: '11:00:00',
        note: 'Thưởng dự án (Mẫu)',
      },
      {
        seq: 22,
        kind: 'expense',
        amount: 4_500_000,
        walletId: DEV_BANK_WALLET_ID,
        categoryId: CAT_HOUSING_RENT,
        occurredOn: `${currentMonth}-02`,
        timeOfDay: '14:20:00',
        note: 'Tiền thuê nhà (Mẫu)',
      },
      {
        seq: 23,
        kind: 'expense',
        amount: 1_850_000,
        walletId: DEV_BANK_WALLET_ID,
        categoryId: CAT_FOOD_GROCERIES,
        occurredOn: `${currentMonth}-03`,
        timeOfDay: '17:45:00',
        note: 'Đi siêu thị cuối tuần (Mẫu)',
      },
      {
        seq: 24,
        kind: 'expense',
        amount: 650_000,
        walletId: DEFAULT_WALLET_ID,
        categoryId: CAT_HOUSING_UTILITIES,
        occurredOn: `${currentMonth}-03`,
        timeOfDay: '19:15:00',
        note: 'Hóa đơn điện nước & Internet (Mẫu)',
      },
      {
        seq: 25,
        kind: 'expense',
        amount: 1_200_000,
        walletId: DEV_BANK_WALLET_ID,
        categoryId: CAT_SHOPPING,
        occurredOn: `${currentMonth}-04`,
        timeOfDay: '15:00:00',
        note: 'Mua đồ gia dụng (Mẫu)',
      },
      {
        seq: 26,
        kind: 'expense',
        amount: 320_000,
        walletId: DEFAULT_WALLET_ID,
        categoryId: CAT_TRANSPORT_RIDE,
        occurredOn: `${currentMonth}-04`,
        timeOfDay: '18:10:00',
        note: 'Di chuyển xe công nghệ (Mẫu)',
      },
      {
        seq: 27,
        kind: 'expense',
        amount: 480_000,
        walletId: DEFAULT_WALLET_ID,
        categoryId: CAT_FOOD_EATING_OUT,
        occurredOn: `${currentMonth}-05`,
        timeOfDay: '20:00:00',
        note: 'Ăn tối cùng gia đình (Mẫu)',
      },
      {
        seq: 28,
        kind: 'expense',
        amount: 95_000,
        walletId: DEFAULT_WALLET_ID,
        categoryId: CAT_FOOD_COFFEE,
        occurredOn: referenceDate,
        timeOfDay: '08:30:00',
        note: 'Cà phê sáng & bánh ngọt (Mẫu)',
      },
      {
        seq: 29,
        kind: 'expense',
        amount: 420_000,
        walletId: DEV_BANK_WALLET_ID,
        categoryId: CAT_ENTERTAINMENT,
        occurredOn: referenceDate,
        timeOfDay: '10:30:00',
        note: 'Vé xem phim & giải trí (Mẫu)',
      },
    ];

    for (const item of sampleTransactions) {
      const occurredAt = `${item.occurredOn}T${item.timeOfDay ?? '09:00:00'}+07:00`;
      await tx.runAsync(
        `INSERT INTO transactions (
          id, kind, amount, wallet_id, to_wallet_id, category_id, debt_id,
          occurred_on, occurred_at, note, note_search, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, 'manual', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          amount = excluded.amount,
          occurred_on = excluded.occurred_on,
          occurred_at = excluded.occurred_at,
          note = excluded.note,
          note_search = excluded.note_search,
          updated_at = excluded.updated_at`,
        seedId(item.seq),
        item.kind,
        item.amount,
        item.walletId,
        item.categoryId,
        item.occurredOn,
        occurredAt,
        item.note,
        foldSearchText(item.note),
        nowIso,
        nowIso,
      );
    }

    // Sample monthly budgets
    await tx.runAsync(
      `INSERT INTO budgets (id, category_id, amount, warn_percent, start_month, is_active, created_at, updated_at)
       VALUES (?, ?, 4000000, 80, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, start_month = excluded.start_month, is_active = 1`,
      seedId(100),
      CAT_FOOD_GROCERIES,
      currentMonth,
      nowIso,
      nowIso,
    );
    await tx.runAsync(
      `INSERT INTO budgets (id, category_id, amount, warn_percent, start_month, is_active, created_at, updated_at)
       VALUES (?, ?, 5500000, 80, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, start_month = excluded.start_month, is_active = 1`,
      seedId(101),
      CAT_HOUSING_RENT,
      currentMonth,
      nowIso,
      nowIso,
    );

    // Sample savings goal
    await tx.runAsync(
      `INSERT INTO goals (id, name, target_amount, deadline_on, funding_wallet_id, manual_saved_amount, status, created_at, updated_at)
       VALUES (?, 'Quỹ dự phòng 6 tháng (Mẫu)', 30000000, ?, NULL, 12500000, 'active', ?, ?)
       ON CONFLICT(id) DO UPDATE SET manual_saved_amount = excluded.manual_saved_amount, status = 'active'`,
      seedId(200),
      `${currentMonth}-28`,
      nowIso,
      nowIso,
    );

    // Sample AI chat message
    await tx.runAsync(
      `INSERT INTO chat_messages (id, text, created_at)
       VALUES (?, 'Spending Insights: Phân tích tỷ trọng chi tiêu theo danh mục', ?)
       ON CONFLICT(id) DO NOTHING`,
      seedId(300),
      nowIso,
    );
    await tx.runAsync(SEED_PREFERENCE_SQL, 'true');
  });
}

/**
 * Removes only the deterministic dev seed records (prefix '00000000-0000-4000-8999-')
 * while keeping all user-entered transactions, wallets, budgets, and goals intact.
 */
export async function removeDevSeedData(db: Database): Promise<void> {
  const pattern = `${DEV_SEED_PREFIX}%`;
  await db.transaction(async (tx) => {
    await tx.runAsync(
      'DELETE FROM budget_alerts_sent WHERE budget_id LIKE ?',
      pattern,
    );
    await tx.runAsync('DELETE FROM budgets WHERE id LIKE ?', pattern);
    await tx.runAsync('DELETE FROM goals WHERE id LIKE ?', pattern);
    await tx.runAsync('DELETE FROM transactions WHERE id LIKE ?', pattern);
    await tx.runAsync('DELETE FROM chat_messages WHERE id LIKE ?', pattern);
    // User records can reference a sample wallet; retain its original identity and opening balance.
    await tx.runAsync(
      `DELETE FROM wallets WHERE id LIKE ?
      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.wallet_id=wallets.id OR t.to_wallet_id=wallets.id)
      AND NOT EXISTS (SELECT 1 FROM recurring_rules r WHERE r.wallet_id=wallets.id OR r.to_wallet_id=wallets.id)
      AND NOT EXISTS (SELECT 1 FROM goals g WHERE g.funding_wallet_id=wallets.id)`,
      pattern,
    );
    await tx.runAsync(SEED_PREFERENCE_SQL, 'false');
  });
}
