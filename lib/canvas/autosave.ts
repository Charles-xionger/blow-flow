import type { CanvasNode } from '@/types';
import type { Edge, Viewport } from '@xyflow/react';
import { createCanvasRepository, type CanvasDraft, type CanvasRepository } from './local-repository';
import { canonicalJSON } from './save-protocol';
import { canvasSnapshot } from './snapshot';
import { LEGACY_CANVAS_KEY } from './legacy-draft';
import { canvasRequest, CanvasRequestError } from './sync-request';

export type SaveStatus = 'loading' | 'idle' | 'saving' | 'pending' | 'syncing' | 'synced' | 'local-error' | 'sync-error' | 'recovery' | 'migration-error';
type State = {
  nodes: CanvasNode[]; edges: Edge[]; viewport: Viewport; projectName: string;
  currentWorkflowId: string | null; canvasSession: number; serverVersion: number;
  selectedNodeIds?: string[];
  recovery?: CanvasDraft['recovery'];
  generationRecoveryReadOnly?: string[];
  recoveryCopies?: { id: string; name: string }[];
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
  delay = 500, repository: CanvasRepository = createCanvasRepository(), maxWait = 2000,
  { requestTimeoutMs = 10_000 } = {}) {
  let active: Session | undefined;
  const sessions = new Set<Session>();
  const interactions = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAt = Infinity;
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
    if (target.draft?.recovery) return status(target, 'recovery');
    status(target, !target.draft || !target.draft.localVersion && !target.draft.serverVersion ? 'idle' : target.draft.localVersion > target.draft.confirmedLocalVersion ? 'pending' : 'synced');
  };
  const schedule = () => {
    if (interactions.size) return;
    clearTimeout(timer);
    const run = () => { void flush().catch(onError); };
    timer = setTimeout(run, delay);
    deadline ??= setTimeout(run, maxWait);
  };
  const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;
  const retryLater = (at: number) => {
    if (!unsubscribe || !online() || at >= retryAt) return;
    clearTimeout(retryTimer);
    retryAt = at;
    retryTimer = setTimeout(() => {
      retryAt = Infinity;
      void sync().catch(onError);
    }, Math.max(0, at - Date.now()));
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
  async function sync(force = false) {
    if (syncing) {
      await syncing;
      // A manual save may have joined an automatic check which only scheduled
      // a future retry. Preserve the caller's explicit wake-up in that case.
      if (force) return sync(true);
      return;
    }
    if (!online()) return;
    syncing = (async () => {
      for (const target of sessions) {
        if (!target.id) continue;
        try {
          target.draft = await repository.read(target.id);
          if (target.draft?.recovery) {
            if (target.draft.recovery.kind === 'copy' || target.draft.recovery.kind === 'conflict' && !force) {
              settledStatus(target); continue;
            }
            const remote = await readRemote(target.id);
            target.draft = await repository.reconcile(target.id, remote.snapshot, remote.version);
            if (store.getState().canvasSession === target.key) store.setState({
              recovery: target.draft.recovery, serverVersion: target.draft.serverVersion });
            settledStatus(target);
            if (target.draft.recovery) continue;
          }
          let operation = await repository.pending(target.id);
          while (operation) {
            if (operation.retry?.blocked && !force) throw new Error(operation.retry.error || '同步已暂停，本地内容已保留');
            if (!online()) { settledStatus(target); break; }
            if (operation.retry && ((!force && operation.retry.nextAttemptAt > Date.now()) ||
                (operation.retry.retryAfter ?? 0) > Date.now())) {
              status(target, 'sync-error', operation.retry.error);
              retryLater(operation.retry.nextAttemptAt);
              break;
            }
            if (!target.dirty) status(target, 'syncing');
            const { retry, ...body } = operation;
            const attempts = (retry?.attempts ?? 0) + 1;
            const backoff = Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5)) * (0.75 + Math.random() * 0.25);
            // Persist before sending: closing the page during an unresolved
            // request must not reset its retry budget on the next startup.
            const persisted = await repository.retry(operation, { attempts,
              nextAttemptAt: Date.now() + requestTimeoutMs + backoff, error: retry?.error });
            if (!persisted) break;
            if (persisted.requestId !== operation.requestId) { operation = persisted; continue; }
            try {
              const ack = await canvasRequest(`/api/workflow/${encodeURIComponent(operation.id)}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
              }, requestTimeoutMs);
              target.draft = await repository.acknowledge(operation, ack);
              if (store.getState().canvasSession === target.key) store.setState({ serverVersion: target.draft.serverVersion });
              settledStatus(target);
            } catch (error) {
              const retryAfter = error instanceof CanvasRequestError ? error.retryAfter : undefined;
              const nextAttemptAt = Math.max(retryAfter ?? 0, Date.now() + backoff);
              const blocked = error instanceof CanvasRequestError ? error.blocked : undefined;
              const next = await repository.retry(operation, { attempts, nextAttemptAt, blocked, retryAfter,
                error: error instanceof Error ? error.message : String(error) });
              if (next && next.requestId !== operation.requestId) { operation = next; continue; }
              if (!blocked) retryLater(nextAttemptAt);
              throw error;
            }
            operation = await repository.pending(target.id);
          }
        } catch (error) {
          if (target.draft?.recovery?.kind === 'unverified') retryLater(Date.now() + 5000);
          status(target, 'sync-error', error); throw error;
        }
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
    return () => {
      unsubscribe?.(); unsubscribe = undefined; clearTimers();
      clearTimeout(retryTimer); retryAt = Infinity;
      void commitLocal().catch(onError);
    };
  }
  async function readRemote(id: string) {
    const data = await canvasRequest(`/api/workflow/${encodeURIComponent(id)}`, {}, requestTimeoutMs);
    if (!Number.isSafeInteger(data.version) || data.version < 1) throw new Error('读取画布失败');
    return { snapshot: canvasSnapshot({ ...data, projectName: data.name }), version: data.version as number };
  }
  async function refreshCopies() {
    store.setState({ recoveryCopies: (await repository.recoveries()).map(draft => ({ id: draft.id, name: draft.snapshot.name })) });
  }
  function applyDraft(draft: CanvasDraft) {
    store.setState({ nodes: draft.snapshot.nodes as CanvasNode[], edges: draft.snapshot.edges,
      viewport: draft.snapshot.viewport, projectName: draft.snapshot.name, currentWorkflowId: draft.id,
      serverVersion: draft.serverVersion, recovery: draft.recovery, generationRecoveryReadOnly: draft.generationRecoveryReadOnly, selectedNodeIds: [] });
  }
  async function open(id?: string | null) {
    const token = ++opening;
    if (store.getState().persistenceReady) {
      await commitLocal();
      void sync().catch(onError);
    }
    store.setState({ persistenceReady: false, saveStatus: 'loading', saveError: null });
    let migrated = false;
    try {
      await repository.migrateLegacy(typeof localStorage === 'undefined' ? null : localStorage.getItem(LEGACY_CANVAS_KEY));
      migrated = true;
      await refreshCopies();
      let draft = await repository.read(id);
      if (token !== opening) return;
      if (draft) applyDraft(draft);
      const canvasId = id ?? draft?.id;
      const pending = canvasId ? await repository.pending(canvasId) : undefined;
      let remoteError: unknown = pending?.retry?.error;
      if (canvasId && !draft && !online()) throw new Error('离线时无法读取尚未缓存的画布');
      if (canvasId && online() && (!draft || draft.recovery?.kind === 'unverified' || draft.recovery?.kind === 'conflict' || draft.serverVersion > 0 && draft.localVersion === draft.confirmedLocalVersion)) {
        try {
          const remote = await readRemote(canvasId);
          if (token !== opening) return;
          draft = draft?.recovery
            ? await repository.reconcile(canvasId, remote.snapshot, remote.version)
            : await repository.adopt(canvasId, remote.snapshot, remote.version);
        } catch (error) { if (!draft) throw error; remoteError = error; }
      }
      if (token !== opening) return;
      if (draft) applyDraft(draft);
      else store.setState({ nodes: [], edges: [], projectName: '未命名项目', currentWorkflowId: null, serverVersion: 0, recovery: undefined, generationRecoveryReadOnly: undefined });
      store.setState({ canvasSession: store.getState().canvasSession + 1 });
      active = session(store.getState()); active.draft = draft; sessions.add(active);
      store.setState({ persistenceReady: true });
      if (remoteError) status(active, 'sync-error', remoteError); else settledStatus(active);
      void sync().catch(onError);
    } catch (error) {
      if (token !== opening) return;
      store.setState({ saveStatus: migrated ? 'local-error' : 'migration-error', saveError: error instanceof Error ? error.message : String(error) });
      onError(error);
    }
  }
  async function save() {
    if (!store.getState().persistenceReady) throw new Error('画布尚未恢复，请稍后重试');
    if (!active || (!active.id && !active.latest.nodes.length)) throw new Error('画布为空');
    await commitLocal();
    await sync(true);
    const draft = active.id ? await repository.read(active.id) : undefined;
    if (active.draft && (!draft || draft.confirmedLocalVersion < active.draft.localVersion)) {
      throw new Error(store.getState().saveError || '已保存到本地，等待网络恢复后同步');
    }
  }
  async function recover(choice: 'server' | 'copy') {
    const target = active;
    if (!target?.id || !target.draft?.recovery) throw new Error('画布无需恢复');
    if (!store.getState().persistenceReady) throw new Error('正在恢复，请稍后重试');
    // A recovery choice replaces the editor's content. Freeze it before the
    // final commit so edits cannot escape the backup during the remote read.
    store.setState({ persistenceReady: false, saveStatus: 'loading', saveError: null });
    try {
      await commitLocal();
      let draft: CanvasDraft;
      if (choice === 'server') {
        const remote = await readRemote(target.id);
        draft = await repository.adoptRemote(target.id, remote.snapshot, remote.version);
      } else draft = await repository.saveRecoveryAsNew(target.id);
      sessions.delete(target);
      await open(draft.id);
    } catch (error) {
      store.setState({ persistenceReady: true });
      status(target, 'sync-error', error);
      throw error;
    }
  }
  async function allowGenerationRecovery(nodeId: string) {
    const id = store.getState().currentWorkflowId;
    if (id) await repository.allowGenerationRecovery(id, nodeId);
    if (store.getState().currentWorkflowId === id) store.setState({
      generationRecoveryReadOnly: store.getState().generationRecoveryReadOnly?.filter(value => value !== nodeId) });
  }
  return { start, open, save, flush, recover, allowGenerationRecovery,
    beginInteraction(key: string) { interactions.add(key); clearTimers(); },
    endInteraction(key: string) { interactions.delete(key); if (active?.dirty) schedule(); },
  };
}
