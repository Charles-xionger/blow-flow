import { canonicalJSON, type CanvasSnapshot, type SaveAcknowledgement, type SaveOperation } from './save-protocol';
import { recoverySnapshot } from './recovery-copy';
import { parseLegacyDraft } from './legacy-draft';

export interface CanvasDraft {
  id: string;
  snapshot: CanvasSnapshot;
  localVersion: number;
  confirmedLocalVersion: number;
  serverVersion: number;
  updatedAt: number;
  generationRecoveryReadOnly?: string[];
  recovery?: { kind: 'unverified' | 'conflict' | 'copy'; sourceId?: string };
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
    return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('drafts', { keyPath: 'id' });
        db.createObjectStore('operations', { keyPath: 'id' });
        db.createObjectStore('metadata');
      };
      request.onerror = () => { connection = undefined; reject(request.error); };
      request.onblocked = () => { blocked = true; connection = undefined; reject(new Error('本地数据库升级被其他页面阻塞')); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); connection = undefined; };
        resolve(db);
      };
    });
  }
  const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await open();
    const tx = db.transaction(['drafts', 'operations', 'metadata'], mode);
    // Request success isn't a commit. Only this transaction event resolves writes.
    return new Promise<T>((resolve, reject) => {
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error || new Error('本地保存事务已取消'));
      tx.onerror = () => {}; // onabort reports the final transaction outcome.
      void work(tx).then(output => { value = output; }).catch(error => {
        try { tx.abort(); } catch { /* May already have aborted. */ }
        reject(error);
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
        .filter(draft => draft.recovery?.kind === 'copy'));
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
        if (!draft.recovery || draft.recovery.kind === 'copy') return draft;
        if (canonicalJSON(draft.snapshot) === canonicalJSON(snapshot)) {
          draft.serverVersion = serverVersion;
          draft.confirmedLocalVersion = draft.localVersion;
          delete draft.recovery;
        } else draft.recovery = { kind: 'conflict' };
        drafts.put(draft);
        return draft;
      });
    },
    adoptRemote(id: string, snapshot: CanvasSnapshot, serverVersion: number): Promise<CanvasDraft> {
      return transaction('readwrite', async tx => {
        const drafts = tx.objectStore('drafts');
        const previous = await result<CanvasDraft>(drafts.get(id));
        if (!previous?.recovery || previous.recovery.kind === 'copy') throw new Error('画布无需恢复');
        // Backup and replacement commit together; a failed transaction changes neither.
        drafts.put(recoveryCopy(id, previous.snapshot));
        const version = previous.localVersion + 1;
        const draft: CanvasDraft = { id, snapshot, serverVersion, localVersion: version,
          confirmedLocalVersion: version, updatedAt: Date.now(),
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
    async commit(id: string, snapshot: CanvasSnapshot, serverVersion: number): Promise<CanvasDraft> {
      return transaction('readwrite', async tx => {
        const drafts = tx.objectStore('drafts');
        const previous = await result<CanvasDraft | undefined>(drafts.get(id));
        const draft: CanvasDraft = { id, snapshot, localVersion: (previous?.localVersion ?? 0) + 1,
          confirmedLocalVersion: previous?.confirmedLocalVersion ?? 0,
          serverVersion: previous?.serverVersion ?? serverVersion, updatedAt: Date.now(), recovery: previous?.recovery, generationRecoveryReadOnly: previous?.generationRecoveryReadOnly };
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
        if (previous && previous.localVersion > previous.confirmedLocalVersion) return previous;
        const version = previous?.localVersion ?? 0;
        const draft = { id, snapshot, serverVersion, localVersion: version, confirmedLocalVersion: version, updatedAt: Date.now(), generationRecoveryReadOnly: previous?.generationRecoveryReadOnly };
        drafts.put(draft);
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
        if (!pending || pending.requestId !== sent.requestId) return draft;
        draft.confirmedLocalVersion = sent.localVersion;
        draft.serverVersion = ack.version;
        drafts.put(draft);
        operations.delete(sent.id);
        if (draft.localVersion > sent.localVersion) operations.put(operation(draft));
        return draft;
      });
    },
    clearActive() {
      return transaction('readwrite', async tx => { tx.objectStore('metadata').delete('activeId'); });
    },
  };
}
export type CanvasRepository = ReturnType<typeof createCanvasRepository>;
