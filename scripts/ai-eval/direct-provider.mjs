const ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
};

// Send only synthetic evaluation fixtures to a fixed official provider endpoint.
export async function completeDirectProvider(
  { provider, accountId, apiKey, model, messages, maxTokens = 600 },
  send = fetch,
) {
  const endpoint =
    provider === 'cloudflare' && /^[a-f0-9]{32}$/i.test(accountId ?? '')
      ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`
      : ENDPOINTS[provider];
  if (
    !endpoint ||
    typeof apiKey !== 'string' ||
    !apiKey.trim() ||
    typeof model !== 'string' ||
    !/^[\w@/.:-]{1,160}$/.test(model) ||
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
  )
    throw new Error('EVAL_CONFIG_INVALID');

  const started = performance.now();
  let response;
  try {
    response = await send(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
  } catch {
    throw new Error('EVAL_TRANSPORT_FAILED');
  }
  const result = {
    model,
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
    throw new Error('EVAL_RESPONSE_INVALID');
  }
  result.answer =
    typeof data?.choices?.[0]?.message?.content === 'string'
      ? data.choices[0].message.content.trim()
      : null;
  result.returnedModel =
    typeof data?.model === 'string' && /^[\w@/.:[\]-]{1,160}$/.test(data.model)
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
