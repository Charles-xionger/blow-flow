import type { TextStreamPhase } from './stream-types';
import { GoogleGenAI } from '@google/genai';
import { getModelDefinition, getModelsByCategory } from '../../model-registry';
import { getAllModelConfigs } from '../../db/model-configs';
import { constructUrl, fetchThirdParty } from '../network';
import { ARK_BASE_URL, ARK_TEXT_MODELS } from './ark-models';
import { generateArkText, streamArkText } from './ark';

export interface TextGenerationInput {
  model?: string;
  prompt: string;
  images?: string[];
  webSearch?: boolean;
  /** Fixed, bounded workflow steps can request a direct answer. */
  thinking?: 'disabled';
  outputFormat?: 'json';
  signal?: AbortSignal;
  onPhase?: (phase: TextStreamPhase) => void;
}
interface TextConnection {
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  endpoint?: string;
}
type TextAdapter = (input: TextGenerationInput, connection: TextConnection) => Promise<string>;

/** Shared image preparation; retry policy belongs to each execution path. */
async function geminiParts(input: TextGenerationInput, signal?: AbortSignal) {
  const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [{ text: input.prompt }];
  for (const image of input.images ?? []) {
    const embedded = image.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/);
    if (embedded) parts.push({ inlineData: { mimeType: embedded[1], data: embedded[2] } });
    else {
      const response = await fetch(image, { signal, redirect: 'error' });
      if (!response.ok) throw new Error('无法读取参考图片');
      parts.push({ inlineData: { mimeType: response.headers.get('content-type')?.split(';')[0] || 'image/jpeg',
        data: Buffer.from(await response.arrayBuffer()).toString('base64') } });
    }
  }
  return parts;
}

const adapters: Record<'gemini' | 'ark' | 'other', TextAdapter> = {
  ark: (input, connection) => generateArkText(connection.modelId, input.prompt, {
    images: input.images, webSearch: input.webSearch, signal: input.signal,
    apiKey: connection.apiKey, baseUrl: connection.baseUrl,
  }),
  gemini: async (input, connection) => {
    const parts = await geminiParts(input, input.signal);
    const ai = new GoogleGenAI({ apiKey: connection.apiKey });
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await ai.models.generateContent({ model: connection.modelId, contents: [{ parts }],
          config: { abortSignal: input.signal, ...(input.webSearch ? { tools: [{ googleSearch: {} }] } : {}) } });
        return result.text || '';
      } catch (error) {
        const failure = error as { status?: number; code?: string };
        if (input.signal?.aborted || attempt >= 2 ||
          !([429, 500, 503].includes(failure.status ?? 0) || ['ECONNRESET', 'ETIMEDOUT'].includes(failure.code ?? ''))) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** attempt));
        input.signal?.throwIfAborted();
      }
    }
  },
  other: async (input, connection) => {
    if (input.webSearch) throw new Error('当前文本适配器不支持联网搜索');
    const content = input.images?.length ? [
      { type: 'text', text: input.prompt },
      ...input.images.map(url => ({ type: 'image_url', image_url: { url } })),
    ] : input.prompt;
    const result = await fetchThirdParty(constructUrl(connection.baseUrl || '', connection.endpoint || '/v1/chat/completions'),
      'POST', { model: connection.modelId, messages: [{ role: 'user', content }], temperature: 0.7 }, connection.apiKey);
    return result.choices?.[0]?.message?.content || '';
  },
};

/** Business callers supply content and model selection; connection/protocol stay here. */
function resolveTextConnection(input: TextGenerationInput) {
  const defaultModel = process.env.ARK_API_KEY
    ? ARK_TEXT_MODELS.find(model => !input.images?.length || model.vision)?.id
    : getModelsByCategory('TEXT').find(model => model.provider === 'gemini')?.id;
  const model = getModelDefinition(input.model || defaultModel || '');
  if (!model || model.category !== 'TEXT') throw new Error('请选择有效的语言模型');
  const provider = model.provider || 'other';
  let connection: TextConnection;
  if (provider === 'ark') connection = { modelId: model.id, apiKey: process.env.ARK_API_KEY || '', baseUrl: ARK_BASE_URL };
  else if (provider === 'gemini') {
    const saved = getAllModelConfigs()[model.name];
    connection = { modelId: saved?.modelId || model.id, apiKey: saved?.key || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '' };
  } else {
    const saved = getAllModelConfigs()[model.name];
    if (!saved) throw new Error(`语言模型 ${model.name} 尚未配置`);
    connection = { modelId: saved.modelId, apiKey: saved.key, baseUrl: saved.baseUrl, endpoint: saved.endpoint };
  }
  if (!connection.apiKey) throw new Error(`语言模型 ${model.name} 的服务端密钥未配置`);
  return { connection, provider };
}

/** Validate configuration without submitting or exposing credentials. */
export function validateTextConfiguration(model: string, hasImages = false): void {
  const definition = getModelDefinition(model);
  if (!definition || definition.category !== 'TEXT') throw new Error('所选语言模型不可用，请重新选择');
  if (hasImages && !definition.vision) throw new Error(`语言模型 ${definition.name} 不支持参考图片`);
  const { provider } = resolveTextConnection({ model, prompt: '' });
  if (provider !== 'ark' && provider !== 'gemini') throw new Error('所选模型尚未提供流式文本能力');
}

export async function generateText(input: TextGenerationInput): Promise<{ text: string; model: string }> {
  const { connection, provider } = resolveTextConnection(input);
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
  const text = await adapters[provider]({ ...input, signal }, connection);
  if (!text.trim()) throw new Error('语言模型未返回文本内容');
  return { text, model: connection.modelId };
}

/** Ordered text deltas; one provider attempt, cancellation and errors propagate to the task owner. */
export async function* streamText(input: TextGenerationInput): AsyncGenerator<string> {
  const { connection, provider } = resolveTextConnection(input);
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
  if (provider === 'ark') {
    yield* streamArkText(connection.modelId, input.prompt, { ...input, signal, apiKey: connection.apiKey, baseUrl: connection.baseUrl });
    return;
  }
  if (provider !== 'gemini') throw new Error('当前模型尚未提供流式文本能力');
  const parts = await geminiParts(input, signal);
  const ai = new GoogleGenAI({ apiKey: connection.apiKey });
  input.onPhase?.('connecting');
  const stream = await ai.models.generateContentStream({ model: connection.modelId, contents: [{ parts }], config: { abortSignal: signal, ...(input.webSearch ? { tools: [{ googleSearch: {} }] } : {}) } });
  input.onPhase?.('waiting');
  let finished = false;
  for await (const chunk of stream) {
    signal.throwIfAborted();
    if (chunk.text) { input.onPhase?.('writing'); yield chunk.text; }
    const reason = chunk.candidates?.[0]?.finishReason;
    if (reason === 'STOP') finished = true;
    else if (reason) throw new Error('模型未完整生成正文');
  }
  if (!finished) throw new Error('模型连接中断，已接收的正文已保留');
}
