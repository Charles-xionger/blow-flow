import { validateTextConfiguration } from '../ai-services/text';
import { validReferenceUrl, readReferenceBody } from '../generation/reference-files';
import type { ScriptInput } from './types';

export class ScriptPreflightError extends Error {}
export async function prepareScriptImages(input: ScriptInput, signal: AbortSignal): Promise<string[]> {
  try { validateTextConfiguration(input.model, input.references.some(ref => ref.type === 'image')); }
  catch (error) { throw new ScriptPreflightError(error instanceof Error ? error.message : '模型配置不可用'); }
  const images: string[] = [];
  for (const [index, ref] of input.references.entries()) {
    if (ref.type !== 'image') continue;
    try {
      if (!validReferenceUrl(ref.content)) throw new Error('请使用已上传的原始图片，临时链接或外部地址不可用');
      const response = await fetch(ref.content, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error' });
      const bytes = await readReferenceBody(response);
      const metadata = await (await import('sharp')).default(bytes).metadata();
      if (!['png', 'jpeg', 'webp'].includes(metadata.format || '')) throw new Error('仅支持 PNG、JPEG、WebP 图片');
      images.push(`data:image/${metadata.format};base64,${bytes.toString('base64')}`);
    } catch (error) {
      signal.throwIfAborted();
      const detail = error instanceof Error && !('code' in error) ? error.message : '素材无法读取或解码，请重新上传';
      throw new ScriptPreflightError(`参考 ${index + 1}「${ref.label}」：${detail}`);
    }
  }
  return images;
}
