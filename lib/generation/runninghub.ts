import type { TaskSnapshot } from './service';
import type { GenerationInput } from './types';
import { connectVideoReferences, type UploadedReference } from './video-workflow';

export class PlatformError extends Error {
  constructor(public kind: 'transient' | 'business' | 'unknown') { super(kind); }
}
export type PlatformReply = { code: number; data?: unknown; msg?: string };
export type PlatformFetch = typeof fetch;

// Only documented pre-execution rejections establish that no task was accepted.
export const submissionRejections = new Set([301, 380, 412, 415, 416, 421, 433, 435, 436, 801, 802, 803, 806, 810, 811, 812]);
export const transientPlatformErrors = new Set([500, 1000, 1003, 1005, 1010, 1011, 1012]);

// JSON.parse's reviver runs after numeric precision has already been lost. Tokenize
// JSON strings/numbers first, quoting only integer tokens outside the safe range.
export function parsePlatformJson(raw: string): PlatformReply {
  const safe = raw.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) return JSON.stringify(token);
    return token;
  });
  return JSON.parse(safe);
}

export function submission(snapshot: TaskSnapshot, input: GenerationInput & { seed: number }, references: UploadedReference[] = []) {
  const graph = structuredClone(snapshot.model.workflow);
  const values = { ...input, customResolution: true };
  const nodeInfoList = Object.entries(snapshot.model.mapping).map(([key, mapping]) => {
    const fieldValue = values[key as keyof typeof values];
    graph[mapping.nodeId].inputs[mapping.fieldName] = fieldValue;
    return { ...mapping, fieldValue };
  });
  if (snapshot.model.category === 'VIDEO') connectVideoReferences(graph, snapshot, input, references);
  // Pin the whole exported graph, including bypass, weights and LoRAs, so editing
  // the remote workflow after enqueueing cannot alter an existing task's meaning.
  return { workflowId: snapshot.model.workflowId, workflow: JSON.stringify(graph), nodeInfoList };
}

export async function platformCall(snapshot: TaskSnapshot, endpoint: 'create' | 'outputs', body: object,
  fetcher: PlatformFetch, diagnostic: (reply: unknown) => void): Promise<PlatformReply> {
  const c = snapshot.connection;
  const key = process.env[c.apiKeyEnv];
  if (!key) throw new PlatformError('business');
  let response: Response;
  try {
    response = await fetcher(`${c.baseUrl.replace(/\/$/, '')}/task/openapi/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ apiKey: key, ...body }), signal: AbortSignal.timeout(c.requestTimeoutMs), redirect: 'error',
    });
    if (!response.ok) {
      diagnostic({ httpStatus: response.status });
      throw new PlatformError(response.status >= 500 || response.status === 429 ? 'transient' : 'business');
    }
    const result = parsePlatformJson(await response.text());
    diagnostic(result);
    if (typeof result?.code !== 'number') throw new PlatformError('unknown');
    return result;
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError('transient');
  }
}

// Diagnostics are private, but still strip credentials, websocket auth URLs and
// signed URL queries. Known secret values are removed even when echoed in text.
export function redact(value: unknown, secrets: string[]): string {
  const clean = (item: unknown, key = ''): unknown => {
    if (/key|token|authorization|password|secret|wss/i.test(key)) return '[redacted]';
    if (Array.isArray(item)) return item.map(v => clean(v));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, clean(v, k)]));
    if (typeof item === 'string') {
      let result = item;
      for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[redacted]');
      return result.replace(/((?:https?|wss):\/\/[^\s"?]+)\?[^\s"]*/g, '$1?[redacted]');
    }
    return item;
  };
  return JSON.stringify(clean(value));
}
