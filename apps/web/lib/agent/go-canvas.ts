import { createHash } from 'node:crypto';
import type { CanvasSnapshot } from '../canvas/save-protocol';
import { planAgentCanvasEdit, type CanvasOperation } from './canvas-plan';
import type { CanvasModel } from './canvas-models';

export class CanvasStoreError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export interface CanvasStore {
  read(projectId: string): Promise<{ snapshot: CanvasSnapshot; version: number }>;
  deleted(projectId: string, ids: string[]): Promise<string[]>;
  save(projectId: string, requestId: string, baseVersion: number, snapshot: CanvasSnapshot): Promise<{ version: number }>;
}

/** Go owns the snapshot and receipt; the existing TypeScript rules compute the edit. */
export class GoCanvasEditor {
  constructor(private store: CanvasStore, private models: () => CanvasModel[] = () => []) {}

  async apply(projectId: string, identity: string, operations: CanvasOperation[], label = '助手编辑') {
    if (!projectId || !identity || !Array.isArray(operations) || operations.length > 100) throw new Error('Invalid canvas step');
    const requestId = `agent:${createHash('sha256').update(identity).digest('hex')}`;
    const created = operations.flatMap(op => op.kind === 'create' ? [op.node.id] : []);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.store.read(projectId);
      const tombstones = new Set(created.length ? await this.store.deleted(projectId, created) : []);
      const plan = planAgentCanvasEdit(current.snapshot, identity, operations, label, {
        validateInput: true, models: this.models(), tombstoned: id => tombstones.has(id),
      });
      const save = () => this.store.save(projectId, requestId, current.version, plan.snapshot);
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
