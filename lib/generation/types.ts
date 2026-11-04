export type GenerationStatus = 'cancelled' | 'queued' | 'submitting' | 'running' | 'uncertain' | 'timed_out' | 'succeeded' | 'failed';
export type SaveStatus = 'pending' | 'saving' | 'saved' | 'failed';
export type ReferenceKind = 'image' | 'video' | 'audio';
export interface GenerationReference { kind: ReferenceKind; url: string; useAudio?: boolean }
export interface GenerationInput {
  prompt: string; width: number; height: number;
  duration?: number; references?: GenerationReference[];
  /** RunningHub machine pool; absent means the platform's standard 24G instance. */
  instanceType?: 'plus';
}
export interface CreateGeneration {
  requestId: string; modelId: string; input: GenerationInput;
  canvasId: string; nodeId: string;
}
export interface PublicModel {
  id: string; name: string; category: 'IMAGE' | 'VIDEO' | 'TEXT'; configured: boolean;
  capabilities: {
    prompt: true; referenceImages: boolean;
    image?: { maxImages: number; sizes: string[]; aspectRatios: string[] };
    dimensions: { min: number; max: number; step: number; defaultWidth: number; defaultHeight: number };
    video?: { minDuration: number; maxDuration: number; defaultDuration: number; fps: number;
      maxImages: number; maxVideos: number; maxAudios: number };
  };
}
export interface GenerationTask extends CreateGeneration {
  id: string; modelVersion: string; status: GenerationStatus; saveStatus: SaveStatus;
  revision: number; createdAt: number; updatedAt: number; deadline: number | null; artifacts: string[]; error: string | null;
  outputType?: 'video';
}
export interface WorkflowNode { inputs: Record<string, unknown>; class_type: string; _meta?: Record<string, unknown> }
export interface ModelConfig {
  id: string; name: string; category: 'IMAGE' | 'VIDEO'; adapter: 'runninghub-workflow' | 'gemini-image'; version: string; connectionId: string;
  workflowId: string; workflow: Record<string, WorkflowNode>; outputNode: string;
  mapping: Record<'prompt' | 'width' | 'height' | 'seed', { nodeId: string; fieldName: string }>
    & Partial<Record<'customResolution' | 'duration', { nodeId: string; fieldName: string }>>;
  references?: { nodeId: string; imageLoader: string; videoLoader: string; audioLoader: string };
  capabilities: PublicModel['capabilities'];
}
export interface ConnectionConfig {
  id: string; baseUrl: string; apiKeyEnv: string; concurrency: number;
  requestTimeoutMs: number; pollIntervalMs: number; queryTimeoutMs: number; maxQueryErrors: number;
}
export interface GenerationConfig { connections: ConnectionConfig[]; models: ModelConfig[] }
