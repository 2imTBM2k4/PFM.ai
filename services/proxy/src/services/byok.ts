import { isIP } from 'node:net';
import { AppError } from '../errors/app-error';

export interface ByokConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const BYOK_HEADERS = {
  baseUrl: 'x-byok-base-url',
  apiKey: 'x-byok-api-key',
  model: 'x-byok-model',
} as const;

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return (raw[0] ?? '').trim();
  return typeof raw === 'string' ? raw.trim() : '';
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIpv6(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '::' || host === '::1') return true;
  if (host.startsWith('fc') || host.startsWith('fd')) return true;
  if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
    return true;
  }
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isBlockedIpv4(mapped);
    return true;
  }
  return false;
}

/** Validates a user-supplied BYOK base URL with strict HTTPS and SSRF protections. */
export function validateByokBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw AppError.badRequest('Base URL không hợp lệ.');
  }

  if (parsed.protocol !== 'https:') {
    throw AppError.badRequest('BYOK Base URL bắt buộc sử dụng HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw AppError.badRequest('Base URL không được chứa thông tin đăng nhập.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) {
    throw AppError.badRequest('Base URL không được trỏ tới địa chỉ nội bộ.');
  }

  if (/^(0x[0-9a-f]+|\d+)$/i.test(hostname)) {
    throw AppError.badRequest('Base URL không được sử dụng địa chỉ IP nội bộ.');
  }

  const unbracketed = hostname.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(unbracketed);
  if (ipVersion === 4 && isBlockedIpv4(unbracketed)) {
    throw AppError.badRequest('Base URL không được trỏ tới dải IP nội bộ.');
  }
  if (ipVersion === 6 && isBlockedIpv6(unbracketed)) {
    throw AppError.badRequest('Base URL không được trỏ tới dải IP nội bộ.');
  }

  return parsed.toString().replace(/\/+$/, '');
}

/** Parses and validates BYOK headers. Returns null when no BYOK header is sent. */
export function parseByokHeaders(
  headers: Record<string, string | string[] | undefined>,
): ByokConfig | null {
  const baseUrlRaw = readHeader(headers, BYOK_HEADERS.baseUrl);
  const apiKey = readHeader(headers, BYOK_HEADERS.apiKey);
  const model = readHeader(headers, BYOK_HEADERS.model);

  if (!baseUrlRaw && !apiKey && !model) {
    return null;
  }
  if (!baseUrlRaw || !apiKey || !model) {
    throw AppError.badRequest(
      'Cấu hình AI cá nhân thiếu Base URL, Model hoặc API Key.',
    );
  }
  if (apiKey.length > 512 || /[\r\n]/.test(apiKey)) {
    throw AppError.badRequest('API Key không hợp lệ.');
  }
  if (model.length > 128 || /[\r\n]/.test(model)) {
    throw AppError.badRequest('Tên model không hợp lệ.');
  }

  return {
    baseUrl: validateByokBaseUrl(baseUrlRaw),
    apiKey,
    model,
  };
}
