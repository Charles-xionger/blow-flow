import type { CanvasNode } from '@/types';
import type { Edge, Viewport } from '@xyflow/react';
import { createCanvasRepository, type CanvasDraft, type CanvasRepository } from './local-repository';
import { canonicalJSON, type CanvasSnapshot } from './save-protocol';
import { canvasSnapshot } from './snapshot';

export type SaveStatus = 'loading' | 'idle' | 'saving' | 'pending' | 'syncing' | 'synced' | 'local-error' | 'sync-error';
type State = {
  nodes: CanvasNode[]; edges: Edge[]; viewport: Viewport; projectName: string;
  currentWorkflowId: string | null; canvasSession: number; serverVersion: number;
  selectedNodeIds?: string[];
  persistenceReady: boolean; saveStatus: SaveStatus; saveError: string | null;
};
type Store = {
  getState(): State;
  setState(state: Partial<State>): void;
  subscribe(listener: (state: State, previous: State) => void): () => void;
};
type Session = {
  key: number; id: string | null; latest: State; dirty: boolean;
  fingerprint: string; draft?: CanvasDraft;
};

// One coordinator owns batching, local commits and server confirmation. Local
// writes have a separate queue so a slow HTTP request never blocks durability.
export function createCanvasAutosave(store: Store, onError: (error: unknown) => void,
  delay = 500, repository: CanvasRepository = createCanvasRepository(), maxWait = 2000) {
  let active: Session | undefined;
  const sessions = new Set<Session>();
  const interactions = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let localWork: Promise<void> = Promise.resolve();
  let syncing: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  let opening = 0;
  const clearTimers = () => { clearTimeout(timer); clearTimeout(deadline); timer = deadline = undefined; };
  const status = (target: Session, saveStatus: SaveStatus, error?: unknown) => {
    if (store.getState().canvasSession === target.key) store.setState({ saveStatus,
      saveError: error ? error instanceof Error ? error.message : String(error) : null });
  };
  const session = (state: State): Session => ({ key: state.canvasSession, id: state.currentWorkflowId,
    latest: state, dirty: false, fingerprint: canonicalJSON(canvasSnapshot(state)) });
  const settledStatus = (target: Session) => {
    if (target.dirty) return status(target, 'saving');
    status(target, !target.draft ? 'idle' : target.draft.localVersion > target.draft.confirmedLocalVersion ? 'pending' : 'synced');
  };
  const schedule = () => {
    if (interactions.size) return;
    clearTimeout(timer);
    const run = () => { void flush().catch(onError); };
    timer = setTimeout(run, delay);
    deadline ??= setTimeout(run, maxWait);
  };

  function commitLocal() {
    clearTimers();
    const work = async () => {
      for (const target of sessions) {
        if (!target.dirty) continue;
        const latest = target.latest;
        const snapshot = canvasSnapshot(latest);
        const fingerprint = canonicalJSON(snapshot);
        if (target.fingerprint === fingerprint) { target.dirty = false; settledStatus(target); continue; }
        if (!target.id && !snapshot.nodes.length) { target.dirty = false; settledStatus(target); continue; }
        target.id ??= crypto.randomUUID();
        if (store.getState().canvasSession === target.key) store.setState({ currentWorkflowId: target.id });
        status(target, 'saving');
        try {
          target.draft = await repository.commit(target.id, snapshot, latest.serverVersion);
          target.fingerprint = fingerprint;
          target.dirty = target.latest !== latest;
          settledStatus(target);
        } catch (error) { status(target, 'local-error', error); throw error; }
      }
    };
    // A failed transaction must not poison subsequent explicit retries.
    localWork = localWork.catch(() => {}).then(work);
    return localWork;
  }
  async function sync() {
    if (syncing) { await syncing; return sync(); }
    syncing = (async () => {
      for (const target of sessions) {
        if (!target.id) continue;
        try {
          let operation = await repository.pending(target.id);
          while (operation) {
            if (!target.dirty) status(target, 'syncing');
            const response = await fetch(`/api/workflow/${encodeURIComponent(operation.id)}`, {
              method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation),
            });
            const result = await response.json();
            if (!response.ok || !result.success || !result.data) throw new Error(result.error || '服务端保存失败');
            target.draft = await repository.acknowledge(operation, result.data);
            if (store.getState().canvasSession === target.key) store.setState({ serverVersion: target.draft.serverVersion });
            settledStatus(target);
            operation = await repository.pending(target.id);
          }
        } catch (error) { status(target, 'sync-error', error); throw error; }
      }
    })();
    try { await syncing; } finally { syncing = undefined; }
  }
  async function flush() {
    if (!store.getState().persistenceReady) return;
    await commitLocal();
    await sync();
  }
  function start() {
    if (unsubscribe) return () => {};
    unsubscribe = store.subscribe((state, previous) => {
      if (!state.persistenceReady) return;
      if (!active || state.canvasSession !== active.key) {
        active = session(state);
        sessions.add(active);
        // Explicit new canvas clears the last-open pointer, never old drafts.
        if (!active.id) void repository.clearActive().catch(onError);
        return;
      }
      if (state.nodes === previous.nodes && state.edges === previous.edges &&
          state.viewport === previous.viewport && state.projectName === previous.projectName) return;
      active.latest = state;
      active.dirty = true;
      status(active, 'saving');
      schedule();
    });
    return () => { unsubscribe?.(); unsubscribe = undefined; clearTimers(); void flush().catch(onError); };
  }
  function applyDraft(draft: CanvasDraft) {
    store.setState({ nodes: draft.snapshot.nodes as CanvasNode[], edges: draft.snapshot.edges,
      viewport: draft.snapshot.viewport, projectName: draft.snapshot.name, currentWorkflowId: draft.id,
      serverVersion: draft.serverVersion, selectedNodeIds: [] });
  }
  async function open(id?: string | null) {
    const token = ++opening;
    if (store.getState().persistenceReady) {
      await commitLocal();
      void sync().catch(onError);
    }
    store.setState({ persistenceReady: false, saveStatus: 'loading', saveError: null });
    try {
      let draft = await repository.read(id);
      if (token !== opening) return;
      if (draft) applyDraft(draft);
      const canvasId = id ?? draft?.id;
      let remoteError: unknown;
      if (canvasId) {
        try {
          const response = await fetch(`/api/workflow/${encodeURIComponent(canvasId)}`);
          const result = await response.json();
          if (!response.ok || !result.success || !Number.isSafeInteger(result.data?.version)) throw new Error(result.error || '读取画布失败');
          if (token !== opening) return;
          if (!draft || draft.localVersion === draft.confirmedLocalVersion) {
            const { name, nodes, edges, viewport } = result.data as CanvasSnapshot;
            draft = await repository.adopt(canvasId, { name, nodes, edges, viewport }, result.data.version);
          } else if (result.data.version !== draft.serverVersion) {
            remoteError = new Error('服务端版本已变化，本地内容已保留');
          }
        } catch (error) { if (!draft) throw error; remoteError = error; }
      }
      if (token !== opening) return;
      if (draft) applyDraft(draft);
      else store.setState({ nodes: [], edges: [], projectName: '未命名项目', currentWorkflowId: null, serverVersion: 0 });
      store.setState({ canvasSession: store.getState().canvasSession + 1 });
      active = session(store.getState()); active.draft = draft; sessions.add(active);
      store.setState({ persistenceReady: true });
      if (remoteError) status(active, 'sync-error', remoteError); else settledStatus(active);
      // Refresh retry scheduling is added by ticket 02. Existing pending content
      // is restored here and can already be retried with the Save button.
    } catch (error) {
      if (token !== opening) return;
      store.setState({ saveStatus: 'local-error', saveError: error instanceof Error ? error.message : String(error) });
      onError(error);
    }
  }
  async function save() {
    if (!store.getState().persistenceReady) throw new Error('画布尚未恢复，请稍后重试');
    if (!active || (!active.id && !active.latest.nodes.length)) throw new Error('画布为空');
    await flush();
  }
  return { start, open, save, flush,
    beginInteraction(key: string) { interactions.add(key); clearTimers(); },
    endInteraction(key: string) { interactions.delete(key); if (active?.dirty) schedule(); },
  };
}
