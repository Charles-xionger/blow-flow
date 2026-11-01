import type { CanvasSnapshot, SaveAcknowledgement, SaveOperation } from './save-protocol';

export interface CanvasDraft {
  id: string;
  snapshot: CanvasSnapshot;
  localVersion: number;
  confirmedLocalVersion: number;
  serverVersion: number;
  updatedAt: number;
}
export interface PendingSave extends SaveOperation { localVersion: number }

// The old canvas-storage localStorage key is intentionally untouched. Ticket 03
// will migrate it using the metadata store in the same transaction as its draft.
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
  return {
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
          serverVersion: previous?.serverVersion ?? serverVersion, updatedAt: Date.now() };
        drafts.put(draft);
        const operations = tx.objectStore('operations');
        // An unconfirmed operation is immutable, even if the user edits again.
        if (!await result(operations.get(id))) operations.put(operation(draft));
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
        const draft = { id, snapshot, serverVersion, localVersion: version, confirmedLocalVersion: version, updatedAt: Date.now() };
        drafts.put(draft);
        return draft;
      });
    },
    pending(id: string): Promise<PendingSave | undefined> {
      return transaction('readonly', tx => result(tx.objectStore('operations').get(id)));
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
