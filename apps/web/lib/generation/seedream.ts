import { ImageGenerationError } from './image-errors';
import { seedream55ImageCapabilities, seedreamImageCapabilities, resolveImageOptions, transparentBackgroundNeedsAlphaReference } from './image-options';
import { readReferenceBody, validReferenceUrl } from './reference-files';
import type { GenerationConfig, GenerationInput } from './types';
import type { TaskSnapshot } from './service';
import type { ImageGenerationIO } from './image-adapters';

export function seedreamImageConfig(): GenerationConfig {
  const model = (id: string, name: string, image: typeof seedreamImageCapabilities): GenerationConfig['models'][number] => ({
    id, providerModel: id, name, category: 'IMAGE', adapter: 'ark-image', version: '1', connectionId: 'volcengine-ark',
    capabilities: { prompt: true, referenceImages: true,
      dimensions: { min: 16, max: 8192, step: 1, defaultWidth: 2048, defaultHeight: 2048 }, image: structuredClone(image) },
  });
  return {
    connections: [{ id: 'volcengine-ark', baseUrl: 'https://ark.cn-beijing.volces.com', apiKeyEnv: 'ARK_API_KEY',
      concurrency: 5, requestTimeoutMs: 180_000, pollIntervalMs: 5000, queryTimeoutMs: 300_000, maxQueryErrors: 1 }],
    models: [model('doubao-seedream-5-5-261028', 'Seedream 5.5', seedream55ImageCapabilities),
      model('doubao-seedream-5-0-pro-260628', 'Seedream 5.0 Pro', seedreamImageCapabilities)],
  };
}

export async function generateSeedreamImage(snapshot: TaskSnapshot, input: GenerationInput, io: ImageGenerationIO): Promise<string[]> {
  if (snapshot.model.adapter !== 'ark-image') throw new Error('Invalid image adapter');
  const key = process.env[snapshot.connection.apiKeyEnv];
  if (!key) throw new ImageGenerationError('火山引擎 API Key 未配置', 'preparation');
  const options = resolveImageOptions(input.imageOptions, snapshot.model.capabilities.image!);
  const images: string[] = [];
  for (const reference of input.references ?? []) {
    if (!validReferenceUrl(reference.url)) throw new ImageGenerationError('请先将参考素材上传到本项目存储', 'preparation');
    io.renewPreparation?.();
    const response = await (io.fetch ?? fetch)(reference.url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    const bytes = await readReferenceBody(response);
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(bytes, { limitInputPixels: 36_000_000 }).metadata();
    const { width, height } = metadata;
    if (!['png','jpeg','webp'].includes(metadata.format ?? '') || !width || !height || width <= 14 || height <= 14 ||
      width * height > 36_000_000 || width / height < 1/16 || width / height > 16 || (metadata.pages ?? 1) > 1)
      throw new ImageGenerationError('参考图格式或尺寸不符合模型要求', 'preparation');
    if (options?.background === 'transparent' && transparentBackgroundNeedsAlphaReference(snapshot.model.capabilities.image!) && !metadata.hasAlpha)
      throw new ImageGenerationError('透明背景需要带透明通道的参考图', 'preparation');
    images.push(reference.url);
  }
  const body = { model: snapshot.model.providerModel ?? snapshot.model.id, prompt: input.prompt, size: `${input.width}x${input.height}`,
    ...(images.length ? { image: images } : {}),
    response_format: 'url', output_format: options?.outputFormat ?? 'png', watermark: options?.watermark ?? false,
    background: options?.background ?? 'opaque', optimize_prompt_options: { mode: options?.promptOptimization ?? 'standard' } };
  io.beforeSubmit();
  const response = await (io.fetch ?? fetch)(`${snapshot.connection.baseUrl.replace(/\/$/, '')}/api/v3/images/generations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(snapshot.connection.requestTimeoutMs), redirect: 'error',
  });
  if ([400,401,403,404,422,429].includes(response.status)) {
    await response.body?.cancel();
    const reason = response.status === 401 ? 'API Key 无效' : response.status === 403 ? '账号无权限或余额不足' : response.status === 404 ? '模型未开通或不存在' : response.status === 429 ? '请求限流或额度不足' : '参数或内容未通过校验';
    throw new ImageGenerationError(`火山引擎拒绝生成：${reason}`, 'rejected');
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error('生图响应不明确'); }
  const result = await response.json();
  if (!Array.isArray(result?.data) || result.data.length !== 1 || typeof result.data[0].url !== 'string')
    throw new Error('生图响应无效');
  const url = new URL(result.data[0].url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('生图响应无效');
  return [url.href];
}
