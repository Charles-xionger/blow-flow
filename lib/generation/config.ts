import { geminiImageConfig } from './gemini-image';
import { validGenerationDimensions } from './dimensions';
import fs from 'node:fs';
import workflow from '../../config/workflows/krea2.json';
import h3Workflow from '../../config/workflows/h3.json';
import type { GenerationConfig } from './types';

export const defaultConfig: GenerationConfig = {
  connections: [{ id: 'runninghub-international', baseUrl: '', apiKeyEnv: 'RUNNINGHUB_API_KEY', concurrency: 1,
    requestTimeoutMs: 30_000, pollIntervalMs: 5000, queryTimeoutMs: 30 * 60_000, maxQueryErrors: 3 }],
  models: [{ id: 'runninghub-krea2', name: 'Krea2', category: 'IMAGE', adapter: 'runninghub-workflow', version: '1',
    connectionId: 'runninghub-international', workflowId: '2109340746494357505', workflow, outputNode: '103',
    mapping: { prompt: { nodeId: '102', fieldName: 'prompt' }, width: { nodeId: '10', fieldName: 'custom_width' },
      height: { nodeId: '10', fieldName: 'custom_height' }, seed: { nodeId: '97', fieldName: 'seed' },
      customResolution: { nodeId: '10', fieldName: 'use_custom_resolution' } },
    capabilities: { prompt: true, referenceImages: false, dimensions: { min: 64, max: 8192, step: 8, defaultWidth: 1920, defaultHeight: 1080 } } },
    { id: 'runninghub-h3', name: 'H3', category: 'VIDEO', adapter: 'runninghub-workflow', version: '1',
      connectionId: 'runninghub-international', workflowId: '2116745173157138433', workflow: h3Workflow, outputNode: '148',
      mapping: { prompt: { nodeId: '238', fieldName: 'value' }, width: { nodeId: '136', fieldName: 'width' },
        height: { nodeId: '136', fieldName: 'height' }, seed: { nodeId: '129', fieldName: 'noise_seed' },
        duration: { nodeId: '227', fieldName: 'value' } },
      references: { nodeId: '136', imageLoader: '199', videoLoader: '185', audioLoader: '182' },
      capabilities: { prompt: true, referenceImages: true,
        dimensions: { min: 32, max: 4096, step: 32, defaultWidth: 1280, defaultHeight: 736 },
        video: { minDuration: 5, maxDuration: 15, defaultDuration: 7, fps: 24, maxImages: 9, maxVideos: 3, maxAudios: 3 } } }],
};

// Admin-only file; secrets are environment references, never model properties.
export function loadGenerationConfig(): GenerationConfig {
  const config: GenerationConfig = process.env.GENERATION_CONFIG_PATH
    ? JSON.parse(fs.readFileSync(process.env.GENERATION_CONFIG_PATH, 'utf8'))
    : structuredClone(defaultConfig);
  if (!process.env.GENERATION_CONFIG_PATH) config.connections[0].baseUrl = process.env.RUNNINGHUB_BASE_URL || '';
  return config;
}

