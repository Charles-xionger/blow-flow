require('../scripts/register-typescript.cjs');
require('fake-indexeddb/auto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCanvasRepository } = require('../lib/canvas/local-repository.ts');

// The repository is the documented local durability boundary. Faults originate
// at IndexedDB, while assertions use only its public read/commit operations.
test('a synchronous IndexedDB open failure is explained and can be retried', async () => {
  const repository = createCanvasRepository('storage-' + crypto.randomUUID());
  const original = indexedDB.open;
  indexedDB.open = () => { throw new DOMException('blocked by browser', 'SecurityError'); };
  try {
    await assert.rejects(repository.read(), error => error.kind === 'unavailable' && /浏览器/.test(error.message));
  } finally { indexedDB.open = original; }
  assert.equal(await repository.read(), undefined);
});

for (const failure of ['QuotaExceededError', 'AbortError']) {
  test(`${failure} preserves the last committed draft and its unconfirmed operation`, async () => {
    const repository = createCanvasRepository('storage-' + crypto.randomUUID());
    const snapshot = { name: 'Last durable edit', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const initial = await repository.commit('canvas', snapshot, 0);
    const operation = await repository.pending('canvas');
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'drafts') throw new DOMException('injected storage failure', failure);
      return original.apply(this, args);
    };
    try {
      await assert.rejects(repository.commit('canvas', { ...snapshot, name: 'Unsaved edit' }, 0), error =>
        error.kind === (failure === 'QuotaExceededError' ? 'quota' : 'aborted'));
    } finally { IDBObjectStore.prototype.put = original; }
    assert.deepEqual(await repository.read('canvas'), initial);
    assert.deepEqual(await repository.pending('canvas'), operation);
    await repository.commit('canvas', { ...snapshot, name: 'Unsaved edit' }, 0);
    assert.equal((await repository.read('canvas')).snapshot.name, 'Unsaved edit');
  });
}

test('an older server acknowledgement cannot erase the latest local save failure', async t => {
  const { createStore } = require('zustand/vanilla');
  const { createCanvasAutosave } = require('../lib/canvas/autosave.ts');
  const store = createStore(() => ({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, projectName: 'Canvas',
    currentWorkflowId: null, canvasSession: 0, serverVersion: 0, persistenceReady: false, saveStatus: 'loading', saveError: null }));
  const repository = createCanvasRepository('storage-' + crypto.randomUUID());
  let release;
  let requested;
  const request = new Promise(resolve => { requested = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const previousFetch = global.fetch;
  global.fetch = async (_url, options) => {
    requested(); await gate;
    const body = JSON.parse(options.body);
    return Response.json({ success: true, data: { id: body.id, requestId: body.requestId, version: body.baseVersion + 1 } });
  };
  const saver = createCanvasAutosave(store, () => {}, 100_000, repository);
  const stop = saver.start();
  t.after(async () => { release(); stop(); await saver.flush().catch(() => {}); global.fetch = previousFetch; });
  await saver.open();
  store.setState({ nodes: [{ id: 'node', position: { x: 0, y: 0 }, data: { text: 'keep me' } }] });
  const pendingSave = saver.flush();
  await request;
  store.setState({ projectName: 'Unsaved latest edit' });
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'drafts') throw new DOMException('full', 'QuotaExceededError');
    return put.apply(this, args);
  };
  try { await assert.rejects(saver.flush(), /空间不足/); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal(store.getState().saveStatus, 'local-error');
  release(); await pendingSave;
  assert.equal(store.getState().saveStatus, 'local-error');
  assert.equal(store.getState().projectName, 'Unsaved latest edit');
  await saver.save();
  assert.equal(store.getState().saveStatus, 'synced');
});

test('opening another canvas freezes editing before the old local transaction begins', async t => {
  const { createStore } = require('zustand/vanilla');
  const { createCanvasAutosave } = require('../lib/canvas/autosave.ts');
  const snapshot = { name: 'Original', nodes: [{ id: 'node', position: { x: 0, y: 0 }, data: { text: 'keep' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const repository = createCanvasRepository('storage-' + crypto.randomUUID());
  await repository.adopt('a', snapshot, 1);
  const store = createStore(() => ({ nodes: [], edges: [], viewport: snapshot.viewport, projectName: 'Canvas',
    currentWorkflowId: null, canvasSession: 0, serverVersion: 0, persistenceReady: false, saveStatus: 'loading', saveError: null }));
  const fetch = global.fetch;
  global.fetch = async (_url, options) => {
    if (options?.body) {
      const body = JSON.parse(options.body);
      return Response.json({ success: true, data: { id: body.id, requestId: body.requestId, version: body.baseVersion + 1 } });
    }
    return Response.json({ success: true, data: { ...snapshot, version: 1 } });
  };
  const saver = createCanvasAutosave(store, () => {}, 100_000, repository);
  const stop = saver.start();
  t.after(async () => { stop(); await saver.flush().catch(() => {}); global.fetch = fetch; });
  await saver.open('a');
  store.setState({ projectName: 'Last available edit' });
  const opening = saver.open('b');
  assert.equal(store.getState().persistenceReady, false);
  await opening;
  assert.equal((await repository.read('a')).snapshot.name, 'Last available edit');
  assert.equal(store.getState().currentWorkflowId, 'b');
});
