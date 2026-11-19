import type { CanvasNode } from '../../types';
import type { AgentMessage, AgentQuestion, AgentTask } from './types';
import type { CanvasOperation } from './canvas-plan';
import { GoRunCanvasHTTP } from './go-canvas';

export class GoAgentRequestError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

type WireTask = Omit<AgentTask, 'createdAt' | 'steps'> & { createdAt: string; steps?: never };
type WireMessage = Omit<AgentMessage, 'createdAt'> & { createdAt: string };
type WireStep = { callId: string; runId: string; name: string; arguments: Record<string, unknown>; status: 'running' | 'completed' | 'failed'; result?: unknown; createdAt: string };
type WireContext = { task: WireTask; messages: WireMessage[]; steps: WireStep[] };
export type GoRunClaim = { task: WireTask; runId: string; token: string; leaseUntil: string };

export class GoAgentRunClient {
  constructor(private baseURL: string, private runnerKey: string, private fetcher: typeof fetch = fetch) {}

  private async request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseURL.replace(/\/$/, '')}/internal/agent${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return undefined as T;
    const body: unknown = await response.json();
    if (!response.ok) {
      const code = typeof body === 'object' && body && 'error' in body && typeof body.error === 'string' ? body.error : 'agent_error';
      throw new GoAgentRequestError(response.status, code);
    }
    return body as T;
  }

  claim(taskId: string) { return this.request<GoRunClaim>(`/tasks/${encodeURIComponent(taskId)}/claim`, this.runnerKey, { method: 'POST' }); }

  run(token: string) { return new GoAgentRun(this.baseURL, token, this.fetcher, this.request.bind(this)); }
}

export class GoAgentRun {
  private alive = true;
  constructor(private baseURL: string, private token: string, private fetcher: typeof fetch,
    private request: <T>(path: string, token: string, init?: RequestInit) => Promise<T>) {}

  isAlive() { return this.alive; }
  canvas(projectId: string) { return new GoRunCanvasHTTP(this.baseURL, projectId, this.token, this.fetcher); }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    try { return await this.request<T>(path, this.token, init); }
    catch (error) { if (error instanceof GoAgentRequestError && error.status === 401) this.alive = false; throw error; }
  }
  async context() {
    const wire = await this.call<WireContext>('/run/context');
    const steps = wire.steps.map(step => ({ id: step.callId, runId: step.runId, name: step.name, args: step.arguments, result: step.result, status: step.status, createdAt: Date.parse(step.createdAt) }));
    const task: AgentTask = { ...wire.task, createdAt: Date.parse(wire.task.createdAt), steps };
    const messages: AgentMessage[] = wire.messages.map(message => ({ ...message, createdAt: Date.parse(message.createdAt) }));
    return { task, messages };
  }
  heartbeat() { return this.call<{ leaseUntil: string }>('/run/heartbeat', { method: 'POST' }); }
  async reply(callId: string, text: string) { await this.call<void>('/run/reply', { method: 'POST', body: JSON.stringify({ callId, text }) }); }
  startStep(callId: string, name: string, args: Record<string, unknown>) { return this.call<WireStep>('/run/steps/start', { method: 'POST', body: JSON.stringify({ callId, name, arguments: args }) }); }
  finishStep(callId: string, status: 'completed' | 'failed', result: unknown) { return this.call<WireStep>('/run/steps/finish', { method: 'POST', body: JSON.stringify({ callId, status, result }) }); }
  async question(question: AgentQuestion) { await this.call<void>('/run/question', { method: 'POST', body: JSON.stringify(question) }); this.alive = false; }
  async finish(status: 'completed' | 'failed' | 'stopped') { await this.call<void>('/run/finish', { method: 'POST', body: JSON.stringify({ status }) }); this.alive = false; }
  async receipt(projectId: string, callId: string) { return this.canvas(projectId).receipt(projectId, callId); }
  async edit(projectId: string, callId: string, operations: CanvasOperation[], snapshot: unknown, baseVersion: number, label: string, skipped: string[]) {
    return this.canvas(projectId).save(projectId, callId, baseVersion, snapshot as Parameters<GoRunCanvasHTTP['save']>[3], operations, skipped, label);
  }
  async deleted(projectId: string, ids: string[]): Promise<string[]> { return this.canvas(projectId).deleted(projectId, ids); }
  async nodes(projectId: string): Promise<CanvasNode[]> { return (await this.canvas(projectId).read(projectId)).snapshot.nodes as CanvasNode[]; }
}
