import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CanvasSnapshot } from '../canvas/save-protocol';
import { planAgentCanvasEdit, type CanvasOperation } from './canvas-plan';
import type { CanvasModel } from './canvas-models';
import type { CanvasNode } from '../../types';

export class CanvasStoreError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export interface CanvasStore {
  read(projectId: string): Promise<{ snapshot: CanvasSnapshot; version: number }>;
  deleted(projectId: string, ids: string[]): Promise<string[]>;
  save(projectId: string, requestId: string, baseVersion: number, snapshot: CanvasSnapshot, operations?: CanvasOperation[], skipped?: string[], label?: string): Promise<{ version: number }>;
  receipt?(projectId: string, requestId: string): Promise<{ version: number; label: string; skipped: string[]; operations: CanvasOperation[]; removedNodes: CanvasNode[] } | undefined>;
}

/** Go owns the snapshot and receipt; the existing TypeScript rules compute the edit. */
export class GoCanvasEditor {
  constructor(private store: CanvasStore, private models: () => CanvasModel[] = () => []) {}

  async apply(projectId: string, identity: string, operations: CanvasOperation[], label = '助手编辑') {
    if (!projectId || !identity || !Array.isArray(operations) || operations.length > 100) throw new Error('Invalid canvas step');
    const requestId = `agent:${createHash('sha256').update(identity).digest('hex')}`;
    const previous = await this.store.receipt?.(projectId, requestId);
    if (previous) {
      if (previous.label !== label || !isDeepStrictEqual(previous.operations, operations)) throw new CanvasStoreError(409, 'request_conflict');
      return { version: previous.version, skipped: previous.skipped, removedNodes: previous.removedNodes };
    }
    const created = operations.flatMap(op => op.kind === 'create' ? [op.node.id] : []);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.store.read(projectId);
      const tombstones = new Set(created.length ? await this.store.deleted(projectId, created) : []);
      const plan = planAgentCanvasEdit(current.snapshot, identity, operations, label, {
        validateInput: true, models: this.models(), tombstoned: id => tombstones.has(id),
      });
      const save = () => this.store.save(projectId, requestId, current.version, plan.snapshot, operations, plan.skipped, label);
      try {
        const receipt = await save();
        return { version: receipt.version, skipped: plan.skipped, removedNodes: plan.removedNodes };
      } catch (error) {
        if (!(error instanceof CanvasStoreError)) {
          // The first request may have committed. Replay its exact body before reading again.
          try {
            const receipt = await save();
            return { version: receipt.version, skipped: plan.skipped, removedNodes: plan.removedNodes };
          } catch (replayError) {
            const recovered = await this.store.receipt?.(projectId, requestId);
            if (recovered) {
              if (recovered.label !== label || !isDeepStrictEqual(recovered.operations, operations)) throw new CanvasStoreError(409, 'request_conflict');
              return { version: recovered.version, skipped: recovered.skipped, removedNodes: recovered.removedNodes };
            }
            if (replayError instanceof CanvasStoreError && replayError.code === 'version_conflict' && attempt < 2) continue;
            throw replayError;
          }
        }
        if (error.code === 'version_conflict' && attempt < 2) continue;
        throw error;
      }
    }
    throw new Error('Canvas changed during Agent edit');
  }
}

/** Uses the owner-scoped Go resource routes. A future Pi Worker needs a scoped run credential. */
export class GoCanvasHTTP implements CanvasStore {
  constructor(private baseURL: string, private authorization: () => Promise<string> | string, private fetcher: typeof fetch = fetch) {}

  private async request(path: string, init: RequestInit = {}) {
    const response = await this.fetcher(`${this.baseURL.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.authorization()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
    const body = await response.json();
    if (!response.ok) throw new CanvasStoreError(response.status, typeof body.error === 'string' ? body.error : 'resource_error');
    return body;
  }

  async read(projectId: string) {
    const result = await this.request(`/v1/projects/${encodeURIComponent(projectId)}`);
    return { snapshot: result.snapshot as CanvasSnapshot, version: result.version as number };
  }

  async deleted(projectId: string, ids: string[]) {
    const result = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/deleted-nodes/check`, {
      method: 'POST', body: JSON.stringify({ ids }),
    });
    return result.deleted as string[];
  }

  async save(projectId: string, requestId: string, baseVersion: number, snapshot: CanvasSnapshot) {
    const result = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/canvas`, {
      method: 'PUT', body: JSON.stringify({ requestId, baseVersion, snapshot }),
    });
    return { version: result.version as number };
  }
}

/** Internal Runner adapter: the run credential fixes owner and project on the Go side. */
export class GoRunCanvasHTTP implements CanvasStore {
  constructor(private baseURL: string, private projectId: string, private runToken: string, private fetcher: typeof fetch = fetch) {}

  private assertProject(projectId: string) {
    if (projectId !== this.projectId) throw new Error('Run project mismatch');
  }

  private async request(path: string, init: RequestInit = {}) {
    const response = await this.fetcher(`${this.baseURL.replace(/\/$/, '')}/internal/agent/run${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.runToken}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
    const body = await response.json();
    if (!response.ok) throw new CanvasStoreError(response.status, typeof body.error === 'string' ? body.error : 'agent_error');
    return body;
  }

  async read(projectId: string) {
    this.assertProject(projectId);
    const result = await this.request('/canvas');
    return { snapshot: result.snapshot as CanvasSnapshot, version: result.version as number };
  }

  async deleted(projectId: string, ids: string[]) {
    this.assertProject(projectId);
    const result = await this.request('/deleted-nodes/check', { method: 'POST', body: JSON.stringify({ ids }) });
    return result.deleted as string[];
  }

  async receipt(projectId: string, requestId: string) {
    this.assertProject(projectId);
    try {
      const result = await this.request(`/canvas/receipt/${encodeURIComponent(requestId)}`);
      return { version: result.version as number, label: result.label as string, skipped: result.skipped as string[] ?? [],
        operations: result.operations as CanvasOperation[], removedNodes: result.removedNodes as CanvasNode[] ?? [] };
    } catch (error) {
      if (error instanceof CanvasStoreError && error.status === 404) return undefined;
      throw error;
    }
  }

  async save(projectId: string, requestId: string, baseVersion: number, snapshot: CanvasSnapshot, operations: CanvasOperation[] = [], skipped: string[] = [], label = '助手编辑') {
    this.assertProject(projectId);
    const result = await this.request('/canvas', {
      method: 'PUT', body: JSON.stringify({ callId: requestId, label, baseVersion, operations, snapshot, skipped }),
    });
    return { version: result.version as number };
  }
}
