import { describe, expect, it } from 'vitest';
import { parseEntry } from '../parser';
import { classifyEntry, learningTokens, DEFAULT_LEXICON } from './index';
import type { LearningIndex, Lexicon } from './index';

const clock = {
  now: () => new Date('2026-10-23T09:00:00+07:00'),
  timeZone: 'Asia/Ho_Chi_Minh',
};
const knownCounterparties = ['Hùng', 'Lan'];
const parse = (input: string, learned?: LearningIndex) =>
  parseEntry(input, { clock, learned, knownCounterparties });

describe('normative classification', () => {
  it.each([
    ['ăn sáng 30k', 'expense', 'expense.food.eating_out', 30000],
    ['khách trả tiền hàng 50k', 'income', 'income.business', 50000],
    ['cf 25k', 'expense', 'expense.food.coffee', 25000],
    ['grab 45k', 'expense', 'expense.transport.ride', 45000],
    ['đổ xăng 80k', 'expense', 'expense.transport.fuel', 80000],
    ['lương tháng 10 15tr', 'income', 'income.salary', 15000000],
    ['tiền nhà 3tr5', 'expense', 'expense.housing.rent', 3500000],
    ['tiền điện 450k', 'expense', 'expense.housing.utilities', 450000],
    ['đi chợ 200k', 'expense', 'expense.food.groceries', 200000],
    ['học phí 3tr', 'expense', 'expense.education', 3000000],
    ['xem phim 120k', 'expense', 'expense.entertainment', 120000],
    ['bán hàng online 1tr2', 'income', 'income.business', 1200000],
    ['thưởng tết 5tr', 'income', 'income.bonus', 5000000],
    ['mẹ gửi 2tr', 'income', 'income.gift', 2000000],
    ['mượn Hùng 500k', 'debt_borrow', null, 500000],
    ['cho Lan mượn 1tr', 'debt_lend', null, 1000000],
    ['trả nợ Hùng 500k', 'debt_repay_paid', null, 500000],
    ['Lan trả nợ 1tr', 'debt_repay_received', null, 1000000],
    ['rút atm 2tr', 'transfer', null, 2000000],
    [
      'nạp thẻ điện thoại 100k',
      'expense',
      'expense.bills_subscriptions',
      100000,
    ],
    ['bạn trả tiền ăn 100k', 'unknown', null, 100000],
    ['mua gì đó 50k', 'expense', null, 50000],
    ['  AN   SANG 30K 😀', 'expense', 'expense.food.eating_out', 30000],
  ])('%s', (input, kind, categoryKey, value) => {
    expect(parse(String(input)).candidates[0]).toMatchObject({
      kind,
      categoryKey,
      amount: { value },
    });
  });

  it('warns for ambiguous repayments without recognizable names', () => {
    for (const input of [
      'trả nợ 30k',
      'trả nợ hôm nay 30k',
      'bạn trả tiền ăn 100k',
    ]) {
      expect(parse(input).warnings).toContain('AMBIGUOUS_KIND');
      expect(parse(input).candidates[0].kind).toBe('unknown');
    }
    expect(parse('mua gì đó 50k').candidates[0].kindConfidence).toBe(0.4);
  });

  it('uses only stored names and leaves names on both sides ambiguous', () => {
    expect(classifyEntry('trả nợ Hùng').kind).toBe('unknown');
    expect(
      classifyEntry('TRẢ NỢ HUNG', { knownCounterparties: ['Hùng'] }).kind,
    ).toBe('debt_repay_paid');
    expect(classifyEntry('Hùng trả nợ Lan', { knownCounterparties }).kind).toBe(
      'unknown',
    );
    expect(
      classifyEntry('Trần Minh trả nợ', { knownCounterparties: ['Trần Minh'] })
        .kind,
    ).toBe('debt_repay_received');
  });

  it.each([
    ['muốn mua cf', 'expense', 'expense.food.coffee'],
    ['tôi muốn ăn sáng', 'expense', 'expense.food.eating_out'],
    ['vậy cf', 'expense', 'expense.food.coffee'],
    ['muộn rồi', 'expense', null],
    ['mượn Hùng', 'debt_borrow', null],
    ['muon Hung', 'debt_borrow', null],
  ])(
    'keeps accented desire/late words separate from loans: %s',
    (input, kind, categoryKey) => {
      expect(classifyEntry(input)).toMatchObject({ kind, categoryKey });
    },
  );

  it('does not retain a scoring-tie warning after explicit loan direction resolves it', () => {
    const result = classifyEntry('mượn Hùng cf');
    expect(result.kind).toBe('debt_borrow');
    expect(result.warnings).not.toContain('AMBIGUOUS_KIND');
  });

  it.each(['lai', 'lại', 'trả', 'trà', 'be'])(
    'does not classify the ambiguous token %s alone',
    (input) => {
      expect(classifyEntry(input)).toMatchObject({
        kind: 'expense',
        kindConfidence: 0.4,
        categoryKey: null,
      });
    },
  );

  it('matches ambiguous words only in full phrases and not inside larger words', () => {
    expect(classifyEntry('tiền lãi').categoryKey).toBe('income.investment');
    expect(classifyEntry('trà sữa').categoryKey).toBe('expense.food.coffee');
    expect(classifyEntry('lại mua gì')).toMatchObject({
      kind: 'expense',
      kindConfidence: 0.4,
    });
    expect(classifyEntry('luongtam grabfood')).toMatchObject({
      kind: 'expense',
      kindConfidence: 0.4,
      categoryKey: null,
    });
  });

  it('uses longest non-overlapping phrases without counting nested aliases twice', () => {
    const one = classifyEntry('đổ xăng');
    expect(one.kindConfidence).toBe(classifyEntry('xăng').kindConfidence);
    expect(
      one.explanation.filter((line) => line.includes('xăng')),
    ).toHaveLength(1);
    expect(classifyEntry('tiền điện internet').kindConfidence).toBeGreaterThan(
      one.kindConfidence,
    );
  });

  it('keeps wallet hints separate from kind cues and refuses conflicting hints', () => {
    expect(classifyEntry('momo')).toMatchObject({
      kind: 'expense',
      kindConfidence: 0.4,
      walletHint: 'ewallet',
    });
    expect(classifyEntry('rút atm')).toMatchObject({
      kind: 'transfer',
      walletHint: 'bank',
    });
    expect(classifyEntry('vcb tcb').walletHint).toBe('bank');
    expect(classifyEntry('momo tiền mặt').walletHint).toBeNull();
  });

  it('keeps multi-amount candidates separate after classification', () => {
    const result = parse('cf 30k bánh 20k');
    expect(result.candidates).toHaveLength(2);
    expect(result.warnings).toContain('MULTIPLE_AMOUNTS');
    expect(result.candidates.map((c) => c.amount.value)).toEqual([
      30000, 20000,
    ]);
  });

  it('resolves kind ties conservatively and categories only within the chosen kind', () => {
    const lexicon: Lexicon = {
      ...DEFAULT_LEXICON,
      entries: [
        {
          phrases: ['aaa'],
          kind: 'expense',
          category: 'expense.shopping',
          weight: 1,
        },
        {
          phrases: ['bbb'],
          kind: 'income',
          category: 'income.salary',
          weight: 1,
        },
      ],
    };
    expect(classifyEntry('aaa bbb', { lexicon })).toMatchObject({
      kind: 'unknown',
      categoryKey: null,
      warnings: ['AMBIGUOUS_KIND'],
    });
    expect(
      classifyEntry('aaa aaa bbb', { lexicon }).kindConfidence,
    ).toBeLessThan(0.8);
  });

  it.each([
    ['cf 25k', 'cf'],
    ['lương 15tr', 'lương'],
    ['cho Lan mượn 1tr', 'cho'],
    ['Lan trả nợ 1tr', 'nợ'],
    ['mua gì đó 50k', '0.4'],
    ['rút atm 2tr', 'atm'],
  ])('explains the decision for %s', (input, cue) => {
    expect(
      parse(input).candidates[0].explanation.join(' ').toLowerCase(),
    ).toContain(cue);
  });
});

