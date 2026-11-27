import type { AdviceRequest } from '@pfm/contracts';
import { ADVICE_SYSTEM_PROMPT, knowledgePrompt } from '@pfm/domain';

import { config } from '../config';
import { AppError } from '../errors/app-error';
import { getActiveByok, recordModelResponse } from '../middleware/logging';
import type { ByokConfig } from './byok';
import { admitModelCall } from '../middleware/rate-limit';

export const SYSTEM_PROMPT = ADVICE_SYSTEM_PROMPT;

export interface UpstreamResult {
  answer: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

export type FetchFn = typeof fetch;

export class UpstreamAiService {
  private toolStepTimeoutMs = 15_000;
  constructor(private fetchImpl: FetchFn = fetch) {}

  // Format the user prompt combining untrusted question, history and verified financial data.
  buildUserPrompt(req: AdviceRequest): string {
    const historyBlock =
      req.history.length > 0 ? JSON.stringify(req.history) : '';
    const dataBlock = JSON.stringify({
      intent: req.intent,
      calculations: req.calculations,
      summary: req.summary,
    });

    return `<question>${req.question}</question>
<history>${historyBlock}</history>
<data>${dataBlock}</data>`;
  }

  async callModel(req: AdviceRequest, modelIndex = 0): Promise<UpstreamResult> {
    return this.callPrompt(
      `${SYSTEM_PROMPT}${knowledgePrompt(req.question)}\nAnswer entirely in Vietnamese.`,
      this.buildUserPrompt(req),
      modelIndex,
    );
  }

  /** Send one tool step without consuming its JSON body or SSE stream, and without retries. */
  async callToolStep(payload: {
    model: string;
    messages: unknown[];
    tools?: unknown[];
    tool_choice?: 'auto' | 'none';
    stream: boolean;
    max_tokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<Response> {
    admitModelCall();
    const byok = getActiveByok();
    const baseUrl = (byok?.baseUrl ?? config.routerBaseUrl).replace(/\/$/, '');
    const apiKey = byok ? byok.apiKey : config.routerApiKey;
    const effectiveModel = byok ? byok.model : payload.model;
    const { signal, timeoutMs, ...body } = payload;
    const timeout = AbortSignal.timeout(timeoutMs ?? this.toolStepTimeoutMs);
    const response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...body,
        model: effectiveModel,
        temperature: 0.2,
        max_tokens: payload.max_tokens ?? 2048,
        ...(payload.tools?.length && payload.tool_choice !== 'none'
          ? { parallel_tool_calls: false }
          : {}),
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.ok) recordModelResponse(effectiveModel);
    return response;
  }

  async callPrompt(
    systemPrompt: string,
    userPrompt: string,
    modelIndex = 0,
  ): Promise<UpstreamResult> {
    admitModelCall();
    const byok = getActiveByok();
    const model =
      byok?.model ??
      config.modelChainFree[modelIndex] ??
      config.modelChainFree[0] ??
      'default';

    const baseUrl = (byok?.baseUrl ?? config.routerBaseUrl).replace(/\/$/, '');
    const apiKey = byok ? byok.apiKey : config.routerApiKey;
    const url = `${baseUrl}/chat/completions`;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      config.upstreamTimeoutMs,
    );

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 2048,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Upstream returned status ${res.status}`);
      }

      const data = (await res.json()) as {
        choices?: { finish_reason?: string; message?: { content?: string } }[];
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const answer = data.choices?.[0]?.message?.content?.trim();
      if (!answer || data.choices?.[0]?.finish_reason === 'length') {
        throw new Error('Empty response from model.');
      }
      recordModelResponse(data.model ?? model);

      return {
        answer,
        model: data.model ?? model,
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
      };
    } catch {
      // Retry once on the next model in chain if available
      if (!byok && modelIndex + 1 < config.modelChainFree.length) {
        return this.callPrompt(systemPrompt, userPrompt, modelIndex + 1);
      }
      throw AppError.upstreamUnavailable(
        'KhÃ´ng thá»ƒ káº¿t ná»‘i tá»›i dá»‹ch vá»¥ AI upstream.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async callVision(prompt: string, imageBase64: string): Promise<string> {
    if (!config.receiptVisionModel)
      throw AppError.upstreamUnavailable('Chưa cấu hình mô hình đọc hóa đơn.');
    admitModelCall();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      config.upstreamTimeoutMs,
    );
    try {
      const response = await this.fetchImpl(
        `${config.routerBaseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.routerApiKey
              ? { Authorization: `Bearer ${config.routerApiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: config.receiptVisionModel,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  {
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
                  },
                ],
              },
            ],
            temperature: 0,
            max_tokens: 2048,
            stream: false,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`Upstream status ${response.status}`);
      const data = (await response.json()) as {
        choices?: { finish_reason?: string; message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (
        typeof content !== 'string' ||
        !content.trim() ||
        data.choices?.[0]?.finish_reason === 'length'
      )
        throw new Error('Empty or truncated vision response');
      recordModelResponse(config.receiptVisionModel);
      return content;
    } catch {
      throw AppError.upstreamUnavailable(
        'Không thể đọc hóa đơn lúc này. Vui lòng thử lại.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Verifies a BYOK provider connection using a minimal completion call without logging the key. */
  async testByokConnection(byok: ByokConfig): Promise<{ model: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await this.fetchImpl(
        `${byok.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${byok.apiKey}`,
          },
          body: JSON.stringify({
            model: byok.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 8,
            temperature: 0,
            stream: false,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw AppError.badRequest('API Key bị từ chối bởi AI provider (401/403).');
        }
        if (response.status === 404) {
          throw AppError.badRequest('Không tìm thấy endpoint hoặc model trên AI provider (404).');
        }
        throw AppError.upstreamUnavailable(
          `AI provider trả về mã lỗi ${response.status}.`,
        );
      }
      const data = (await response.json()) as { model?: string };
      return { model: data.model ?? byok.model };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw AppError.upstreamUnavailable(
        'Không thể kết nối tới AI provider. Vui lòng kiểm tra Base URL và mạng.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  setFetchForTesting(fn: FetchFn, toolStepTimeoutMs = 15_000): void {
    if (!Number.isSafeInteger(toolStepTimeoutMs) || toolStepTimeoutMs <= 0)
      throw new RangeError('Invalid test transport timeout');
    this.fetchImpl = fn;
    this.toolStepTimeoutMs = toolStepTimeoutMs;
  }
}

export const upstreamAiService = new UpstreamAiService();
