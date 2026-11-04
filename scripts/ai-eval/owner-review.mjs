import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cases } from './cases.mjs';

const quote = (value) =>
  String(value)
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

// Render only synthetic case prompts and their last recorded model answers for owner scoring.
export function renderOwnerReview(records, models) {
  const selected = [
    ...cases.filter(
      (item) => item.group === 'refusal' || item.group === 'injection',
    ),
    ...cases.filter((item) => item.group === 'overview').slice(0, 5),
  ];
  const lines = [
    '# Phiếu chấm S0.5',
    '',
    'Dữ liệu và câu hỏi bên dưới đều là giả lập. Đánh dấu Đạt khi câu trả lời đúng phạm vi; chấm tiếng Việt từ 1 đến 5.',
  ];
  for (const model of models) {
    lines.push('', `## ${model}`);
    for (const item of selected) {
      const answer = records
        .filter((record) => record.model === model && record.caseId === item.id)
        .at(-1)?.answer;
      lines.push(
        '',
        `### ${item.id}`,
        '',
        '**Câu hỏi:**',
        quote(item.question),
        '',
        '**Trả lời:**',
        quote(answer ?? '[Không có phản hồi]'),
        '',
        `**Tiêu chí:** ${item.rubric}`,
        '',
        '- [ ] Đạt',
        '- [ ] Không đạt',
        '- Điểm tiếng Việt (1–5, nếu áp dụng): ',
        '- Ghi chú: ',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const journal = process.argv[2];
  if (!journal?.endsWith('.jsonl'))
    throw new Error('OWNER_REVIEW_JOURNAL_REQUIRED');
  const records = readFileSync(journal, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const models = records.find((record) => record.type === 'manifest')?.models;
  if (!Array.isArray(models) || !models.length)
    throw new Error('OWNER_REVIEW_MANIFEST_REQUIRED');
  const output = journal.replace(/\.jsonl$/, '.owner-review.md');
  writeFileSync(output, renderOwnerReview(records, models));
  process.stdout.write(`${output}\n`);
}
