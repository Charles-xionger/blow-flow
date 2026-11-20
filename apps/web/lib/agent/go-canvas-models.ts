import { loadGenerationConfig } from '../generation/config';
import { geminiImageConfig } from '../generation/gemini-image';
import { getAllModels } from '../model-registry';
import type { CanvasModel } from './canvas-models';

/** Runner-side catalog from deployment configuration; it never opens the legacy canvas database. */
export function goCanvasModels(): CanvasModel[] {
  const config = loadGenerationConfig();
  if (!config.models.some(model => model.adapter === 'gemini-image')) {
    const gemini = geminiImageConfig();
    config.connections.push(...gemini.connections);
    config.models.push(...gemini.models);
  }
  const configured = (connectionId: string) => {
    const connection = config.connections.find(value => value.id === connectionId);
    if (!connection?.baseUrl || !process.env[connection.apiKeyEnv]) return false;
    try {
      const url = new URL(connection.baseUrl);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  };
  const media = config.models.map(model => ({ id: model.id, name: model.name, category: model.category,
    configured: configured(model.connectionId), capabilities: model.capabilities }));
  const text: CanvasModel[] = Object.values(getAllModels()).filter(model => model.category === 'TEXT').map(model => ({
    id: model.id, name: model.name, category: model.category,
    configured: !!(model.provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.ARK_API_KEY),
    legacy: true,
    capabilities: { prompt: true, referenceImages: !!model.vision, dimensions: { min: 0, max: 0, step: 1, defaultWidth: 0, defaultHeight: 0 } },
  }));
  return [...media, ...text];
}
