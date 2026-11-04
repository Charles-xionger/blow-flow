import { getGenerationService } from '../generation/server';
import { getAllModelConfigs } from '../db/model-configs';
import { getAllModels } from '../model-registry';
import type { PublicModel } from '../generation/types';
export type CanvasModel = PublicModel & { legacy?: true };
/** Existing editor models remain editable; only the task-service catalog supports Agent generation. */
export function canvasModels(): CanvasModel[] {
    const configured = getAllModelConfigs();
    const legacy: CanvasModel[] = Object.entries(getAllModels()).map(([id, model]) => ({ id, name: model.name, category: model.category,
        configured: !!(model.provider === 'gemini' ? process.env.GEMINI_API_KEY : configured[id]?.key || process.env.DEFAULT_API_KEY), legacy: true,
        capabilities: { prompt: true, referenceImages: model.category !== 'TEXT', dimensions: { min: 0, max: 0, step: 1, defaultWidth: 0, defaultHeight: 0 } } }));
    return [...getGenerationService().models(), ...legacy];
}
