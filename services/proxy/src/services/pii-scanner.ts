export interface PiiScanResult {
  hasPii: boolean;
  violations: string[];
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
const URL_REGEX = /https?:\/\/[^\s]+/gi;
const VN_PHONE_REGEX = /(?:\+84|0)(?:3[2-9]|5[689]|7[06-9]|8[1-9]|9\d)\d{7}\b/g;
const LONG_DIGIT_RUN_REGEX = /\b\d{10,}\b/g; // 10+ digits: bank account / national ID

// Scan untrusted text for Personal Identifiable Information (PII) before LLM submission.
export function scanPii(text: string): PiiScanResult {
  const violations: string[] = [];

  const emails = text.match(EMAIL_REGEX);
  if (emails) {
    violations.push(...emails);
  }

  const urls = text.match(URL_REGEX);
  if (urls) {
    violations.push(...urls);
  }

  const phones = text.match(VN_PHONE_REGEX);
  if (phones) {
    violations.push(...phones);
  }

  const longDigits = text.match(LONG_DIGIT_RUN_REGEX);
  if (longDigits) {
    violations.push(...longDigits);
  }

  return {
    hasPii: violations.length > 0,
    violations,
  };
}
