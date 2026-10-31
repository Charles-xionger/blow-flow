export type GenerationStatus = 'cancelled' | 'queued' | 'submitting' | 'running' | 'uncertain' | 'timed_out' | 'succeeded' | 'failed';
export type SaveStatus = 'pending' | 'saving' | 'saved' | 'failed';
export interface GenerationInput { prompt: string; width: number; height: number }
export interface CreateGeneration {
  requestId: string; modelId: string; input: GenerationInput;
  canvasId: string; nodeId: string;
}
export interface PublicModel {
  id: string; name: string; category: 'IMAGE' | 'VIDEO' | 'TEXT'; configured: boolean;
  capabilities: { prompt: true; referenceImages: false; dimensions: { min: number; max: number; step: number; defaultWidth: number; defaultHeight: number } };
}
export interface GenerationTask extends CreateGeneration {
  id: string; modelVersion: string; status: GenerationStatus; saveStatus: SaveStatus;
  createdAt: number; updatedAt: number; deadline: number | null; artifacts: string[]; error: string | null;
}
export interface WorkflowNode { inputs: Record<string, unknown>; class_type: string; _meta?: Record<string, unknown> }
export interface ModelConfig {
  id: string; name: string; category: 'IMAGE'; adapter: 'runninghub-workflow'; version: string; connectionId: string;
  workflowId: string; workflow: Record<string, WorkflowNode>; outputNode: string;
  mapping: Record<'prompt' | 'width' | 'height' | 'seed' | 'customResolution', { nodeId: string; fieldName: string }>;
  capabilities: PublicModel['capabilities'];
}
export interface ConnectionConfig {
  id: string; baseUrl: string; apiKeyEnv: string; concurrency: number;
  requestTimeoutMs: number; pollIntervalMs: number; queryTimeoutMs: number; maxQueryErrors: number;
}
export interface GenerationConfig { connections: ConnectionConfig[]; models: ModelConfig[] }
