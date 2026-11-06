import { pathToFileURL } from 'node:url';

// Shared local-only transport; callers decide whether to retain synthetic answers for evaluation.
export async function completeRouter(
  { baseUrl, apiKey, model, messages, maxTokens = 600 },
  send = fetch,
) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('PROBE_CONFIG_INVALID');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    typeof apiKey !== 'string' ||
    !apiKey.trim() ||
    typeof model !== 'string' ||
    !model.trim() ||
    model.length > 160 ||
    !Array.isArray(messages) ||
    !messages.length ||
    messages.length > 4 ||
    !messages.every(
      (message) =>
        ['system', 'user', 'assistant'].includes(message.role) &&
        typeof message.content === 'string' &&
        message.content.length <= 20000,
    ) ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > 1200
  ) {
    throw new Error('PROBE_CONFIG_INVALID');
  }
  const started = performance.now();
  let response;
  try {
    response = await send(`${url.href.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: model.trim(),
        messages,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
  } catch {
    throw new Error('PROBE_CONNECTION_FAILED');
  }
  const result = {
    model: model.trim(),
    status: response.status,
    latencyMs: Math.round(performance.now() - started),
    answer: null,
    returnedModel: null,
    finishReason: null,
    promptTokens: null,
    completionTokens: null,
  };
  if (!response.ok) return result;
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('PROBE_RESPONSE_INVALID');
  }
  result.latencyMs = Math.round(performance.now() - started);
  const content = data?.choices?.[0]?.message?.content;
  result.answer = typeof content === 'string' ? content.trim() : null;
  result.returnedModel =
    typeof data?.model === 'string' && /^[\w/.:[\]-]{1,160}$/.test(data.model)
      ? data.model
      : null;
  result.finishReason = [
    'stop',
    'length',
    'content_filter',
    'tool_calls',
  ].includes(data?.choices?.[0]?.finish_reason)
    ? data.choices[0].finish_reason
    : null;
  const count = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : null;
  result.promptTokens = count(data?.usage?.prompt_tokens);
  result.completionTokens = count(data?.usage?.completion_tokens);
  return result;
}

// The smoke probe prints metadata only, never credentials or raw answer/error bodies.
export async function probeRouter(options, send = fetch) {
  const { answer, ...metadata } = await completeRouter(
    {
      ...options,
      messages: [{ role: 'user', content: 'Trả lời duy nhất chữ OK.' }],
      maxTokens: 128,
    },
    send,
  );
  return {
    ...metadata,
    replyMatches: typeof answer === 'string' && /^OK[.!]?$/i.test(answer),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const models = (process.env.EVAL_MODELS ?? '')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean);
    if (!models.length || models.length > 2)
      throw new Error('PROBE_CONFIG_INVALID');
    for (const model of models) {
      const result = await probeRouter({
        baseUrl: process.env.ROUTER_BASE_URL,
        apiKey: process.env.ROUTER_API_KEY,
        model,
      });
      console.log(JSON.stringify(result));
      if (!result.replyMatches) process.exitCode = 1;
      if (result.status === 401 || result.status === 403) break;
    }
  } catch (error) {
    const safe = [
      'PROBE_CONFIG_INVALID',
      'PROBE_CONNECTION_FAILED',
      'PROBE_RESPONSE_INVALID',
    ];
    console.error(
      JSON.stringify({
        error: safe.includes(error?.message) ? error.message : 'PROBE_FAILED',
      }),
    );
    process.exitCode = 1;
  }
}
