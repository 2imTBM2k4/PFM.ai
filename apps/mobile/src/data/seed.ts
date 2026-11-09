import type { Database } from './migrate';

export const DEFAULT_WALLET_ID = '00000000-0000-4000-8000-000000000001';

// Stable seed IDs preserve references across interrupted first runs.
const CATEGORIES = [
  ['expense.food', 'Ăn uống', 0],
  ['expense.food.eating_out', 'Ăn ngoài', 0],
  ['expense.food.coffee', 'Cà phê & đồ uống', 0],
  ['expense.food.groceries', 'Đi chợ & siêu thị', 0],
  ['expense.transport', 'Di chuyển', 0],
  ['expense.transport.fuel', 'Xăng xe', 0],
  ['expense.transport.ride', 'Taxi & xe công nghệ', 0],
  ['expense.transport.parking', 'Gửi xe & phí đường', 0],
  ['expense.housing', 'Nhà ở', 1],
  ['expense.housing.rent', 'Tiền nhà', 1],
  ['expense.housing.utilities', 'Điện nước', 1],
  ['expense.housing.internet', 'Internet & điện thoại', 1],
  ['expense.shopping', 'Mua sắm', 0],
  ['expense.health', 'Sức khỏe', 0],
  ['expense.education', 'Giáo dục', 0],
  ['expense.entertainment', 'Giải trí', 0],
  ['expense.family_gifts', 'Gia đình & quà tặng', 0],
  ['expense.bills_subscriptions', 'Hóa đơn & đăng ký', 1],
  ['expense.other', 'Khác', 0],
  ['income.salary', 'Lương', 0],
  ['income.business', 'Thu nhập kinh doanh', 0],
  ['income.bonus', 'Thưởng', 0],
  ['income.gift', 'Được cho & quà tặng', 0],
  ['income.investment', 'Lãi & đầu tư', 0],
  ['income.other', 'Khác', 0],
] as const;

function categoryId(index: number) {
  return `00000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`;
}

export async function seed(db: Database, timestamp: string) {
  await db.transaction(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO wallets (id, name, kind, created_at, updated_at)
       VALUES (?, 'Tiền mặt', 'cash', ?, ?) ON CONFLICT(id) DO NOTHING`,
      DEFAULT_WALLET_ID,
      timestamp,
      timestamp,
    );
    for (const [index, [key, name, fixed]] of CATEGORIES.entries()) {
      const parentKey =
        key.split('.').length === 3 ? key.slice(0, key.lastIndexOf('.')) : null;
      const parent =
        parentKey === null
          ? null
          : CATEGORIES.findIndex(([candidate]) => candidate === parentKey);
      await transaction.runAsync(
        `INSERT INTO categories (id, system_key, parent_id, name, kind, is_fixed_cost, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        categoryId(index),
        key,
        parent === null ? null : categoryId(parent),
        name,
        key.startsWith('expense.') ? 'expense' : 'income',
        fixed,
        index,
        timestamp,
        timestamp,
      );
    }
  });
}
