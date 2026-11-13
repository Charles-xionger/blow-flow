import type { GenerationInput, ImageGenerationOptions, PublicModel } from './types';

export const defaultImageOptions: Required<ImageGenerationOptions> = {
  outputFormat: 'png', watermark: false, promptOptimization: 'standard', background: 'opaque',
};
// Official Seedream Pro pixel presets; unlike Krea2 these are not short-edge sizes.
const ratios = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
const pixels = {
  '1K': [[1024,1024],[1152,864],[864,1152],[1424,800],[800,1424],[1248,832],[832,1248],[1568,672]],
  '1.5K': [[1536,1536],[1792,1344],[1344,1792],[2048,1152],[1152,2048],[1872,1248],[1248,1872],[2352,1008]],
  '2K': [[2048,2048],[2368,1776],[1776,2368],[2816,1584],[1584,2816],[2496,1664],[1664,2496],[3136,1344]],
};
export const seedreamImageCapabilities: NonNullable<PublicModel['capabilities']['image']> = {
  pixelLimits: { min: 921600, max: 4624220, maxAspectRatio: 16 },
  maxImages: 10, sizes: Object.keys(pixels), aspectRatios: ratios,
  presets: Object.entries(pixels).flatMap(([size, dimensions]) => dimensions.map(([width,height], i) => ({ size, ratio: ratios[i], width, height }))),
  options: { outputFormats: ['png','jpeg'], promptOptimizations: ['standard','fast'], watermark: true, transparentBackground: true },
};

export function normalizeImageOptions(value: unknown): ImageGenerationOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的图片高级设置');
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some(key => !Object.hasOwn(defaultImageOptions, key)) ||
    (options.outputFormat !== undefined && !['png','jpeg'].includes(options.outputFormat as string)) ||
    (options.promptOptimization !== undefined && !['standard','fast'].includes(options.promptOptimization as string)) ||
    (options.background !== undefined && !['opaque','transparent'].includes(options.background as string)) ||
    (options.watermark !== undefined && typeof options.watermark !== 'boolean')) throw new Error('无效的图片高级设置');
  return { ...options } as ImageGenerationOptions;
}

export function resolveImageOptions(value: ImageGenerationOptions | undefined, image: NonNullable<PublicModel['capabilities']['image']>): Required<ImageGenerationOptions> {
  return { ...defaultImageOptions,
    outputFormat: image.options?.outputFormats[0] ?? 'png',
    promptOptimization: image.options?.promptOptimizations[0] ?? 'standard',
    ...normalizeImageOptions(value ?? {}),
  };
}

export function validateImageGenerationInput(input: GenerationInput, image: NonNullable<PublicModel['capabilities']['image']>): void {
  const { width, height } = input;
  const limits = image.pixelLimits;
  if (!limits || ![width,height].every(Number.isSafeInteger) || width <= 0 || height <= 0 || width * height < limits.min || width * height > limits.max || width / height < 1/limits.maxAspectRatio || width / height > limits.maxAspectRatio)
    throw new Error(`生成尺寸须符合模型像素与画幅限制（${limits?.min}–${limits?.max} 总像素）`);
  if (input.duration !== undefined || input.instanceType !== undefined || (input.references ?? []).some(r => r.kind !== 'image'))
    throw new Error('此生图模型仅支持图片参考');
  if ((input.references?.length ?? 0) > image.maxImages) throw new Error(`参考图片最多 ${image.maxImages} 张`);
  const options = resolveImageOptions(input.imageOptions, image);
  if (!image.options?.outputFormats.includes(options.outputFormat) || !image.options.promptOptimizations.includes(options.promptOptimization) ||
    (options.watermark && !image.options.watermark) || (options.background === 'transparent' && !image.options.transparentBackground))
    throw new Error('模型不支持所选图片高级设置');
  if (options.background === 'transparent' && (input.references?.length !== 1 || options.outputFormat !== 'png'))
    throw new Error('透明背景需要一张带透明通道的参考图，且输出格式为 PNG');
}