describe('local learning', () => {
  const entry = (
    hitCount: number,
    categoryKey = 'expense.shopping',
    categoryId = 'custom-id',
  ) => ({
    tokenKey: 'sang',
    kind: 'expense' as const,
    categoryKey,
    categoryId,
    hitCount,
    available: true,
  });

  it('requires two confirmations and lets the third parse prefer the confirmed category', () => {
    expect(parse('an sang 30k', [entry(1)]).candidates[0].categoryKey).toBe(
      'expense.food.eating_out',
    );
    expect(parse('an sang 30k', [entry(2)]).candidates[0]).toMatchObject({
      categoryKey: 'expense.shopping',
      categoryIdHint: 'custom-id',
    });
    expect(
      parse('an sang 30k', [entry(2)]).candidates[0].explanation.join(' '),
    ).toContain('sang');
  });

  it('applies the 70% threshold inclusively and counts all competing targets', () => {
    const competing = {
      ...entry(3),
      categoryId: 'other-id',
      categoryKey: 'expense.education',
    };
    expect(
      parse('an sang 30k', [entry(7), competing]).candidates[0].categoryKey,
    ).toBe('expense.shopping');
    expect(
      parse('an sang 30k', [entry(6), competing]).candidates[0].categoryKey,
    ).toBe('expense.food.eating_out');
    expect(
      parse('an sang 30k', [entry(7), { ...competing, available: false }])
        .candidates[0].categoryKey,
    ).toBe('expense.shopping');
    expect(
      parse('an sang 30k', [{ ...entry(7), available: false }, competing])
        .candidates[0].categoryKey,
    ).toBe('expense.food.eating_out');
  });

  it('keeps custom category IDs distinct from system keys', () => {
    const learned: LearningIndex = [{ ...entry(2), categoryKey: null }];
    expect(parse('an sang 30k', learned).candidates[0]).toMatchObject({
      kind: 'expense',
      categoryKey: null,
      categoryIdHint: 'custom-id',
    });
  });

  it('does not learn dates, units, numbers, ambiguous standalone words or repeated tokens', () => {
    expect(
      learningTokens(
        'Ăn ăn sáng hôm nay 30k ngày 15/10 tháng 10 năm 2026 2 triệu rưỡi trả lại',
      ),
    ).toEqual(['an', 'sang']);
  });

  it('removes complete date phrases from edited notes without discarding ăn sáng cues', () => {
    expect(
      learningTokens('sáng nay tối qua chủ nhật thứ 6 tuần trước 7h30'),
    ).toEqual([]);
    expect(learningTokens('ăn sáng chủ nhật')).toEqual(['an', 'sang']);
  });

  it('does not let a learned food cue reverse explicit loan direction', () => {
    expect(parse('mượn Hùng ăn sáng 30k', [entry(10)]).candidates[0].kind).toBe(
      'debt_borrow',
    );
  });

  it('cannot use learned ambiguous words as independent kind cues', () => {
    expect(
      classifyEntry('lai', {
        learned: [
          {
            ...entry(10),
            tokenKey: 'lai',
            kind: 'income',
            categoryKey: 'income.investment',
          },
        ],
      }),
    ).toMatchObject({ kind: 'expense', kindConfidence: 0.4 });
  });

  it('learns an explicit uncategorized choice instead of restoring the seed category', () => {
    expect(
      parse('an sang 30k', [
        { ...entry(2), categoryKey: null, categoryId: null },
      ]).candidates[0],
    ).toMatchObject({ categoryKey: null, categoryIdHint: null });
  });
});
