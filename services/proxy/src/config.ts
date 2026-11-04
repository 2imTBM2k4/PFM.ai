export interface ProxyConfig {
  port: number;
  host: string;
  nodeEnv: string;
  routerBaseUrl: string;
  routerApiKey: string;
  modelChainFree: string[];
  dailyLimitPerDevice: number;
  ipRateLimitMax: number;
  ipRateLimitWindowMs: number;
  attestationDevBypass: boolean;
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
  approxToleranceBps: number;
  receiptVisionModel: string;
  unlimitedAiTesting: boolean;
}

export const config: ProxyConfig = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  routerBaseUrl: process.env.ROUTER_BASE_URL ?? 'http://127.0.0.1:20128/v1',
  routerApiKey: process.env.ROUTER_API_KEY ?? '',
  modelChainFree: (
    process.env.MODEL_CHAIN_FREE ??
    'gemini-2.0-flash,llama-3.3-70b-versatile'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  dailyLimitPerDevice: parseInt(
    process.env.AI_DAILY_LIMIT_PER_DEVICE ?? '10',
    10,
  ),
  ipRateLimitMax: parseInt(process.env.IP_RATE_LIMIT_MAX ?? '30', 10),
  ipRateLimitWindowMs: parseInt(
    process.env.IP_RATE_LIMIT_WINDOW_MS ?? '3600000',
    10,
  ),
  attestationDevBypass:
    process.env.ATTESTATION_DEV_BYPASS === 'true' ||
    process.env.NODE_ENV !== 'production',
  maxBodyBytes: parseInt(process.env.MAX_BODY_BYTES ?? '16384', 10), // 16KB limit
  upstreamTimeoutMs: parseInt(process.env.UPSTREAM_TIMEOUT_MS ?? '25000', 10),
  approxToleranceBps: parseInt(process.env.APPROX_TOLERANCE_BPS ?? '500', 10),
  receiptVisionModel: process.env.RECEIPT_VISION_MODEL ?? '',
  unlimitedAiTesting:
    process.env.NODE_ENV !== 'production' &&
    process.env.UNLIMITED_AI_TESTING !== 'false',
};
