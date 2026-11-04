import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { vi as messages, viMessages } from './vi';
import { en } from './en';
import { setActiveLanguage } from './language';
import { displayCategoryName, displayWalletName } from './seed-labels';

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')
        ? [path]
        : [];
  });
}

it('all referenced Vietnamese catalog keys exist and have nonempty messages', () => {
  const keys = new Set(Object.keys(messages));
  for (const path of sources(resolve('apps/mobile/src'))) {
    for (const match of readFileSync(path, 'utf8').matchAll(/\bvi\.(\w+)/g)) {
      expect(keys.has(match[1]), `${path}: vi.${match[1]}`).toBe(true);
    }
  }
  for (const value of Object.values(messages))
    expect(value.trim().length).toBeGreaterThan(0);
});

it('covers every message in English and switches the displayed text', () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(messages).sort());
  for (const value of Object.values(en)) expect(value.trim().length).toBeGreaterThan(0);
  for (const key of Object.keys(viMessages) as (keyof typeof viMessages)[]) {
    const placeholders = (value: string) => [...value.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort();
    expect(placeholders(en[key]), key).toEqual(placeholders(viMessages[key]));
  }
  setActiveLanguage('en');
  expect(messages.overview).toBe('Overview');
  expect(messages.aiReplyOutOfScope).toContain('personal money management');
  expect(displayCategoryName('Tiền nhà')).toBe('Rent');
  expect(displayCategoryName('My custom category')).toBe('My custom category');
  expect(displayWalletName('Tiền mặt')).toBe('Cash');
  setActiveLanguage('vi');
  expect(messages.overview).toBe('Tổng quan');
});