export function validateGenerationConfig(config: GenerationConfig): void {
  const keys = (value: object, allowed: string[]) => {
    if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unsupported generation configuration field');
  };
  keys(config, ['connections', 'models']);
  const connections = new Set<string>();
  for (const c of config.connections) {
    keys(c, ['id', 'baseUrl', 'apiKeyEnv', 'concurrency', 'requestTimeoutMs', 'pollIntervalMs', 'queryTimeoutMs', 'maxQueryErrors']);
    if (!c.id || connections.has(c.id) || !/^[A-Z][A-Z0-9_]*$/.test(c.apiKeyEnv)) throw new Error('Invalid generation connection');
    connections.add(c.id);
    for (const n of [c.concurrency, c.requestTimeoutMs, c.pollIntervalMs, c.queryTimeoutMs, c.maxQueryErrors]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid generation timing or concurrency');
    }
    if (c.baseUrl) {
      const url = new URL(c.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
        throw new Error('Generation base URL must be an origin without credentials');
    }
  }
  const models = new Set<string>();
  for (const m of config.models) {
    keys(m, ['id', 'name', 'category', 'adapter', 'version', 'connectionId', 'workflowId', 'workflow', 'outputNode', 'mapping', 'capabilities', 'references']);
    if (!m.id || models.has(m.id) || !m.version || !m.name || !connections.has(m.connectionId) || !['runninghub-workflow','gemini-image'].includes(m.adapter) || !['IMAGE', 'VIDEO'].includes(m.category) || typeof m.workflowId !== 'string')
      throw new Error('Invalid generation model');
    models.add(m.id);
    if (m.adapter === 'gemini-image') {
      const expected = geminiImageConfig();
      const connection = config.connections.find(c => c.id === m.connectionId)!;
      const capabilities = expected.models[0].capabilities;
      if (m.category !== 'IMAGE' || m.id !== expected.models[0].id || connection.apiKeyEnv !== 'GEMINI_API_KEY' || connection.baseUrl !== expected.connections[0].baseUrl ||
        m.capabilities.prompt !== true || !m.capabilities.referenceImages || m.capabilities.video || m.capabilities.image?.maxImages !== 8 ||
        JSON.stringify(m.capabilities.image?.sizes) !== JSON.stringify(capabilities.image!.sizes) || JSON.stringify(m.capabilities.image?.aspectRatios) !== JSON.stringify(capabilities.image!.aspectRatios) ||
        Object.entries(capabilities.dimensions).some(([key,value]) => m.capabilities.dimensions[key as keyof typeof capabilities.dimensions] !== value)) throw new Error('Invalid Gemini image model');
      continue;
    }
    keys(m.capabilities, ['prompt', 'referenceImages', 'dimensions', 'video']);
    if (m.capabilities.prompt !== true || m.capabilities.referenceImages !== (m.category === 'VIDEO')) throw new Error('Unsupported capabilities');
    const d = m.capabilities.dimensions;
    keys(d, ['min', 'max', 'step', 'defaultWidth', 'defaultHeight']);
    if (![d.min, d.max, d.step, d.defaultWidth, d.defaultHeight].every(Number.isSafeInteger) || d.min < (m.category === 'VIDEO' ? 32 : 64) || d.max > 8192 || d.max < d.min || d.step < 8 || d.step % 8 ||
      !validGenerationDimensions(d, d.defaultWidth, d.defaultHeight)) throw new Error('Invalid model dimensions');
    keys(m.mapping, ['prompt', 'width', 'height', 'seed', 'customResolution', 'duration']);
    for (const key of ['prompt', 'width', 'height', 'seed', m.category === 'VIDEO' ? 'duration' : 'customResolution'] as const) {
      const mapping = m.mapping[key];
      if (!mapping) throw new Error('Missing workflow mapping');
      keys(mapping, ['nodeId', 'fieldName']);
      if (!m.workflow[mapping.nodeId] || !(mapping.fieldName in m.workflow[mapping.nodeId].inputs)) throw new Error('Invalid workflow mapping');
    }
    if (!m.workflow[m.outputNode]) throw new Error('Invalid output node');
    if (m.category === 'VIDEO') {
      const v = m.capabilities.video;
      const r = m.references;
      if (!v || !r) throw new Error('Missing video capabilities');
      keys(v, ['minDuration', 'maxDuration', 'defaultDuration', 'fps', 'maxImages', 'maxVideos', 'maxAudios']);
      if (!Object.values(v).every(Number.isSafeInteger) || v.minDuration < 1 || v.maxDuration > 15 || v.maxDuration < v.minDuration ||
        v.defaultDuration < v.minDuration || v.defaultDuration > v.maxDuration || v.fps !== 24 ||
        v.maxImages < 0 || v.maxImages > 9 || v.maxVideos < 0 || v.maxVideos > 3 || v.maxAudios < 0 || v.maxAudios > 3 || d.step !== 32)
        throw new Error('Invalid H3 capabilities');
      keys(r, ['nodeId', 'imageLoader', 'videoLoader', 'audioLoader']);
      if (m.workflow[r.nodeId]?.class_type !== 'MiniMaxH3ReferenceToVideo' ||
        m.workflow[r.imageLoader]?.class_type !== 'LoadImage' || m.workflow[r.videoLoader]?.class_type !== 'VHS_LoadVideo' ||
        m.workflow[r.audioLoader]?.class_type !== 'LoadAudio') throw new Error('Invalid reference mapping');
    } else if (m.capabilities.video || m.references || m.mapping.duration) throw new Error('Unexpected video configuration');
    // Only credential-free graphs are accepted; unrelated names such as min_tokens are not credentials.
    const scan = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (/api.?key|access.?token|auth.?token|^token$|authorization|password|secret/i.test(key)) throw new Error('Credentials are not allowed in workflow snapshots');
        scan(child);
      }
    };
    scan(m.workflow);
  }
}
