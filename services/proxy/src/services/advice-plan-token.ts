import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  AdvicePlanSelectionSchema,
  type AdvicePlanSelection,
} from '@pfm/contracts';

const secret = randomBytes(32);
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const sign = (value: string) =>
  createHmac('sha256', secret).update(value).digest();

// Bind a short-lived metric selection to one question and device without storing user data.
export function createAdvicePlanToken(
  requestId: string,
  question: string,
  deviceId: string,
  selection: AdvicePlanSelection,
  history: unknown[] = [],
  language: 'vi' | 'en' = 'vi',
  currency: 'VND' | 'USD' = 'VND',
): string {
  const payload = Buffer.from(
    JSON.stringify({
      requestId,
      questionHash: digest(question),
      historyHash: digest(JSON.stringify(history)),
      language,
      currency,
      deviceHash: digest(deviceId),
      selection,
      expiresAt: Date.now() + 5 * 60_000,
    }),
  ).toString('base64url');
  return `${payload}.${sign(payload).toString('base64url')}`;
}

export function verifyAdvicePlanToken(
  token: string,
  requestId: string,
  question: string,
  deviceId: string,
  history: unknown[] = [],
  language: 'vi' | 'en' = 'vi',
  currency: 'VND' | 'USD' = 'VND',
): AdvicePlanSelection | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || payload.length > 3500) return null;
  const expected = sign(payload);
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    if (
      decoded.requestId !== requestId ||
      decoded.questionHash !== digest(question) ||
      decoded.historyHash !== digest(JSON.stringify(history)) ||
      decoded.language !== language ||
      decoded.currency !== currency ||
      decoded.deviceHash !== digest(deviceId) ||
      !Number.isFinite(decoded.expiresAt) ||
      decoded.expiresAt < Date.now()
    )
      return null;
    return AdvicePlanSelectionSchema.parse(decoded.selection);
  } catch {
    return null;
  }
}
