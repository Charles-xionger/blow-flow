import type { NodeData } from '../../types';
import { resolveImageOptions } from './image-options';
import type { PublicModel } from './types';

/** Match the task renderers available in each image node; legacy models use their existing menus. */
export function supportsImageNodeModel(model: PublicModel, nodeType: string): boolean {
  return model.category === 'IMAGE' && (nodeType !== 'imageToImage' ||
    (model.capabilities.referenceImages && !!model.capabilities.image?.presets?.length));
}

/** Switching models resets stale pixel/preset metadata together. */
export function imageModelSelection(id: string, models: PublicModel[], previousRatio?: string): Partial<NodeData> {
  const model = models.find(model => model.id === id);
  const dimensions = model?.capabilities.dimensions;
  const defaultPreset = model?.capabilities.image?.presets?.find(p => p.width === dimensions?.defaultWidth && p.height === dimensions?.defaultHeight);
  const preset = model?.capabilities.image?.presets?.find(p => p.ratio === previousRatio && p.size === defaultPreset?.size) ?? defaultPreset;
  return { model: id, usesGenerationTasks: !!model, generationWidth: preset?.width ?? dimensions?.defaultWidth, generationHeight: preset?.height ?? dimensions?.defaultHeight,
    generationSizePreset: preset?.size.toLowerCase() as NodeData['generationSizePreset'], aspectRatio: preset?.ratio ?? previousRatio,
    imageOptions: model?.capabilities.image?.options ? resolveImageOptions(undefined, model.capabilities.image) : undefined };
}
