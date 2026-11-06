'use client';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import type { CreateScriptTask, ScriptTask } from './types';

export class ScriptSubmissionError extends Error { constructor(message: string, public definitive: boolean) { super(message); } }

export async function createScriptTask(request: CreateScriptTask): Promise<ScriptTask> {
  const response = await fetch('/api/script/tasks', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(request) });
  const result = await response.json();
  if (!response.ok) throw new ScriptSubmissionError(result.error || '无法创建脚本任务', response.status >= 400 && response.status < 500);
  return result;
}
export async function stopScriptTask(id: string): Promise<ScriptTask> {
  const response = await fetch(`/api/script/tasks/${encodeURIComponent(id)}/stop`, { method: 'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '停止失败，请重试');
  return result;
}
type Listener = (tasks: ScriptTask[], polling: boolean) => void;
class ScriptNotifications {
  tasks = new Map<string, ScriptTask>();
  listeners = new Set<Listener>();
  controller = new AbortController();
  polling = false;
  timer?: ReturnType<typeof setInterval>;
  constructor(public canvasId: string) {
    void fetchEventSource(`/api/script/events?canvasId=${encodeURIComponent(canvasId)}`, {
      signal: this.controller.signal, openWhenHidden: false,
      onopen: async response => {
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('通知连接不可用');
        clearInterval(this.timer); this.timer = undefined; this.polling = false; this.emit();
      },
      onmessage: event => { if (event.event === 'tasks') this.apply(JSON.parse(event.data)); },
      onclose: () => { throw new Error('通知连接已关闭'); },
      onerror: () => { this.fallback(); return 5000; },
    }).catch(() => this.fallback());
  }
  apply(tasks: ScriptTask[]) {
    for (const task of tasks) if (!this.tasks.has(task.id) || this.tasks.get(task.id)!.revision < task.revision) this.tasks.set(task.id, task);
    this.emit();
  }
  emit() { const tasks = [...this.tasks.values()].sort((a,b) => b.createdAt-a.createdAt); for (const listener of this.listeners) listener(tasks,this.polling); }
  fallback() {
    if (this.controller.signal.aborted || this.timer) return;
    this.polling = true; this.emit();
    const refresh = async () => { try {
      const response = await fetch(`/api/script/tasks?canvasId=${encodeURIComponent(this.canvasId)}`, { signal:this.controller.signal, cache:'no-store' });
      if (response.ok) this.apply(await response.json());
    } catch {} };
    void refresh(); this.timer = setInterval(() => void refresh(),10_000);
  }
  close() { this.controller.abort(); clearInterval(this.timer); }
}
const connections = new Map<string,ScriptNotifications>();
/** One connection per open canvas; whole snapshots plus monotonic revision make replay harmless. */
export function subscribeScriptTasks(canvasId: string, listener: Listener) {
  let connection = connections.get(canvasId);
  if (!connection) { connection = new ScriptNotifications(canvasId); connections.set(canvasId,connection); }
  connection.listeners.add(listener); connection.emit();
  return () => { connection.listeners.delete(listener); if (!connection.listeners.size) { connection.close(); connections.delete(canvasId); } };
}
