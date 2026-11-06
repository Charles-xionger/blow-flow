import type { NodeData } from '../../types';
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
  const preset = model?.capabilities.image?.presets?.find(p => p.width === dimensions?.defaultWidth && p.height === dimensions?.defaultHeight);
  return { model: id, usesGenerationTasks: !!model, generationWidth: dimensions?.defaultWidth, generationHeight: dimensions?.defaultHeight,
    generationSizePreset: preset?.size.toLowerCase() as NodeData['generationSizePreset'], aspectRatio: preset?.ratio ?? previousRatio };
}
