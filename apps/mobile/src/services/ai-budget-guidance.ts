import { foldSearchText } from '@/data/search-text';

/** Identify requests to create a budget without granting any write capability. */
export function isBudgetSetupIntent(prompt: string): boolean {
  const text = foldSearchText(prompt);
  return (
    /\b(ngan sach|budget|dinh muc|han muc)\b/.test(text) &&
    /\b(thiet lap|tao|dat|cai dat|setup|set up|lap|them|create|add|make|new)\b/.test(
      text,
    ) &&
    !/50[ /-]30[ /-]20/.test(text)
  );
}
