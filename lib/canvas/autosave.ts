import type { Node, Edge, Viewport } from '@xyflow/react';

type State = {
  nodes: Node[];
  edges: Edge[];
  viewport: Viewport;
  projectName: string;
  currentWorkflowId: string | null;
  canvasSession: number;
  setCurrentWorkflowId(id: string): void;
};
type Store = {
  getState(): State;
  subscribe(listener: (state: State, previous: State) => void): () => void;
};
type Session = { key: number; id: string | null; snapshot: State; dirty: boolean };

// One writer for automatic saves, the save button and keyboard shortcuts.
// Each queued snapshot keeps its canvas identity, even after navigation.
export function createCanvasAutosave(store: Store, onError: (error: unknown) => void, delay = 500) {
  let active: Session;
  const pending = new Set<Session>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  const session = (state: State): Session => ({ key: state.canvasSession, id: state.currentWorkflowId, snapshot: state, dirty: false });
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { void flush().catch(onError); }, delay);
  };
  const mark = (target: Session, state: State) => {
    target.snapshot = state;
    target.dirty = true;
    pending.add(target);
    schedule();
  };
  async function drain() {
    for (const target of pending) {
      while (target.dirty) {
        const snapshot = target.snapshot;
        target.dirty = false;
        try {
          const response = await fetch(target.id ? `/api/workflow/${target.id}` : '/api/workflow', {
            method: target.id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: snapshot.projectName, nodes: snapshot.nodes, edges: snapshot.edges, viewport: snapshot.viewport }),
          });
          const result = await response.json();
          if (!response.ok || !result.success) throw new Error(result.error || '保存失败');
          if (!target.id) {
            if (!result.data?.id) throw new Error('保存响应缺少画布 ID');
            target.id = result.data.id;
            if (store.getState().canvasSession === target.key) store.getState().setCurrentWorkflowId(target.id!);
          }
        } catch (error) {
          target.dirty = true;
          throw error;
        }
      }
      pending.delete(target);
    }
  }
  async function flush() {
    clearTimeout(timer);
    if (running) {
      await running;
      if (pending.size) return flush();
      return;
    }
    running = drain();
    try { await running; } finally { running = undefined; }
  }
  function start() {
    if (unsubscribe) return () => {};
    const state = store.getState();
    // Preserve pending work across effect teardown/remount.
    if (!active || active.key !== state.canvasSession) active = session(state);
    unsubscribe = store.subscribe((state, previous) => {
      if (state.canvasSession !== previous.canvasSession) {
        active = session(state);
        if (pending.size) schedule();
        return;
      }
      active.id = state.currentWorkflowId;
      if (state.nodes === previous.nodes && state.edges === previous.edges &&
          state.viewport === previous.viewport && state.projectName === previous.projectName) return;
      if (!state.currentWorkflowId && state.nodes.length === 0 && !pending.has(active)) return;
      mark(active, state);
    });
    // Recover a local draft that has never reached the database.
    if (!state.currentWorkflowId && state.nodes.length) mark(active, state);
    return () => {
      unsubscribe?.();
      unsubscribe = undefined;
      void flush().catch(onError);
    };
  }
  async function save() {
    const state = store.getState();
    if (!active || active.key !== state.canvasSession) active = session(state);
    if (!state.currentWorkflowId && !state.nodes.length) throw new Error("画布为空");
    mark(active, state);
    await flush();
  }
  return { start, save, flush };
}
