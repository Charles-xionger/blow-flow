import { ImageGenerationError } from './image-errors';
import { isDeepStrictEqual } from 'node:util';
import { validGenerationDimensions } from './dimensions';
import { geminiImageConfig, geminiImageParameters, generateExistingGeminiImage } from './gemini-image';
import { generateSeedreamImage } from './seedream';
import { validateImageGenerationInput } from './image-options';
import type { TaskSnapshot } from './service';
import type { ConnectionConfig, GenerationInput, ImageModelConfig } from './types';

export interface ImageGenerationIO {
  beforeSubmit: () => void;
  renewPreparation?: () => void;
  fetch?: typeof fetch;
}
interface ImageAdapter {
  generate: (snapshot: TaskSnapshot, input: GenerationInput, io: ImageGenerationIO) => Promise<string[]>;
  validateInput: (input: GenerationInput, model: ImageModelConfig) => void;
  validateModel: (model: ImageModelConfig, connection: ConnectionConfig) => void;
}
const adapters: Record<ImageModelConfig['adapter'], ImageAdapter> = {
  'gemini-image': {
    generate: async (snapshot, input, io) => [await generateExistingGeminiImage(snapshot, input, io.beforeSubmit)],
    validateInput(input) {
      geminiImageParameters(input);
      if (input.imageOptions !== undefined || input.duration !== undefined || input.instanceType !== undefined ||
        (input.references ?? []).some(r => r.kind !== 'image') || (input.references?.length ?? 0) > 8) throw new Error('不支持的 Gemini 图片参数');
    },
    validateModel(model, connection) {
      const expected = geminiImageConfig();
      if (model.category !== 'IMAGE' || model.id !== expected.models[0].id || connection.apiKeyEnv !== 'GEMINI_API_KEY' ||
        connection.baseUrl !== expected.connections[0].baseUrl || !isDeepStrictEqual(model.capabilities, expected.models[0].capabilities))
        throw new Error('Invalid Gemini image model');
    },
  },
  'ark-image': {
    generate: generateSeedreamImage,
    validateInput: (input, model) => validateImageGenerationInput(input, model.capabilities.image!),
    validateModel(model) {
      const image = model.capabilities.image;
      if (model.category !== 'IMAGE' || !model.providerModel || !/^[a-zA-Z0-9._-]+$/.test(model.providerModel) ||
        !model.capabilities.prompt || model.capabilities.video || !image || !Number.isSafeInteger(image.maxImages) || image.maxImages < 0 || image.maxImages > 15 ||
        model.capabilities.referenceImages !== (image.maxImages > 0)) throw new Error('Invalid Ark image model capabilities');
      const limits = image.pixelLimits, options = image.options;
      if (!limits || !Number.isSafeInteger(limits.min) || !Number.isSafeInteger(limits.max) || limits.min < 1 || limits.max < limits.min ||
        !Number.isFinite(limits.maxAspectRatio) || limits.maxAspectRatio < 1 || !options ||
        !Array.isArray(options.outputFormats) || !options.outputFormats.length || options.outputFormats.some(v => !['png','jpeg'].includes(v)) ||
        !Array.isArray(options.promptOptimizations) || !options.promptOptimizations.length || options.promptOptimizations.some(v => !['standard','fast'].includes(v)) ||
        typeof options.watermark !== 'boolean' || typeof options.transparentBackground !== 'boolean' ||
        !Array.isArray(image.sizes) || !image.sizes.length || image.sizes.some(v => typeof v !== 'string' || !v) ||
        !Array.isArray(image.aspectRatios) || !image.aspectRatios.length || image.aspectRatios.some(v => !/^\d+:\d+$/.test(v)) ||
        !Array.isArray(image.presets) || !image.presets.length) throw new Error('Invalid image capabilities');
      const d = model.capabilities.dimensions;
      if (![d.min,d.max,d.step,d.defaultWidth,d.defaultHeight].every(Number.isSafeInteger) || d.min < 1 || d.max < d.min || d.step < 1 ||
        !validGenerationDimensions(d, d.defaultWidth, d.defaultHeight)) throw new Error('Invalid image dimensions');
      for (const preset of image.presets) {
        if (!image.sizes.includes(preset.size) || !image.aspectRatios.includes(preset.ratio) || !validGenerationDimensions(d, preset.width, preset.height))
          throw new Error('Invalid image preset');
        validateImageGenerationInput({ prompt: 'validate', width: preset.width, height: preset.height }, image);
      }
      if (!image.presets.some(p => p.width === d.defaultWidth && p.height === d.defaultHeight)) throw new Error('Default image dimensions must match a preset');
      validateImageGenerationInput({ prompt: 'validate', width: d.defaultWidth, height: d.defaultHeight }, image);
    },
  },
};
export function validateImageModel(model: ImageModelConfig, connection: ConnectionConfig) {
  const adapter = adapters[model.adapter];
  if (!adapter) throw new Error('Unsupported image adapter');
  adapter.validateModel(model, connection);
}
export function validateImageInput(model: ImageModelConfig, input: GenerationInput) {
  adapters[model.adapter].validateInput(input, model);
}
/** Synchronous providers return original artifacts; the task layer owns persistence and saving. */
export async function generateImage(snapshot: TaskSnapshot, input: GenerationInput, io: ImageGenerationIO): Promise<string[]> {
  if (snapshot.model.adapter === 'runninghub-workflow') throw new Error('Workflow generation requires asynchronous tracking');
  try { validateImageInput(snapshot.model, input); }
  catch (error) { throw new ImageGenerationError(error instanceof Error ? error.message : '无效的图片参数', 'preparation'); }
  return adapters[snapshot.model.adapter].generate(snapshot, input, io);
}
