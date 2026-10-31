import fs from 'node:fs';
import workflow from '../../config/workflows/krea2.json';
import type { GenerationConfig } from './types';

export const defaultConfig: GenerationConfig = {
  connections: [{ id: 'runninghub-international', baseUrl: '', apiKeyEnv: 'RUNNINGHUB_API_KEY', concurrency: 1,
    requestTimeoutMs: 30_000, pollIntervalMs: 5000, queryTimeoutMs: 30 * 60_000, maxQueryErrors: 3 }],
  models: [{ id: 'runninghub-krea2', name: 'Krea2', category: 'IMAGE', adapter: 'runninghub-workflow', version: '1',
    connectionId: 'runninghub-international', workflowId: '2109340746494357505', workflow, outputNode: '103',
    mapping: { prompt: { nodeId: '102', fieldName: 'prompt' }, width: { nodeId: '10', fieldName: 'custom_width' },
      height: { nodeId: '10', fieldName: 'custom_height' }, seed: { nodeId: '97', fieldName: 'seed' },
      customResolution: { nodeId: '10', fieldName: 'use_custom_resolution' } },
    capabilities: { prompt: true, referenceImages: false, dimensions: { min: 64, max: 8192, step: 8, defaultWidth: 1920, defaultHeight: 1080 } } }],
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
    keys(m, ['id', 'name', 'category', 'adapter', 'version', 'connectionId', 'workflowId', 'workflow', 'outputNode', 'mapping', 'capabilities']);
    if (!m.id || models.has(m.id) || !m.version || !m.name || !connections.has(m.connectionId) || m.adapter !== 'runninghub-workflow' || m.category !== 'IMAGE' || typeof m.workflowId !== 'string')
      throw new Error('Invalid generation model');
    models.add(m.id);
    keys(m.capabilities, ['prompt', 'referenceImages', 'dimensions']);
    if (m.capabilities.prompt !== true || m.capabilities.referenceImages !== false) throw new Error('Unsupported capabilities');
    const d = m.capabilities.dimensions;
    keys(d, ['min', 'max', 'step', 'defaultWidth', 'defaultHeight']);
    if (![d.min, d.max, d.step, d.defaultWidth, d.defaultHeight].every(Number.isSafeInteger) || d.min < 64 || d.max > 8192 || d.max < d.min || d.step < 8 || d.step % 8 ||
      [d.defaultWidth, d.defaultHeight].some(n => n < d.min || n > d.max || n % d.step)) throw new Error('Invalid model dimensions');
    keys(m.mapping, ['prompt', 'width', 'height', 'seed', 'customResolution']);
    for (const key of ['prompt', 'width', 'height', 'seed', 'customResolution'] as const) {
      const mapping = m.mapping[key];
      keys(mapping, ['nodeId', 'fieldName']);
      if (!m.workflow[mapping.nodeId] || !(mapping.fieldName in m.workflow[mapping.nodeId].inputs)) throw new Error('Invalid workflow mapping');
    }
    if (!m.workflow[m.outputNode]) throw new Error('Invalid output node');
    // This adapter is for the credential-free Krea2 graph, not arbitrary API nodes.
    const scan = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (/api.?key|token|authorization|password|secret/i.test(key)) throw new Error('Credentials are not allowed in workflow snapshots');
        scan(child);
      }
    };
    scan(m.workflow);
  }
}
