import type { Node, Edge, Viewport } from '@xyflow/react';

export interface CanvasSnapshot {
  name: string;
  nodes: Node[];
  edges: Edge[];
  viewport: Viewport;
}
export interface SaveOperation {
  id: string;
  requestId: string;
  baseVersion: number;
  snapshot: CanvasSnapshot;
}
export interface SaveAcknowledgement {
  id: string;
  requestId: string;
  version: number;
}
export class CanvasSaveError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function validateSaveOperation(value: unknown): asserts value is SaveOperation {
  const op = value as SaveOperation | null;
  const snapshot = op?.snapshot;
  if (!op || typeof op.id !== 'string' || !op.id || op.id.length > 200 ||
      typeof op.requestId !== 'string' || !op.requestId || op.requestId.length > 200 ||
      !Number.isSafeInteger(op.baseVersion) || op.baseVersion < 0 ||
      !snapshot || typeof snapshot.name !== 'string' || !snapshot.name.trim() ||
      !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges) ||
      !snapshot.viewport || ![snapshot.viewport.x, snapshot.viewport.y, snapshot.viewport.zoom].every(Number.isFinite) ||
      snapshot.viewport.zoom <= 0 ||
      !snapshot.nodes.every(node => node && typeof node.id === 'string' && node.position &&
        Number.isFinite(node.position.x) && Number.isFinite(node.position.y) && node.data && typeof node.data === 'object') ||
      !snapshot.edges.every(edge => edge && typeof edge.id === 'string' && typeof edge.source === 'string' && typeof edge.target === 'string')) {
    throw new CanvasSaveError('Invalid canvas save: id, requestId, baseVersion and complete snapshot are required');
  }
}

// Stable across JSON object key order, including nested node data.
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
