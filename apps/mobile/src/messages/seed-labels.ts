import { activeLanguage } from './language';

// shortcut: match seeded names in display-only views, switch to system_key when queries expose it.
const categoryNames: Record<string, string> = {
  'Ăn uống': 'Food',
  'Ăn ngoài': 'Dining out',
  'Cà phê & đồ uống': 'Coffee and drinks',
  'Đi chợ & siêu thị': 'Groceries',
  'Di chuyển': 'Transport',
  'Xăng xe': 'Fuel',
  'Taxi & xe công nghệ': 'Taxi and rides',
  'Gửi xe & phí đường': 'Parking and tolls',
  'Nhà ở': 'Housing',
  'Tiền nhà': 'Rent',
  'Điện nước': 'Utilities',
  'Internet & điện thoại': 'Internet and phone',
  'Mua sắm': 'Shopping',
  'Sức khỏe': 'Health',
  'Giáo dục': 'Education',
  'Giải trí': 'Entertainment',
  'Gia đình & quà tặng': 'Family and gifts',
  'Hóa đơn & đăng ký': 'Bills and subscriptions',
  Khác: 'Other',
  Lương: 'Salary',
  'Thu nhập kinh doanh': 'Business income',
  Thưởng: 'Bonus',
  'Được cho & quà tặng': 'Gifts received',
  'Lãi & đầu tư': 'Interest and investments',
};

export function displayCategoryName(
  name: string | null | undefined,
  language = activeLanguage,
): string {
  if (!name) return '';
  return language === 'en' ? (categoryNames[name] ?? name) : name;
}

export function displayWalletName(
  name: string | null | undefined,
  language = activeLanguage,
): string {
  if (!name) return '';
  return language === 'en' && name === 'Tiền mặt' ? 'Cash' : name;
}

// Seeded system categories can be translated by key; custom ones never can.
const CATEGORY_BY_SYSTEM_KEY: Record<string, string> = {
  'expense.food': 'Ăn uống',
  'expense.food.eating_out': 'Ăn ngoài',
  'expense.food.coffee': 'Cà phê & đồ uống',
  'expense.food.groceries': 'Đi chợ & siêu thị',
  'expense.transport': 'Di chuyển',
  'expense.transport.fuel': 'Xăng xe',
  'expense.transport.ride': 'Taxi & xe công nghệ',
  'expense.transport.parking': 'Gửi xe & phí đường',
  'expense.housing': 'Nhà ở',
  'expense.housing.rent': 'Tiền nhà',
  'expense.housing.utilities': 'Điện nước',
  'expense.housing.internet': 'Internet & điện thoại',
  'expense.shopping': 'Mua sắm',
  'expense.health': 'Sức khỏe',
  'expense.education': 'Giáo dục',
  'expense.entertainment': 'Giải trí',
  'expense.family_gifts': 'Gia đình & quà tặng',
  'expense.bills_subscriptions': 'Hóa đơn & đăng ký',
  'expense.other': 'Khác',
  'income.salary': 'Lương',
  'income.business': 'Thu nhập kinh doanh',
  'income.bonus': 'Thưởng',
  'income.gift': 'Được cho & quà tặng',
  'income.investment': 'Lãi & đầu tư',
  'income.other': 'Khác',
};

/**
 * Localize a category that came from a system key. Unknown keys keep the stored
 * name so custom categories are shown uncensored but never mistranslated.
 */
export function displaySystemCategory(
  systemKey: string | null | undefined,
  fallbackName: string | null | undefined,
  language = activeLanguage,
): string {
  const canonical = systemKey ? CATEGORY_BY_SYSTEM_KEY[systemKey] : undefined;
  if (!canonical) return displayCategoryName(fallbackName, language);
  return displayCategoryName(canonical, language);
}

/** Build the advice-factual label resolver for a language and message catalog. */
export function factsLabels(
  language: 'vi' | 'en',
  strings: {
    aiFactExpenseHeadline: string;
    aiFactExpenseOther: string;
    aiFactUncategorized: string;
    aiFactNoExpense: string;
    aiFactCashFlowHeadline: string;
    aiFactNoCashFlow: string;
    aiFactChartTitle: string;
  },
) {
  return {
    category: (name: string, systemKey: string | null) =>
      displaySystemCategory(systemKey, name, language),
    date: (from: string, to: string) => (from === to ? from : `${from} – ${to}`),
    expenseHeadline: (total: string, range: string) =>
      strings.aiFactExpenseHeadline
        .replace('{range}', range)
        .replace('{total}', total),
    expenseOther: (total: string) => strings.aiFactExpenseOther.replace('{total}', total),
    noDataExpense: (range: string) =>
      strings.aiFactNoExpense.replace('{range}', range),
    cashFlowHeadline: (
      income: string,
      expense: string,
      net: string,
      range: string,
    ) =>
      strings.aiFactCashFlowHeadline
        .replace('{range}', range)
        .replace('{income}', income)
        .replace('{expense}', expense)
        .replace('{net}', net),
    noDataCashFlow: (range: string) =>
      strings.aiFactNoCashFlow.replace('{range}', range),
    uncategorizedSuffix: (total: string) =>
      strings.aiFactUncategorized.replace('{total}', total),
    chartTitle: (range: string) =>
      strings.aiFactChartTitle.replace('{range}', range),
  };
}
