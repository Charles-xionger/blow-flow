import { geminiImageConfig } from './gemini-image';
import { getDatabase } from '../db';
import { loadGenerationConfig } from './config';
import { GenerationService } from './service';

export function getGenerationService() {
  return new GenerationService(getDatabase(), loadGenerationConfig());
}

/** Agent adapter catalog; legacy manual model menus keep their existing contracts. */
export function getAgentGenerationService() {
  const config = loadGenerationConfig();
  if (!config.models.some(model => model.adapter === 'gemini-image')) {
    const gemini = geminiImageConfig();
    config.connections.push(...gemini.connections); config.models.push(...gemini.models);
  }
  return new GenerationService(getDatabase(), config);
}
