import { getModels, type Api, type Model } from '@mariozechner/pi-ai';
import { arkAgentModel, arkResponsesPayload } from '../ai-services/text/ark';
import { arkTextModel } from '../ai-services/text/ark-models';
import type { AgentModelConfig } from './config';

interface AgentModelBinding {
  model: Model<Api>;
  onPayload?: (payload: unknown) => unknown;
}

/** Resolve administrator config to the common Pi model/transport interface. */
export function resolveAgentModel(config: AgentModelConfig): AgentModelBinding {
  if (config.provider === 'ark' || arkTextModel(config.modelId)) {
    return {
      model: arkAgentModel(config.modelId, config.baseUrl),
      onPayload: payload => arkResponsesPayload(payload, config.webSearch ?? arkTextModel(config.modelId)?.webSearch ?? false),
    };
  }
  const model = getModels('google').find(model => model.id === config.modelId);
  if (!model) throw new Error('Unknown Agent model');
  return { model: { ...model, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) } };
}
