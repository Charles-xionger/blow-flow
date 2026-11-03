import { restoredHistory } from './history';
import { canonicalJSON, type CanvasSnapshot, type SaveAcknowledgement, type SaveOperation } from './save-protocol';
import { recoverySnapshot } from './recovery-copy';
import { parseLegacyDraft } from './legacy-draft';
import { CanvasStorageError, canvasStorageError } from './storage-error';

export interface CanvasDraft {
  id: string;
  snapshot: CanvasSnapshot;
  localVersion: number;
  confirmedLocalVersion: number;
  serverVersion: number;
  restorationVersion?: number;
  updatedAt: number;
  generationRecoveryReadOnly?: string[];
  recovery?: { kind: 'unverified' | 'conflict' | 'copy' | 'deleted'; sourceId?: string; observationId?: string };
}
export interface SaveRetry {
  attempts: number;
  nextAttemptAt: number;
  error?: string;
  blocked?: 'validation' | 'permanent';
  retryAfter?: number;
}
export interface PendingSave extends SaveOperation { localVersion: number; retry?: SaveRetry }

export function createCanvasRepository(name = 'ai-flow-canvas') {
  let connection: Promise<IDBDatabase> | undefined;
  function open() {
    if (connection) return connection;
    // Start in a microtask so even a synchronous SecurityError clears the
    // cached attempt after it has been assigned, allowing an explicit retry.
    const attempt = Promise.resolve().then(() => new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') throw new CanvasStorageError('unavailable');
      const request = indexedDB.open(name, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('operations')) db.createObjectStore('operations', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata');
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => { blocked = true; reject(new CanvasStorageError('blocked')); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); if (connection === attempt) connection = undefined; };
        resolve(db);
      };
    })).catch(error => {
      if (connection === attempt) connection = undefined;
      throw canvasStorageError(error, 'unavailable');
    });
    connection = attempt;
    return attempt;
  }
  const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await open();
    let tx: IDBTransaction;
    try { tx = db.transaction(['drafts', 'operations', 'metadata'], mode); }
    catch (error) {
      if (error instanceof Error && error.name === 'InvalidStateError') {
        db.close(); connection = undefined;
      }
      throw canvasStorageError(error, 'transaction');
    }
    // Request success isn't a commit. Only this transaction event resolves writes.
    return new Promise<T>((resolve, reject) => {
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(canvasStorageError(tx.error, 'aborted'));
      tx.onerror = () => {}; // onabort reports the final transaction outcome.
      void work(tx).then(output => { value = output; }).catch(error => {
        try { tx.abort(); } catch { /* May already have aborted. */ }
        // Preserve domain errors (such as an invalid recovery choice). Only
        // IndexedDB failures need the storage-specific recovery instructions.
        reject(error instanceof DOMException ? canvasStorageError(error, 'transaction') : error);
      });
    });
  }
  function operation(draft: CanvasDraft): PendingSave {
    return { id: draft.id, requestId: crypto.randomUUID(), baseVersion: draft.serverVersion,
      localVersion: draft.localVersion, snapshot: draft.snapshot };
  }
  function recoveryCopy(sourceId: string, snapshot: CanvasSnapshot): CanvasDraft {
    return { id: crypto.randomUUID(), snapshot: recoverySnapshot(snapshot), localVersion: 1,
      confirmedLocalVersion: 0, serverVersion: 0, updatedAt: Date.now(), recovery: { kind: 'copy', sourceId } };
  }
  return {
    initializeHistory(id: string): Promise<CanvasDraft> {
      return transaction('readwrite', async tx => {
        const drafts = tx.objectStore('drafts');
        const draft = await result<CanvasDraft>(drafts.get(id));
        const history = restoredHistory({ ...draft.snapshot, projectName: draft.snapshot.name });
        if (history === draft.snapshot.history) return draft;
        // Installing a checkpoint is local bookkeeping, not an implicit content
        // write. The first real edit submits it with content in the existing save transaction.
        draft.snapshot = { ...draft.snapshot, history };
        drafts.put(draft);
        return draft;
      });
    },
    allowGenerationRecovery(id: string, nodeId: string) {
      return transaction('readwrite', async tx => {
        const drafts = tx.objectStore('drafts');
        const draft = await result<CanvasDraft | undefined>(drafts.get(id));
        if (!draft?.generationRecoveryReadOnly) return;
        draft.generationRecoveryReadOnly = draft.generationRecoveryReadOnly.filter(value => value !== nodeId);
        drafts.put(draft);
      });
    },
    recoveries(): Promise<CanvasDraft[]> {
      return transaction('readonly', async tx => (await result<CanvasDraft[]>(tx.objectStore('drafts').getAll()))
        .filter(draft => draft.recovery?.kind === 'copy' || draft.recovery?.kind === 'deleted'));
    },
    async migrateLegacy(raw: string | null) {
      // Check completion before parsing: the retained backup may later be damaged.
      if (await transaction('readonly', tx => result(tx.objectStore('metadata').get('legacyMigration')))) return;
      if (raw === null) return;
      const legacy = parseLegacyDraft(raw);
      // Reserve a random identity before import. It survives an aborted import,
      // while identical drafts in independent browsers remain distinct canvases.
      const id = legacy.id ?? await transaction('readwrite', async tx => {
        const metadata = tx.objectStore('metadata');
        const reserved = await result<string | undefined>(metadata.get('legacyDraftId'));
        if (reserved) return reserved;
        const id = crypto.randomUUID();
        metadata.put(id, 'legacyDraftId');
        return id;
      });
      return transaction('readwrite', async tx => {
        const metadata = tx.objectStore('metadata');
        if (await result(metadata.get('legacyMigration'))) return;
        const drafts = tx.objectStore('drafts');
        const existing = await result<CanvasDraft | undefined>(drafts.get(id));
        if (!existing) {
          const draft: CanvasDraft = { id, snapshot: legacy.snapshot, localVersion: !legacy.id && !legacy.snapshot.nodes.length ? 0 : 1,
            confirmedLocalVersion: 0, serverVersion: 0, updatedAt: Date.now(),
            generationRecoveryReadOnly: legacy.snapshot.nodes.map(node => node.id),
            recovery: legacy.id ? { kind: 'unverified' } : undefined };
          drafts.put(draft);
          if (!draft.recovery && draft.localVersion) tx.objectStore('operations').put(operation(draft));
          if (!await result(metadata.get('activeId'))) metadata.put(id, 'activeId');
        }
        if (existing && canonicalJSON(existing.snapshot) !== canonicalJSON(legacy.snapshot)) {
          drafts.put(recoveryCopy(id, legacy.snapshot));
        }
        metadata.put({ id }, 'legacyMigration');
      });
    },
    reconcile(id: string, snapshot: CanvasSnapshot, serverVersion: number): Promise<CanvasDraft> {
      return transaction('readwrite', async tx => {
        const drafts = tx.objectStore('drafts');
        const draft = await result<CanvasDraft>(drafts.get(id));
        if (draft.recovery?.kind !== 'unverified' && draft.recovery?.kind !== 'conflict') return draft;
        if (canonicalJSON(draft.snapshot) === canonicalJSON(snapshot)) {
          draft.serverVersion = serverVersion;
          draft.confirmedLocalVersion = draft.localVersion;
          delete draft.recovery;
        } else draft.recovery = { kind: 'conflict' };
        drafts.put(draft);
        return draft;
      });
    },
    reconcileDeleted(id: string, snapshot: CanvasSnapshot, serverVersion: number, observationId?: string): Promise<CanvasDraft> {
      return transaction('readwrite', async tx => {
        const drafts = tx.objectStore('drafts');
        const draft = await result<CanvasDraft>(drafts.get(id));
        // Only a read started after this deletion observation can establish that
        // the original project was restored. Another deletion invalidates it.
        if (draft.recovery?.kind !== 'deleted' || draft.recovery.observationId !== observationId ||
            serverVersion <= Math.max(draft.serverVersion, draft.restorationVersion ?? 0)) return draft;
        const matches = canonicalJSON(draft.snapshot) === canonicalJSON(snapshot);
        if (!matches && draft.localVersion > draft.confirmedLocalVersion) {
          draft.recovery = { kind: 'conflict' };
          draft.restorationVersion = serverVersion;
          drafts.put(draft);
          return draft;
        }
        const version = draft.localVersion + 1;
        const restored: CanvasDraft = { ...draft, snapshot, serverVersion, restorationVersion: serverVersion, localVersion: version,
          confirmedLocalVersion: version, updatedAt: Date.now() };
        delete restored.recovery;
        drafts.put(restored);
        tx.objectStore('operations').delete(id);
        return restored;
      });
    },
    adoptRemote(id: string, snapshot: CanvasSnapshot, serverVersion: number): Promise<CanvasDraft> {
      return transaction('readwrite', async tx => {
        const drafts = tx.objectStore('drafts');
        const previous = await result<CanvasDraft>(drafts.get(id));
        if (!previous?.recovery || previous.recovery.kind === 'copy') throw new Error('画布无需恢复');
        if (previous.recovery.kind === 'deleted') throw new Error('画布已被删除，请将本地内容另存为新画布');
        if (serverVersion < previous.serverVersion) throw new Error('读取的服务端版本已过期，请重新核对');
        // Backup and replacement commit together; a failed transaction changes neither.
        drafts.put(recoveryCopy(id, previous.snapshot));
        const version = previous.localVersion + 1;
        const draft: CanvasDraft = { id, snapshot, serverVersion, localVersion: version,
          confirmedLocalVersion: version, updatedAt: Date.now(),
          restorationVersion: previous.restorationVersion,
          generationRecoveryReadOnly: [...new Set([...(previous.generationRecoveryReadOnly ?? []), ...snapshot.nodes.map(node => node.id)])] };
        drafts.put(draft);
        tx.objectStore('operations').delete(id);
        tx.objectStore('metadata').put(id, 'activeId');
        return draft;
      });
    },
    saveRecoveryAsNew(id: string): Promise<CanvasDraft> {
      return transaction('readwrite', async tx => {
        const drafts = tx.objectStore('drafts');
        const source = await result<CanvasDraft>(drafts.get(id));
        if (!source?.recovery) throw new Error('画布无需恢复');
        const draft = recoveryCopy(id, source.snapshot);
        delete draft.recovery;
        drafts.put(draft);
        tx.objectStore('operations').put(operation(draft));
        tx.objectStore('metadata').put(draft.id, 'activeId');
        return draft;
      });
    },
    async read(id?: string | null): Promise<CanvasDraft | undefined> {
      return transaction('readonly', async tx => {
        const key = id ?? await result(tx.objectStore('metadata').get('activeId'));
        return key ? result(tx.objectStore('drafts').get(key)) : undefined;
      });
    },
    async commit(id: string, snapshot: CanvasSnapshot, serverVersion: number, expectedLocalVersion?: number): Promise<CanvasDraft> {
      return transaction('readwrite', async tx => {
        const drafts = tx.objectStore('drafts');
        const previous = await result<CanvasDraft | undefined>(drafts.get(id));
        if (expectedLocalVersion !== undefined && (previous?.localVersion ?? 0) !== expectedLocalVersion) {
          const copy = recoveryCopy(id, snapshot);
          // Keep editor identities until the user explicitly saves a new canvas.
          copy.snapshot = snapshot;
          copy.generationRecoveryReadOnly = snapshot.nodes.map(node => node.id);
          drafts.put(copy);
          tx.objectStore('metadata').put(copy.id, 'activeId');
          return copy;
        }
        const draft: CanvasDraft = { id, snapshot, localVersion: (previous?.localVersion ?? 0) + 1,
          confirmedLocalVersion: previous?.confirmedLocalVersion ?? 0,
          serverVersion: previous?.serverVersion ?? serverVersion, restorationVersion: previous?.restorationVersion,
          updatedAt: Date.now(), recovery: previous?.recovery, generationRecoveryReadOnly: previous?.generationRecoveryReadOnly };
        drafts.put(draft);
        const operations = tx.objectStore('operations');
        // An unconfirmed operation is immutable, even if the user edits again.
        const pending = await result<PendingSave | undefined>(operations.get(id));
        // Only a definitive validation rejection allows replacing the request.
        // Transport failures leave an unknown result that must first be replayed.
        if (!draft.recovery && (!pending || pending.retry?.blocked === 'validation')) operations.put(operation(draft));
        tx.objectStore('metadata').put(id, 'activeId');
        return draft;
      });
    },
    async adopt(id: string, snapshot: CanvasSnapshot, serverVersion: number): Promise<CanvasDraft> {
      return transaction('readwrite', async tx => {
        const drafts = tx.objectStore('drafts');
        const previous = await result<CanvasDraft | undefined>(drafts.get(id));
        tx.objectStore('metadata').put(id, 'activeId');
        // A GET may have started before another tab confirmed a newer write
        // or observed deletion. Reading cannot undo either persisted decision.
        if (previous && (previous.recovery || previous.serverVersion > serverVersion ||
            previous.localVersion > previous.confirmedLocalVersion)) return previous;
        if (!snapshot.history && previous?.snapshot.history &&
            canonicalJSON({ ...previous.snapshot, history: undefined }) === canonicalJSON({ ...snapshot, history: undefined })) {
          snapshot = { ...snapshot, history: previous.snapshot.history };
        }
        const version = previous ? previous.localVersion + (canonicalJSON(previous.snapshot) === canonicalJSON(snapshot) ? 0 : 1) : 0;
        const draft = { id, snapshot, serverVersion, restorationVersion: previous?.restorationVersion,
          localVersion: version, confirmedLocalVersion: version, updatedAt: Date.now(), generationRecoveryReadOnly: previous?.generationRecoveryReadOnly };
        drafts.put(draft);
        return draft;
      });
    },
    all(): Promise<CanvasDraft[]> {
      return transaction('readonly', tx => result(tx.objectStore('drafts').getAll()));
    },
    markRecovery(id: string, kind: 'conflict' | 'deleted', requestId?: string, error?: string, observedServerVersion?: number): Promise<CanvasDraft> {
      return transaction('readwrite', async tx => {
        const drafts = tx.objectStore('drafts');
        const draft = await result<CanvasDraft>(drafts.get(id));
        const operations = tx.objectStore('operations');
        const pending = await result<PendingSave | undefined>(operations.get(id));
        // A deletion response from before a confirmed restoration must not
        // poison that restored project. Unversioned explicit deletion still wins.
        if (kind === 'deleted' && observedServerVersion !== undefined && (draft.restorationVersion ?? 0) > observedServerVersion) return draft;
        // Late conflict responses cannot invalidate a newer operation.
        if (kind !== 'deleted' && requestId && pending?.requestId !== requestId) return draft;
        if (kind === 'deleted') draft.recovery = { kind, observationId: crypto.randomUUID() };
        else if (draft.recovery?.kind !== 'deleted') draft.recovery = { kind };
        drafts.put(draft);
        if (pending) operations.put({ ...pending, retry: { attempts: pending.retry?.attempts ?? 0,
          nextAttemptAt: 0, blocked: 'permanent', error: error ?? pending.retry?.error ?? '同步已暂停，本地内容已保留' } });
        return draft;
      });
    },
    pending(id: string): Promise<PendingSave | undefined> {
      return transaction('readonly', tx => result(tx.objectStore('operations').get(id)));
    },
    retry(sent: PendingSave, retry: SaveRetry): Promise<PendingSave | undefined> {
      return transaction('readwrite', async tx => {
        const operations = tx.objectStore('operations');
        const pending = await result<PendingSave | undefined>(operations.get(sent.id));
        if (pending?.requestId !== sent.requestId) return pending;
        const draft = await result<CanvasDraft>(tx.objectStore('drafts').get(sent.id));
        if (draft.recovery) return undefined;
        const next = retry.blocked === 'validation' && draft.localVersion > sent.localVersion
          ? operation(draft) : { ...pending, retry };
        operations.put(next);
        return next;
      });
    },
    async acknowledge(sent: PendingSave, ack: SaveAcknowledgement): Promise<CanvasDraft> {
      if (ack.id !== sent.id || ack.requestId !== sent.requestId || ack.version !== sent.baseVersion + 1) {
        throw new Error('保存响应身份或版本不匹配');
      }
      return transaction('readwrite', async tx => {
        const drafts = tx.objectStore('drafts');
        const draft = await result<CanvasDraft>(drafts.get(sent.id));
        const operations = tx.objectStore('operations');
        const pending = await result<PendingSave | undefined>(operations.get(sent.id));
        if (draft.recovery || !pending || pending.requestId !== sent.requestId) return draft;
        draft.confirmedLocalVersion = sent.localVersion;
        draft.serverVersion = ack.version;
        drafts.put(draft);
        operations.delete(sent.id);
        if (draft.localVersion > sent.localVersion) operations.put(operation(draft));
        return draft;
      });
    },
    setActive(id: string | null) {
      return transaction('readwrite', async tx => {
        if (id) tx.objectStore('metadata').put(id, 'activeId');
        else tx.objectStore('metadata').delete('activeId');
      });
    },
    clearActive() {
      return transaction('readwrite', async tx => { tx.objectStore('metadata').delete('activeId'); });
    },
  };
}
export type CanvasRepository = ReturnType<typeof createCanvasRepository>;
