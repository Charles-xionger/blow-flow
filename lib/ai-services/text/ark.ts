import type { Model } from '@mariozechner/pi-ai';
import { ARK_BASE_URL, arkTextModel } from './ark-models';

export function arkAgentModel(id: string, baseUrl = ARK_BASE_URL): Model<'openai-responses'> {
  const model = arkTextModel(id);
  if (!model) throw new Error('未知的 Ark 语言模型');
  return {
    id: model.id, name: model.name, api: 'openai-responses',
    // Pi's Responses adapter uses this provider for round-trip function call IDs.
    provider: 'openai', baseUrl, reasoning: false,
    input: model.vision ? ['text', 'image'] : ['text'],
    // Conservative application limits, not advertised provider limits or pricing.
    contextWindow: 128_000, maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/** Adapt Pi's wire payload without changing MCP function tools or conversation history. */
export function arkResponsesPayload(payload: unknown, webSearch: boolean) {
  const body = { ...(payload as Record<string, unknown>) };
  delete body.prompt_cache_key;
  delete body.prompt_cache_retention;
  delete body.reasoning;
  delete body.include;
  if (webSearch) body.tools = [
    ...(Array.isArray(body.tools) ? body.tools : []),
    { type: 'web_search', max_keyword: 3 },
  ];
  return body;
}

export async function generateArkText(id: string, prompt: string, options: {
  apiKey: string;
  baseUrl?: string;
  images?: string[];
  webSearch?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const model = arkTextModel(id);
  if (!model) throw new Error('未知的 Ark 语言模型');
  const key = options.apiKey;
  if (!key) throw new Error('请配置服务端 ARK_API_KEY');
  if (options.images?.length && !model.vision) throw new Error('此模型不支持图片输入，请选择 Doubao Seed 2.1 Pro');
  const response = await fetch(`${(options.baseUrl || ARK_BASE_URL).replace(/\/$/, "")}/responses`, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: model.id, stream: false,
      ...(options.webSearch ? { tools: [{ type: 'web_search', max_keyword: 3 }] } : {}),
      input: [{ role: 'user', content: [
        ...(options.images ?? []).map(image_url => ({ type: 'input_image', image_url })),
        { type: 'input_text', text: prompt },
      ] }],
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Ark 请求失败（HTTP ${response.status}），请检查模型权限、配额与平台配置`);
  }
  const result = await response.json();
  if (result.error || (result.status && result.status !== 'completed')) throw new Error('Ark 生成未完成，请重试');
  const text = (result.output ?? []).filter((item: { type: string }) => item.type === 'message')
    .flatMap((item: { content?: { type: string; text?: string }[] }) => item.content ?? [])
    .filter((part: { type: string; text?: string }) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part: { text: string }) => part.text).join('\n');
  if (!text.trim()) throw new Error('Ark 未返回文本内容');
  return text;
}

/** Responses SSE adapter. Never treats a truncated transport as successful completion. */
export async function* streamArkText(id: string, prompt: string, options: {
  apiKey: string; baseUrl?: string; images?: string[]; webSearch?: boolean; signal?: AbortSignal;
}): AsyncGenerator<string> {
  const model = arkTextModel(id);
  if (!model) throw new Error('未知的 Ark 语言模型');
  if (options.images?.length && !model.vision) throw new Error('此模型不支持图片输入');
  const response = await fetch(`${(options.baseUrl || ARK_BASE_URL).replace(/\/$/, '')}/responses`, {
    method: 'POST', redirect: 'error', signal: options.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({ model: model.id, stream: true,
      ...(options.webSearch ? { tools: [{ type: 'web_search', max_keyword: 3 }] } : {}),
      input: [{ role: 'user', content: [...(options.images ?? []).map(image_url => ({ type: 'input_image', image_url })), { type: 'input_text', text: prompt }] }] }),
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Ark 请求失败（HTTP ${response.status}）`); }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data);
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') yield event.delta;
        if (event.type === 'response.completed') completed = true;
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error('Ark 生成未完成，请检查平台配额和模型配置');
      }
      if (done) break;
    }
    if (!completed) throw new Error('模型连接中断，已接收的正文已保留');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
