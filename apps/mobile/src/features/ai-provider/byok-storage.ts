export const BYOK_STORAGE_KEY = 'pfm_web_byok_config_v1';

export type ByokPresetId = 'openai' | 'gemini' | 'openrouter' | 'custom';

export interface ByokProviderPreset {
  id: ByokPresetId;
  label: string;
  baseUrl: string;
  defaultModel: string;
}

export const BYOK_PROVIDER_PRESETS: readonly ByokProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
  },
  {
    id: 'custom',
    label: 'Custom',
    baseUrl: '',
    defaultModel: '',
  },
] as const;

export interface ByokClientConfig {
  enabled: boolean;
  preset: ByokPresetId;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export const DEFAULT_BYOK_CONFIG: ByokClientConfig = {
  enabled: false,
  preset: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
};

function isWebRuntime(): boolean {
  if (process.env.EXPO_OS === 'ios' || process.env.EXPO_OS === 'android') {
    return false;
  }
  return (
    process.env.EXPO_OS === 'web' ||
    (typeof window !== 'undefined' && typeof document !== 'undefined')
  );
}

function getWebStorage(): Storage | null {
  if (!isWebRuntime()) return null;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Reads the local Web BYOK configuration from localStorage. Always returns default on native platforms. */
export function readByokConfig(): ByokClientConfig {
  const storage = getWebStorage();
  if (!storage) return { ...DEFAULT_BYOK_CONFIG };
  try {
    const raw = storage.getItem(BYOK_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BYOK_CONFIG };
    const parsed = JSON.parse(raw) as Partial<ByokClientConfig>;
    const preset: ByokPresetId =
      parsed.preset === 'openai' ||
      parsed.preset === 'gemini' ||
      parsed.preset === 'openrouter' ||
      parsed.preset === 'custom'
        ? parsed.preset
        : 'custom';
    return {
      enabled: parsed.enabled === true,
      preset,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim() : '',
      model: typeof parsed.model === 'string' ? parsed.model.trim() : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '',
    };
  } catch {
    return { ...DEFAULT_BYOK_CONFIG };
  }
}

/** Saves the Web BYOK configuration locally in browser localStorage (never synced to Google Drive). */
export function saveByokConfig(config: ByokClientConfig): ByokClientConfig {
  const normalized: ByokClientConfig = {
    enabled: config.enabled,
    preset: config.preset,
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    model: config.model.trim(),
    apiKey: config.apiKey.trim(),
  };
  const storage = getWebStorage();
  if (storage) {
    try {
      storage.setItem(BYOK_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      /* Ignore storage quota errors */
    }
  }
  return normalized;
}

/** Removes the saved Web BYOK configuration and resets to server default. */
export function clearByokConfig(): void {
  const storage = getWebStorage();
  if (!storage) return;
  try {
    storage.removeItem(BYOK_STORAGE_KEY);
  } catch {
    /* Ignore storage errors */
  }
}

/** Returns HTTP passthrough headers when Web BYOK is enabled and complete, or an empty object otherwise. */
export function getActiveByokHeaders(): Record<string, string> {
  if (!isWebRuntime()) return {};
  const cfg = readByokConfig();
  if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    return {};
  }
  return {
    'x-byok-base-url': cfg.baseUrl,
    'x-byok-api-key': cfg.apiKey,
    'x-byok-model': cfg.model,
  };
}

/** Verifies a BYOK configuration against the proxy /v1/byok/test endpoint. */
export async function testByokConnection(
  config: Pick<ByokClientConfig, 'baseUrl' | 'apiKey' | 'model'>,
  proxyBaseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ ok: true; model: string } | { ok: false; message: string }> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  const apiKey = config.apiKey.trim();
  const model = config.model.trim();
  if (!baseUrl || !apiKey || !model) {
    return {
      ok: false,
      message: 'Vui lòng nhập đầy đủ Base URL, Model và API Key.',
    };
  }
  if (!proxyBaseUrl) {
    return {
      ok: false,
      message: 'Chưa cấu hình máy chủ proxy AI.',
    };
  }
  try {
    const response = await fetchImpl(
      `${proxyBaseUrl.replace(/\/+$/, '')}/v1/byok/test`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true',
          'x-byok-base-url': baseUrl,
          'x-byok-api-key': apiKey,
          'x-byok-model': model,
        },
        body: JSON.stringify({}),
      },
    );
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      model?: string;
      message?: string;
    };
    if (!response.ok || !data.ok) {
      return {
        ok: false,
        message:
          typeof data.message === 'string' && data.message.trim()
            ? data.message
            : `Lỗi kết nối (${response.status}).`,
      };
    }
    return { ok: true, model: data.model ?? model };
  } catch {
    return {
      ok: false,
      message: 'Không thể kết nối tới máy chủ proxy để kiểm tra.',
    };
  }
}
