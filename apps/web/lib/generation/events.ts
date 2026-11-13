import type Database from 'better-sqlite3';
import { GenerationService } from './service';
import type { GenerationTask } from './types';

type Event = 'snapshot' | 'tasks' | 'heartbeat';
interface Subscription {
  ids: Set<string>;
  revisions: Map<string, number>;
  send: (event: Event, tasks: GenerationTask[]) => void;
  close: () => void;
}

class GenerationEvents {
  private subscriptions = new Set<Subscription>();
  private timer?: ReturnType<typeof setInterval>;
  private heartbeatAt = Date.now();
  constructor(private service: GenerationService) {}

  subscribe(ids: string[], send: Subscription['send'], close: () => void) {
    const tasks = this.service.getMany(ids);
    const subscription = { ids: new Set(ids), revisions: new Map(tasks.map(t => [t.id, t.revision])), send, close };
    this.subscriptions.add(subscription);
    if (!this.timer) {
      this.heartbeatAt = Date.now();
      this.timer = setInterval(() => this.check(), 500);
    }
    send('snapshot', tasks);
    return () => {
      this.subscriptions.delete(subscription);
      if (!this.subscriptions.size) { clearInterval(this.timer); this.timer = undefined; }
    };
  }

  private check() {
    try {
      const ids = [...new Set([...this.subscriptions].flatMap(s => [...s.ids]))];
      const tasks = this.service.getMany(ids);
      const heartbeat = Date.now() - this.heartbeatAt >= 10_000;
      if (heartbeat) this.heartbeatAt = Date.now();
      for (const subscription of this.subscriptions) {
        const changes = tasks.filter(t => subscription.ids.has(t.id) && subscription.revisions.get(t.id) !== t.revision);
        for (const task of changes) subscription.revisions.set(task.id, task.revision);
        if (changes.length) subscription.send('tasks', changes);
        else if (heartbeat) subscription.send('heartbeat', []);
      }
    } catch {
      // Let clients reconnect and/or use HTTP fallback after a database failure.
      for (const subscription of [...this.subscriptions]) subscription.close();
    }
  }
}

// Database identity survives repeated route calls; global storage also survives dev reloads.
const globalEvents = globalThis as typeof globalThis & { generationEvents?: WeakMap<Database.Database, GenerationEvents> };
const hubs = globalEvents.generationEvents ??= new WeakMap();

export async function generationEvents(request: Request, service: GenerationService): Promise<Response> {
  let ids: unknown;
  try { ids = (await request.json()).taskIds; } catch { return Response.json({ error: '订阅请求无效' }, { status: 400 }); }
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id || id.length > 200))
    return Response.json({ error: '订阅任务列表无效' }, { status: 400 });
  let hub = hubs.get(service.db);
  if (!hub) { hub = new GenerationEvents(service); hubs.set(service.db, hub); }
  let cleanup = () => {};
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let cancelled = false;
      let unsubscribe = () => {};
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        request.signal.removeEventListener('abort', close);
        if (!cancelled) controller.close();
      };
      cleanup = () => { cancelled = true; close(); };
      if (request.signal.aborted) { close(); return; }
      request.signal.addEventListener('abort', close, { once: true });
      try {
        unsubscribe = hub.subscribe(ids as string[], (event, tasks) => {
          if (closed) return;
          // Bound slow-client memory; a reconnect always receives a fresh snapshot.
          if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(tasks)}\n\n`));
        }, close);
        if (closed) unsubscribe();
      } catch { close(); }
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 64 });
  return new Response(stream, { headers: {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no',
  } });
}
