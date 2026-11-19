import type { CanvasNode } from '@/types';
import type { Edge, Viewport } from '@xyflow/react';
import { createCanvasRepository, type CanvasDraft, type CanvasRepository } from './local-repository';
import { mergeRemoteCanvas, NonAgentRemoteChange } from './remote-merge';
import { canonicalJSON } from './save-protocol';
import { canvasSnapshot } from './snapshot';
import { LEGACY_CANVAS_KEY } from './legacy-draft';
import { canvasRequest, CanvasRequestError } from './sync-request';
import { CanvasStorageError } from './storage-error';

export type SaveStatus = 'loading' | 'idle' | 'saving' | 'pending' | 'syncing' | 'synced' | 'local-error' | 'sync-error' | 'recovery' | 'migration-error';
type State = {
  nodes: CanvasNode[]; edges: Edge[]; viewport: Viewport; projectName: string;
  currentWorkflowId: string | null; canvasSession: number; serverVersion: number;
  history?: import('./history').CanvasHistory;
  selectedNodeIds?: string[];
  recovery?: CanvasDraft['recovery'];
  agentProgress?: { projectId: string; labels: Record<string,string> };
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
  fingerprint: string; localVersion: number; draft?: CanvasDraft; localError?: unknown;
};

// One coordinator owns batching, local commits and server confirmation. Local
// writes have a separate queue so a slow HTTP request never blocks durability.
export function createCanvasAutosave(store: Store, onError: (error: unknown) => void,
  delay = 500, repository: CanvasRepository = createCanvasRepository(), maxWait = 2000,
  { requestTimeoutMs = 10_000, history = false } = {}) {
  let active: Session | undefined;
  const sessions = new Set<Session>();
  const interactions = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAt = Infinity;
  let localWork: Promise<void> = Promise.resolve();
  const flights = new Map<string, Promise<void>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  async function withSyncSlot(work: () => Promise<void>) {
    if (running >= 2) await new Promise<void>(resolve => waiting.push(resolve));
    else running++;
    try { await work(); } finally {
      const next = waiting.shift();
      if (next) next(); else running--;
    }
  }
  let unsubscribe: (() => void) | undefined;
  let opening = 0;
  let remoteEvents: EventSource | undefined;
  let watchedId: string | undefined;
  let remotePending = false;
  async function refreshRemote(id: string) {
    await flights.get(id)?.catch(() => {});
    if (watchedId !== id) return;
    if (interactions.size) { remotePending = true; return; }
    remotePending = false;
    await flush();
  }
  function watchRemote() {
    const state = store.getState();
    const id = state.persistenceReady ? state.currentWorkflowId ?? undefined : undefined;
    if (!history || typeof EventSource === 'undefined' || id === watchedId) return;
    remoteEvents?.close();
    watchedId = id;
    remotePending = false;
    remoteEvents = undefined;
    if (!id) return;
    remoteEvents = new EventSource(`/api/workflow/${encodeURIComponent(id)}/events`);
    const source = remoteEvents;
    source.addEventListener('agent-progress', event => {
      if (remoteEvents === source && store.getState().currentWorkflowId === id)
        store.setState({ agentProgress: { projectId: id, labels: JSON.parse(event.data) } });
    });
    remoteEvents.onmessage = event => {
      const version: unknown = JSON.parse(event.data);
      if (typeof version !== 'number' || version > store.getState().serverVersion) {
        // A notification may race a save; read after that flight has settled.
        void refreshRemote(id).catch(onError);
      }
    };
  }
  let publishingRemote = false;
  const clearTimers = () => { clearTimeout(timer); clearTimeout(deadline); timer = deadline = undefined; };
  const status = (target: Session, saveStatus: SaveStatus, error?: unknown) => {
    // A request can outlive an editor visit. Its state belongs to the canvas,
    // including a new visit to that same ID, never whichever canvas is open.
    if (active && target.id && active.id === target.id) target = active;
    if (target.dirty && ['syncing', 'synced', 'pending'].includes(saveStatus)) saveStatus = 'saving';
    if (saveStatus === 'local-error') target.localError = error;
    if (target.localError) { saveStatus = 'local-error'; error = target.localError; }
    if (store.getState().persistenceReady && store.getState().canvasSession === target.key &&
        store.getState().currentWorkflowId === target.id) store.setState({ saveStatus,
      saveError: error ? error instanceof Error ? error.message : String(error) : null });
  };
  const session = (state: State): Session => ({ key: state.canvasSession, id: state.currentWorkflowId,
    latest: state, dirty: false, localVersion: 0, fingerprint: canonicalJSON(canvasSnapshot(state)) });
  const settledStatus = (target: Session) => {
    if (target.dirty) return status(target, 'saving');
    if (target.draft?.recovery) return status(target, 'recovery');
    if (target.draft && target.localVersion < target.draft.localVersion) return status(target, 'pending');
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
        if (!target.id && !snapshot.nodes.length && !snapshot.history?.records.length) { target.dirty = false; settledStatus(target); continue; }
        target.id ??= crypto.randomUUID();
        if (store.getState().canvasSession === target.key) store.setState({ currentWorkflowId: target.id });
        status(target, 'saving');
        try {
          target.draft = await repository.commit(target.id, snapshot, latest.serverVersion, target.localVersion);
          target.localVersion = target.draft.localVersion;
          if (target.draft.id !== target.id) {
            target.id = target.draft.id;
            if (store.getState().canvasSession === target.key) store.setState({ currentWorkflowId: target.id,
              recovery: target.draft.recovery, serverVersion: 0, generationRecoveryReadOnly: target.draft.generationRecoveryReadOnly });
            await refreshCopies();
          }
          target.fingerprint = fingerprint;
          target.localError = undefined;
          target.dirty = target.latest !== latest;
          settledStatus(target);
        } catch (error) { status(target, 'local-error', error); throw error; }
      }
      if (active) {
        try {
          await repository.setActive(active.id);
          if (!active.dirty && active.localError) { active.localError = undefined; settledStatus(active); }
        }
        catch (error) { status(active, 'local-error', error); throw error; }
      }
    };
    // A failed transaction must not poison subsequent explicit retries.
    localWork = localWork.catch(() => {}).then(work);
    return localWork;
  }
  function publishDraft(draft: CanvasDraft) {
    if (draft.recovery?.kind === 'deleted') {
      // Deleted projects disappear from the server list. Keep their local
      // content reachable even when deletion is discovered in the background.
      store.setState({ recoveryCopies: [...(store.getState().recoveryCopies ?? []).filter(copy => copy.id !== draft.id),
        { id: draft.id, name: draft.snapshot.name }] });
    }
    for (const target of sessions) {
      if (target.id !== draft.id) continue;
      target.draft = draft;
      if (store.getState().persistenceReady && store.getState().canvasSession === target.key) store.setState({
        serverVersion: draft.serverVersion, recovery: draft.recovery });
      settledStatus(target);
    }
  }
  async function mergeIncoming(target: Session, remote: Awaited<ReturnType<typeof readRemote>>, rejectedRequestId?: string) {
    await commitLocal();
    const work = async () => {
    const before = await repository.read(target.id!);
    if (!before || before.serverVersion >= remote.version) return before;
    const merged = await repository.mergeRemote(target.id!, remote.snapshot, remote.version, rejectedRequestId);
    if (merged.serverVersion !== remote.version) return merged;
    for (const editor of sessions) {
      if (editor.id !== target.id) continue;
      const current = store.getState();
      const visible = current.persistenceReady && current.canvasSession === editor.key && current.currentWorkflowId === editor.id;
      // Rebase edits that arrived during IndexedDB work too, before publishing.
      const snapshot = visible && canonicalJSON(canvasSnapshot(current)) !== canonicalJSON(before.snapshot)
        ? mergeRemoteCanvas(before.confirmedSnapshot ?? before.snapshot, canvasSnapshot(current), remote.snapshot) : merged.snapshot;
      editor.draft = merged;
      editor.localVersion = merged.localVersion;
      editor.fingerprint = canonicalJSON(merged.snapshot);
      if (visible) {
        publishingRemote = true;
        try { store.setState({ nodes: snapshot.nodes.map(node => {
          const live = current.nodes.find(value => value.id === node.id);
          return { ...node, selected: live?.selected, measured: live?.measured, dragging: live?.dragging,
            data: { ...node.data, activeToolbarItem: live?.data.activeToolbarItem, isStackOpen: live?.data.isStackOpen } } as CanvasNode;
        }), edges: snapshot.edges.map(edge => ({ ...edge, selected: current.edges.find(value => value.id === edge.id)?.selected })), history: snapshot.history,
          projectName: snapshot.name, serverVersion: merged.serverVersion, recovery: merged.recovery,
          selectedNodeIds: current.selectedNodeIds?.filter(id => snapshot.nodes.some(node => node.id === id)) }); }
        finally { publishingRemote = false; }
        editor.latest = store.getState();
        editor.dirty = canonicalJSON(canvasSnapshot(editor.latest)) !== editor.fingerprint;
      }
    }
    return merged;
    };
    const incoming = localWork.catch(() => {}).then(work);
    localWork = incoming.then(() => {}, () => {});
    const merged = await incoming;
    await commitLocal();
    return merged;
  }
  async function syncCanvas(editor: Session, force: boolean) {
    // A stale editor can acquire a recovery-copy ID during this request. Keep
    // the worker bound to the original canvas for every response and retry.
    const target = { ...editor };
    if (!target.id || !online()) return;
    let observedServerVersion: number | undefined;
    try {
      target.draft = await repository.read(target.id);
      observedServerVersion = target.draft ? Math.max(target.draft.serverVersion, target.draft.restorationVersion ?? 0) : undefined;
      if (target.draft?.recovery) {
        if (target.draft.recovery.kind !== 'unverified') {
          publishDraft(target.draft);
          if (force && target.draft.recovery.kind !== 'copy') throw new Error((await repository.pending(target.id))?.retry?.error || '同步已暂停，本地内容已保留');
          return;
        }
        const remote = await readRemote(target.id);
        target.draft = await repository.reconcile(target.id, remote.snapshot, remote.version);
        publishDraft(target.draft);
        if (target.draft.recovery) return;
      }
      let operation = await repository.pending(target.id);
      if (history && target.id === active?.id && store.getState().persistenceReady &&
          !operation && target.draft && !target.draft.recovery) {
        const remote = await readRemote(target.id);
        if (remote.version > target.draft.serverVersion) {
          try { target.draft = await mergeIncoming(editor, remote); }
          catch (error) { if (!(error instanceof NonAgentRemoteChange)) throw error; }
          operation = await repository.pending(target.id);
        }
      }
      while (operation) {
        if (operation.retry?.blocked && !force) {
          // A persisted pause is state, not a new failed save on every poll.
          status(target, 'sync-error', operation.retry.error || '同步已暂停，本地内容已保留');
          return;
        }
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
        observedServerVersion = operation.baseVersion;
        try {
          const ack = await canvasRequest(`/api/workflow/${encodeURIComponent(operation.id)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          }, requestTimeoutMs);
          target.draft = await repository.acknowledge(operation, ack);
          if (!target.dirty) target.localError = undefined;
          publishDraft(target.draft);
        } catch (error) {
          if (error instanceof CanvasStorageError) throw error;
          if (error instanceof CanvasRequestError && error.status === 409) {
            if (history) {
              const remote = await readRemote(operation.id);
              try {
                const merged = await mergeIncoming(editor, remote, operation.requestId);
                if (merged?.serverVersion === remote.version && !merged.recovery) {
                  target.draft = merged;
                  const nextOperation = await repository.pending(operation.id);
                  operation = nextOperation;
                  continue;
                }
              } catch (mergeError) {
                if (mergeError instanceof CanvasStorageError) throw mergeError;
                // Unknown history stays in the existing recovery flow.
              }
            }
            target.draft = await repository.markRecovery(body.id, 'conflict', body.requestId, error.message);
            publishDraft(target.draft);
            throw error;
          }
          if (error instanceof CanvasRequestError && error.status === 410) throw error;
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
      if (error instanceof CanvasRequestError && error.status === 410 && target.id) {
        target.draft = await repository.markRecovery(target.id, 'deleted', undefined, error.message, observedServerVersion);
        publishDraft(target.draft);
        if (target.draft.recovery?.kind !== 'deleted') { settledStatus(target); return; }
      }
      if (target.draft?.recovery?.kind === 'unverified') retryLater(Date.now() + 5000);
      status(target, error instanceof CanvasStorageError ? 'local-error' : 'sync-error', error); throw error;
    }
  }
  async function sync(force = false, onlyId?: string) {
    if (!online()) return;
    const targets = new Map<string, Session>();
    for (const target of sessions) if (target.id) targets.set(target.id, target);
    let drafts: CanvasDraft[];
    try { drafts = await repository.all(); }
    catch (error) { if (active) status(active, 'local-error', error); throw error; }
    for (const draft of drafts) {
      if (targets.has(draft.id)) continue;
      const target = session({ ...store.getState(), canvasSession: -1, currentWorkflowId: draft.id });
      target.draft = draft; target.localVersion = draft.localVersion;
      targets.set(draft.id, target);
    }
    const work = [...targets.values()].filter(target => !onlyId || target.id === onlyId).map(async target => {
      const id = target.id!;
      const previous = flights.get(id);
      if (previous) {
        if (!force) return previous;
        // A manual retry joining an automatic backoff check must still wake it.
        await previous.catch(() => {});
        if (flights.has(id)) return flights.get(id);
      }
      const promise = withSyncSlot(() => syncCanvas(target, force));
      flights.set(id, promise);
      try { await promise; } finally { if (flights.get(id) === promise) flights.delete(id); }
    });
    const results = await Promise.allSettled(work);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  async function flush() {
    if (!store.getState().persistenceReady) return;
    await commitLocal();
    await sync();
  }
  async function flushAndConfirm(projectId: string) {
    if (!store.getState().persistenceReady || store.getState().currentWorkflowId !== projectId) throw new Error('画布尚未准备好');
    await commitLocal();
    await sync(true, projectId);
    const draft = await repository.read(projectId);
    if (!draft || draft.recovery || draft.confirmedLocalVersion !== draft.localVersion) throw new Error('画布尚未同步到服务器');
    const remote = await readRemote(projectId);
    const current = store.getState();
    if (current.currentWorkflowId !== projectId || !current.persistenceReady || active?.dirty ||
      canonicalJSON(remote.snapshot) !== canonicalJSON(canvasSnapshot(current)) || draft.serverVersion !== remote.version) throw new Error('画布在确认期间发生变化，请重新发送');
    return remote.version;
  }
  function start() {
    if (unsubscribe) return () => {};
    unsubscribe = store.subscribe((state, previous) => {
      watchRemote();
      if (!state.persistenceReady || publishingRemote) return;
      if (!active || state.canvasSession !== active.key) {
        active = session(state);
        sessions.add(active);
        // A synchronous clear/import creates a new editor session. The previous
        // session still owns its pending snapshot and must be committed now.
        void flush().catch(onError);
        // Explicit new canvas clears the last-open pointer, never old drafts.
        if (!active.id) void repository.clearActive().catch(onError);
        return;
      }
      if (state.nodes === previous.nodes && state.edges === previous.edges &&
          state.viewport === previous.viewport && state.projectName === previous.projectName && state.history === previous.history) return;
      active.latest = state;
      active.dirty = true;
      // A drag changes the canvas every frame; report saving once, on release.
      if (interactions.size) return;
      status(active, 'saving');
      schedule();
    });
    watchRemote();
    return () => {
      remoteEvents?.close(); remoteEvents = undefined; watchedId = undefined;
      unsubscribe?.(); unsubscribe = undefined; clearTimers();
      clearTimeout(retryTimer); retryAt = Infinity;
      void commitLocal().catch(onError);
    };
  }
  async function readRemote(id: string) {
    const data = await canvasRequest(`/api/workflow/${encodeURIComponent(id)}`, { cache: 'no-store' }, requestTimeoutMs);
    if (!Number.isSafeInteger(data.version) || data.version < 1) throw new Error('读取画布失败');
    return { snapshot: canvasSnapshot({ ...data, projectName: data.name }), version: data.version as number };
  }
  async function refreshCopies() {
    store.setState({ recoveryCopies: (await repository.recoveries()).map(draft => ({ id: draft.id, name: draft.snapshot.name })) });
  }
  function applyDraft(draft: CanvasDraft) {
    store.setState({ history: draft.snapshot.history, nodes: draft.snapshot.nodes as CanvasNode[], edges: draft.snapshot.edges,
      viewport: draft.snapshot.viewport, projectName: draft.snapshot.name, currentWorkflowId: draft.id,
      serverVersion: draft.serverVersion, recovery: draft.recovery, generationRecoveryReadOnly: draft.generationRecoveryReadOnly, selectedNodeIds: [] });
  }
  async function open(id?: string | null) {
    const token = ++opening;
    if (store.getState().persistenceReady) {
      await prepareSwitch();
      void sync().catch(onError);
    }
    store.setState({ persistenceReady: false, saveStatus: 'loading', saveError: null });
    let migrated = false;
    let legacyRaw: string | null = null;
    try {
      legacyRaw = typeof localStorage === 'undefined' ? null : localStorage.getItem(LEGACY_CANVAS_KEY);
      await repository.migrateLegacy(legacyRaw);
      migrated = true;
      await refreshCopies();
      let draft = await repository.read(id);
      if (token !== opening) return;
      if (draft) applyDraft(draft);
      const canvasId = id ?? draft?.id;
      const pending = canvasId ? await repository.pending(canvasId) : undefined;
      let remoteError: unknown = pending?.retry?.error;
      if (canvasId && !draft && !online()) throw new Error('离线时无法读取尚未缓存的画布');
      if (canvasId && online() && (!draft || draft.recovery?.kind === 'deleted' || draft.recovery?.kind === 'unverified' || !draft.recovery && draft.serverVersion > 0 && draft.localVersion === draft.confirmedLocalVersion)) {
        const observedServerVersion = draft ? Math.max(draft.serverVersion, draft.restorationVersion ?? 0) : undefined;
        try {
          const remote = await readRemote(canvasId);
          if (token !== opening) return;
          draft = draft?.recovery?.kind === 'deleted'
            ? await repository.reconcileDeleted(canvasId, remote.snapshot, remote.version, draft.recovery.observationId)
            : draft?.recovery
            ? await repository.reconcile(canvasId, remote.snapshot, remote.version)
            : await repository.adopt(canvasId, remote.snapshot, remote.version);
          remoteError = (await repository.pending(canvasId))?.retry?.error;
        } catch (error) {
          if (!draft || error instanceof CanvasStorageError) throw error;
          if (error instanceof CanvasRequestError && error.status === 410) {
            draft = await repository.markRecovery(canvasId, 'deleted', undefined, error.message, observedServerVersion);
            remoteError = draft.recovery?.kind === 'deleted' ? error : undefined;
          } else remoteError = error;
        }
      }
      if (token !== opening) return;
      await refreshCopies();
      if (token !== opening) return;
      if (draft && history) draft = await repository.initializeHistory(draft.id);
      if (token !== opening) return;
      if (draft) applyDraft(draft);
      else store.setState({ history: undefined, nodes: [], edges: [], projectName: '未命名项目', currentWorkflowId: null, serverVersion: 0, recovery: undefined, generationRecoveryReadOnly: undefined });
      store.setState({ canvasSession: store.getState().canvasSession + 1 });
      active = session(store.getState()); active.draft = draft; active.localVersion = draft?.localVersion ?? 0; sessions.add(active);
      await repository.setActive(active.id);
      store.setState({ persistenceReady: true });
      if (remoteError) status(active, 'sync-error', remoteError); else settledStatus(active);
      void sync().catch(onError);
    } catch (error) {
      if (token !== opening) return;
      store.setState({ saveStatus: migrated || legacyRaw === null ? 'local-error' : 'migration-error', saveError: error instanceof Error ? error.message : String(error) });
      onError(error);
    }
  }
  async function save() {
    if (!store.getState().persistenceReady) throw new Error('画布尚未恢复，请稍后重试');
    if (!active || (!active.id && !active.latest.nodes.length && !active.latest.history?.records.length)) throw new Error('画布为空');
    const target = active;
    await commitLocal();
    await sync(true, target.id ?? undefined);
    const draft = target.id ? await repository.read(target.id) : undefined;
    if (target.draft && (draft?.recovery || !draft || draft.confirmedLocalVersion < target.localVersion)) {
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
      status(target, error instanceof CanvasStorageError ? 'local-error' : 'sync-error', error);
      throw error;
    }
  }
  async function prepareSwitch() {
    if (!store.getState().persistenceReady) throw new Error('画布尚未恢复，请稍后重试');
    // Clear/import/new replace the editor synchronously. Freeze editing until
    // its final snapshot is durable; a failed checkpoint leaves it exportable.
    store.setState({ persistenceReady: false, saveStatus: 'saving', saveError: null });
    try { await commitLocal(); }
    finally {
      store.setState({ persistenceReady: true });
      if (active) settledStatus(active);
    }
  }
  async function deleted(id: string) {
    await prepareSwitch();
    // The caller may clear the editor next. Keep the same editing gate through
    // the remaining local deletion bookkeeping, not just the content commit.
    store.setState({ persistenceReady: false, saveStatus: 'saving', saveError: null });
    let draft: CanvasDraft | undefined;
    try {
      if (await repository.read(id)) draft = await repository.markRecovery(id, 'deleted');
    } catch (error) {
      if (active) status(active, 'local-error', error);
      throw error;
    } finally {
      store.setState({ persistenceReady: true });
      if (draft) publishDraft(draft);
      if (active) settledStatus(active);
    }
  }
  async function allowGenerationRecovery(nodeId: string) {
    const id = store.getState().currentWorkflowId;
    if (id) await repository.allowGenerationRecovery(id, nodeId);
    if (store.getState().currentWorkflowId === id) store.setState({
      generationRecoveryReadOnly: store.getState().generationRecoveryReadOnly?.filter(value => value !== nodeId) });
  }
  return { start, open, save, flush, flushAndConfirm, recover, prepareSwitch, deleted, allowGenerationRecovery,
    beginInteraction(key: string) { interactions.add(key); clearTimers(); },
    endInteraction(key: string) {
      interactions.delete(key);
      if (!interactions.size && remotePending && watchedId) void refreshRemote(watchedId).catch(onError);
      if (!active?.dirty || interactions.size) return;
      status(active, 'saving');
      schedule();
    },
  };
}
