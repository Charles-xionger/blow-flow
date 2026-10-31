import { getDatabase } from '../db';
import { loadGenerationConfig } from './config';
import { GenerationService } from './service';

export function getGenerationService() {
  return new GenerationService(getDatabase(), loadGenerationConfig());
}
