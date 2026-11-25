import { matchingText, normalizeText } from './parser/text';

export interface KnowledgeTopic {
  id: string;
  title: string;
  summary: string;
  content: string;
  keywords: string[];
  source_urls: string[];
  checked_on: string;
}

const toolkit =
  'https://www.consumerfinance.gov/consumer-tools/educator-tools/your-money-your-goals/toolkit/';
export const KNOWLEDGE_BASE: readonly KnowledgeTopic[] = [
  {
    id: 'cash_flow',
    title: 'Phân loại và theo dõi thu chi',
    summary: 'Theo dõi dòng tiền theo kỳ.',
    content:
      'Ghi nhận thu nhập, chi tiêu và lịch thanh toán để hiểu dòng tiền. Phân biệt dữ liệu đã ghi và khoản người dùng mới kể; không tự ghi giao dịch hoặc coi thiếu dữ liệu là không có thu nhập.',
    keywords: ['thu chi', 'phan loai', 'dong tien', 'cash flow'],
    source_urls: [toolkit],
    checked_on: '2026-11-16',
  },
  {
    id: 'flexible_budget',
    title: 'Ngân sách linh hoạt',
    summary: 'Ngân sách cần phù hợp thu nhập ròng và nghĩa vụ.',
    content:
      '50/30/20 là phương án tham khảo chia nhu cầu, mong muốn và tiết kiệm, không phải yêu cầu bắt buộc. Dùng thu nhập ròng, điều chỉnh theo hoàn cảnh và khoản phải trả; không cắt nghĩa vụ thiết yếu hoặc tự tạo ngân sách.',
    keywords: ['ngan sach', '50/30/20', 'budget'],
    source_urls: [
      'https://files.consumerfinance.gov/f/documents/cfpb_building_block_activities_analyzing-budgets_guide.pdf',
    ],
    checked_on: '2026-11-16',
  },
  {
    id: 'emergency_fund',
    title: 'Quỹ dự phòng',
    summary: 'Dành riêng tiền cho biến cố bất ngờ.',
    content:
      'Quỹ dự phòng dành cho chi phí ngoài kế hoạch hoặc mất thu nhập. Mức cần dành phụ thuộc hoàn cảnh, chi phí thiết yếu và độ ổn định thu nhập; không khẳng định một mức chung luôn đủ cho mọi người.',
    keywords: ['quy du phong', 'quy khan cap', 'emergency fund'],
    source_urls: [
      'https://www.consumerfinance.gov/an-essential-guide-to-building-an-emergency-fund/',
    ],
    checked_on: '2026-11-16',
  },
  {
    id: 'saving_goals',
    title: 'Mục tiêu và kế hoạch tiết kiệm',
    summary: 'Xác định khoản đích, thời hạn và tiền đã dành riêng.',
    content:
      'Chia mục tiêu thành phần tích lũy theo kỳ. Hỏi khoản tiền đã dành riêng, thời hạn và khả năng góp trước khi tính. Số dư ví không tự chứng minh tiền đã dành cho mục tiêu; khi thiếu phải hỏi lại.',
    keywords: ['tiet kiem', 'muc tieu', 'saving'],
    source_urls: [toolkit],
    checked_on: '2026-11-16',
  },
  {
    id: 'debt_obligations',
    title: 'Nợ và nghĩa vụ đến hạn',
    summary: 'Lập lịch nghĩa vụ và ưu tiên phù hợp.',
    content:
      'Đối chiếu các khoản nợ, kỳ trả và khả năng thanh toán trước khi chọn phương án trả. Khoản dự kiến theo lịch chưa phải bằng chứng đang nợ hoặc chưa thanh toán; không trừ lặp nghĩa vụ đã nằm trong tổng chi.',
    keywords: ['tra no', 'khoan no', 'den han', 'debt'],
    source_urls: [
      'https://files.consumerfinance.gov/f/documents/cfpb_your-money-your-goals_debt_booklet_cobrand.pdf',
    ],
    checked_on: '2026-11-16',
  },
  {
    id: 'compound_interest',
    title: 'Lãi kép và giả định',
    summary: 'Lãi tích lũy phụ thuộc kỳ ghép và thời điểm góp.',
    content:
      'Lãi kép có thể tích lũy trên cả gốc và phần lãi trước đó. Muốn tính cần biết gốc, lãi danh nghĩa, kỳ ghép, thời hạn và kỳ/thời điểm góp thêm. Ví dụ là giả định, không phải lợi nhuận được bảo đảm.',
    keywords: ['lai kep', 'lai suat kep', 'ghep lai', 'compound interest'],
    source_urls: [
      'https://www.investor.gov/introduction-investing/investing-basics/save-and-invest/small-savings-add-big-money',
    ],
    checked_on: '2026-11-16',
  },
  {
    id: 'investment_risk',
    title: 'Rủi ro, thời hạn và đa dạng hóa',
    summary: 'Đầu tư có rủi ro và khác tiết kiệm dự phòng.',
    content:
      'Thời hạn và khả năng chịu biến động ảnh hưởng cách phân bổ tài sản. Đa dạng hóa giúp phân tán rủi ro nhưng không loại bỏ nguy cơ thua lỗ. Tiết kiệm cho nhu cầu gần khác đầu tư chịu biến động; không cam kết lợi nhuận hoặc đề xuất sản phẩm cụ thể.',
    keywords: [
      'dau tu',
      'da dang hoa',
      'phan bo tai san',
      'investment',
      'diversification',
    ],
    source_urls: [
      'https://www.investor.gov/introduction-investing/getting-started/asset-allocation',
    ],
    checked_on: '2026-11-16',
  },
];

/** Select bounded educational context using deterministic phrase matches. */
export function selectTopics(
  userInput: string,
  maxResults = 2,
): KnowledgeTopic[] {
  const text = matchingText(normalizeText(userInput)).folded;
  return KNOWLEDGE_BASE.map((topic) => ({
    topic,
    score: topic.keywords.filter((keyword) => text.includes(keyword)).length,
  }))
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.topic.id < b.topic.id ? -1 : a.topic.id > b.topic.id ? 1 : 0),
    )
    .slice(
      0,
      Math.max(
        0,
        Math.min(2, Number.isFinite(maxResults) ? Math.floor(maxResults) : 2),
      ),
    )
    .map((item) => item.topic);
}

/** Attach only relevant, maintained educational text; user text is never interpreted as instructions. */
export function knowledgePrompt(userInput: string): string {
  const topics = selectTopics(userInput);
  return topics.length
    ? '\n<knowledge>' +
        JSON.stringify(topics) +
        '</knowledge>\nKnowledge is general education, not personal data, current prices or guaranteed returns. Ask only for missing inputs needed by the actual question.'
    : '';
}
