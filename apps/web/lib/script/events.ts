import type { ScriptTask } from './types';
import { getScriptService } from './service';

type Listener = { canvasId: string; revisions: Map<string,number>; send: (tasks: ScriptTask[]) => void; close: () => void };
const state = globalThis as typeof globalThis & { scriptEvents?: { listeners: Set<Listener>; timer?: ReturnType<typeof setInterval>; ticks: number } };
const hub = state.scriptEvents ??= { listeners: new Set<Listener>(), ticks: 0 };
function subscribe(listener: Listener) {
  hub.listeners.add(listener);
  if (!hub.timer) hub.timer = setInterval(() => {
    try {
      const service = getScriptService();
      const canvases = new Map([...new Set([...hub.listeners].map(l => l.canvasId))].map(id => [id, service.list(id)]));
      hub.ticks++;
      for (const item of hub.listeners) {
        const changes = canvases.get(item.canvasId)!.filter(t => item.revisions.get(t.id) !== t.revision);
        for (const task of changes) item.revisions.set(task.id, task.revision);
        if (changes.length || hub.ticks % 20 === 0) item.send(changes);
      }
    } catch { for (const item of [...hub.listeners]) item.close(); }
  }, 500);
  return () => { hub.listeners.delete(listener); if (!hub.listeners.size) { clearInterval(hub.timer); hub.timer = undefined; } };
}
export function scriptEvents(request: Request) {
  const canvasId = new URL(request.url).searchParams.get('canvasId');
  if (!canvasId || canvasId.length > 200) return Response.json({ error: '画布身份无效' }, { status: 400 });
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false; let unsubscribe = () => {};
      const close = () => { if (closed) return; closed = true; unsubscribe(); request.signal.removeEventListener('abort',close); try { controller.close(); } catch {} };
      cleanup = close;
      const send = (tasks: ScriptTask[]) => { if (!closed) controller.enqueue(new TextEncoder().encode(`event: tasks\ndata: ${JSON.stringify(tasks)}\n\n`)); };
      if (request.signal.aborted) { close(); return; }
      request.signal.addEventListener('abort',close,{ once:true });
      const tasks = getScriptService().list(canvasId);
      send(tasks);
      unsubscribe = subscribe({ canvasId, revisions: new Map(tasks.map(t => [t.id,t.revision])), send, close });
    }, cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache, no-transform', Connection:'keep-alive', 'X-Accel-Buffering':'no' } });
}
