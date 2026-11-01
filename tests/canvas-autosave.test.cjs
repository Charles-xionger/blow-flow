require('../scripts/register-typescript.cjs');
require('fake-indexeddb/auto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('zustand/vanilla');
const { createCanvasAutosave } = require('../lib/canvas/autosave.ts');
const { createCanvasRepository } = require('../lib/canvas/local-repository.ts');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(5); }
  assert.fail('condition timed out');
}
const node = id => ({ id, position: { x: 0, y: 0 }, data: { text: id } });
const ack = body => Response.json({ success: true, data: { id: body.id, requestId: body.requestId, version: body.baseVersion + 1 } });
async function setup(t, delay = 10, maxWait = 50) {
  const calls = [];
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    return ack(body);
  };
  const repository = createCanvasRepository('test-' + crypto.randomUUID());
  const store = createStore(() => ({
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, projectName: 'Canvas',
    currentWorkflowId: null, canvasSession: 0, serverVersion: 0,
    persistenceReady: false, saveStatus: 'loading', saveError: null,
  }));
  const errors = [];
  const saver = createCanvasAutosave(store, e => errors.push(e), delay, repository, maxWait);
  const stop = saver.start();
  await saver.open();
  t.after(async () => { stop(); await saver.flush().catch(() => {}); global.fetch = previousFetch; });
  return { store, saver, calls, errors, repository };
}

test('autosave creates once, updates edits, and persists deleting the last node', async t => {
  const { store, saver, calls, repository } = await setup(t);
  store.setState({ nodes: [node('one')] });
  await saver.flush();
  const id = store.getState().currentWorkflowId;
  store.setState({ nodes: [node('one'), node('two')], projectName: 'Edited' });
  await saver.save();
  store.setState({ nodes: [] });
  await saver.flush();
  assert.deepEqual(calls.map(c => c.body.baseVersion), [0, 1, 2]);
  assert.ok(calls.every(c => c.body.id === id));
  assert.equal(calls[1].body.snapshot.nodes.length, 2);
  assert.equal(calls[1].body.snapshot.name, 'Edited');
  assert.deepEqual(calls[2].body.snapshot.nodes, []);
  assert.equal((await repository.read(id)).confirmedLocalVersion, 3);
  assert.equal(store.getState().saveStatus, 'synced');
});

test('edits commit locally during a slow save; late confirmation cannot mark newer edits synced', async t => {
  const { store, saver, repository } = await setup(t);
  const calls = []; let release;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    await new Promise(resolve => { release = resolve; });
    return ack(body);
  };
  store.setState({ nodes: [node('one')] });
  const first = saver.flush();
  await until(() => calls.length === 1);
  store.setState({ nodes: [node('one'), node('two')] });
  const manual = saver.save();
  await wait(20);
  const draft = await repository.read(store.getState().currentWorkflowId);
  assert.equal(draft.snapshot.nodes.length, 2);
  assert.equal(draft.confirmedLocalVersion, 0);
  release();
  await until(() => calls.length === 2);
  assert.notEqual(store.getState().saveStatus, 'synced');
  assert.equal(calls[1].baseVersion, 1);
  assert.equal(calls[1].snapshot.nodes.length, 2);
  release();
  await Promise.all([first, manual]);
  assert.equal(store.getState().saveStatus, 'synced');
});

test('failed requests retry the immutable operation before sending later edits', async t => {
  const { store, saver, calls } = await setup(t);
  const success = global.fetch; let failed;
  global.fetch = async (url, options) => { failed = JSON.parse(options.body); throw Error('offline'); };
  store.setState({ nodes: [node('one')] });
  await assert.rejects(saver.flush(), /offline/);
  store.setState({ nodes: [node('one'), node('two')] });
  global.fetch = success;
  await saver.save();
  assert.deepEqual(calls[0].body, failed);
  assert.equal(calls[1].body.snapshot.nodes.length, 2);
});

test('selection, measurement, menus and theme do not create content versions', async t => {
  const { store, saver, calls } = await setup(t);
  store.setState({ nodes: [node('one')] }); await saver.save();
  store.setState({ nodes: [{ ...node('one'), selected: true, measured: { width: 100, height: 20 }, data: { text: 'one', activeToolbarItem: 'menu' } }], isDarkMode: true });
  await saver.flush();
  assert.equal(calls.length, 1);
});

test('drag batches until release; continuous non-drag editing has a maximum local wait', async t => {
  const { store, saver, calls } = await setup(t, 20, 60);
  saver.beginInteraction('drag');
  for (let i = 0; i < 8; i++) { store.setState({ nodes: [{ ...node('one'), position: { x: i, y: 0 } }] }); await wait(10); }
  assert.equal(calls.length, 0);
  saver.endInteraction('drag');
  await until(() => calls.length === 1);
  assert.equal(calls[0].body.snapshot.nodes[0].position.x, 7);
  for (let i = 0; i < 10; i++) { store.setState({ projectName: `Edit ${i}` }); await wait(10); }
  assert.ok(calls.length >= 2, 'ongoing edits must commit before they stop');
  await saver.flush();
});

test('wrong response identity never confirms local content', async t => {
  const { store, saver, repository } = await setup(t);
  global.fetch = async () => Response.json({ success: true, data: { id: 'wrong', requestId: 'wrong', version: 1 } });
  store.setState({ nodes: [node('one')] });
  await assert.rejects(saver.save(), /不匹配/);
  assert.equal(store.getState().saveStatus, 'sync-error');
  assert.equal((await repository.read(store.getState().currentWorkflowId)).confirmedLocalVersion, 0);
});

test('aborting a local transaction after a successful put never reports saved or sends HTTP', async t => {
  const { store, saver, calls } = await setup(t);
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const request = original.apply(this, args);
    if (this.name === 'drafts') request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try {
    store.setState({ nodes: [node('one')] });
    await assert.rejects(saver.save());
    assert.equal(store.getState().saveStatus, 'local-error');
    assert.equal(calls.length, 0);
  } finally { IDBObjectStore.prototype.put = original; }
});

test('layout, edges and viewport changes share the same versioned save path', async t => {
  const { store, saver, repository } = await setup(t);
  store.setState({ nodes: [node('source'), node('target')] });
  await saver.save();
  store.setState({ nodes: [{ ...node('source'), position: { x: 45, y: 60 } }, node('target')],
    edges: [{ id: 'edge', source: 'source', target: 'target' }], viewport: { x: 100, y: -30, zoom: 1.5 } });
  await saver.save();
  const draft = await repository.read(store.getState().currentWorkflowId);
  assert.deepEqual(draft.snapshot.nodes[0].position, { x: 45, y: 60 });
  assert.equal(draft.snapshot.edges[0].target, 'target');
  assert.deepEqual(draft.snapshot.viewport, { x: 100, y: -30, zoom: 1.5 });
  store.setState({ edges: [] }); await saver.save();
  assert.deepEqual((await repository.read(draft.id)).snapshot.edges, []);
});

test('opening another canvas sends the local commit without waiting for another edit', async t => {
  const { store, saver, calls } = await setup(t);
  const write = global.fetch;
  global.fetch = async (url, options) => options ? write(url, options) : Response.json({ success: true,
    data: { id: 'other', name: 'Other', version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } });
  store.setState({ nodes: [node('before-switch')] });
  await saver.open('other');
  await until(() => calls.length > 0);
  assert.equal(calls[0].body.snapshot.nodes[0].id, 'before-switch');
  assert.equal(store.getState().currentWorkflowId, 'other');
});
