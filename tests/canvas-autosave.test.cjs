/* eslint-disable @typescript-eslint/no-require-imports -- Node test entry point. */
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
async function setup(t, delay = 10, maxWait = 50, options = {}) {
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
  const saver = createCanvasAutosave(store, e => errors.push(e), delay, repository, maxWait, options);
  const stop = saver.start();
  await saver.open();
  t.after(async () => { stop(); await saver.flush().catch(() => {}); global.fetch = previousFetch; });
  return { store, saver, calls, errors, repository, stop };
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

test('a restored project matching its pending draft clears the old deletion error and reports synced', async t => {
  const { store, saver, repository } = await setup(t);
  store.setState({ nodes: [node('one')] });
  await saver.save();
  const id = store.getState().currentWorkflowId;
  store.setState({ projectName: 'Restored content' });
  global.fetch = async () => Response.json({ success: false, error: '画布已被删除' }, { status: 410 });
  await assert.rejects(saver.flush(), /删除/);
  const snapshot = (await repository.read(id)).snapshot;
  global.fetch = async () => Response.json({ success: true, data: { id, ...snapshot, version: 4 } });
  await saver.open(id);
  assert.equal(store.getState().recovery, undefined);
  assert.equal(await repository.pending(id), undefined);
  assert.equal(store.getState().saveStatus, 'synced');
  assert.equal(store.getState().saveError, null);
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

test('save status stays put while dragging and becomes saving on release', async t => {
  const { store, saver } = await setup(t);
  store.setState({ nodes: [node('one')] });
  await saver.flush();
  assert.equal(store.getState().saveStatus, 'synced');
  saver.beginInteraction('drag');
  const statuses = [];
  const unsubscribe = store.subscribe(state => statuses.push(state.saveStatus));
  for (let i = 0; i < 5; i++) store.setState({ nodes: [{ ...node('one'), position: { x: i, y: 0 } }] });
  unsubscribe();
  assert.deepEqual(new Set(statuses), new Set(['synced']));
  saver.endInteraction('drag');
  assert.equal(store.getState().saveStatus, 'saving');
  await saver.flush();
  assert.equal(store.getState().saveStatus, 'synced');
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
  global.fetch = async (url, options) => options?.method === 'PUT' ? write(url, options) : Response.json({ success: true,
    data: { id: 'other', name: 'Other', version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } });
  store.setState({ nodes: [node('before-switch')] });
  await saver.open('other');
  await until(() => calls.length > 0);
  assert.equal(calls[0].body.snapshot.nodes[0].id, 'before-switch');
  assert.equal(store.getState().currentWorkflowId, 'other');
});


for (const stage of ['headers', 'body']) test(`a timed out request (${stage}) releases the queue and its late response cannot confirm newer content`, async t => {
  const { store, saver, repository } = await setup(t, 10, 50, { requestTimeoutMs: 20 });
  const sent = []; let release;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    const response = ack(body);
    if (sent.length === 1) {
      const gate = new Promise(resolve => { release = resolve; });
      if (stage === 'headers') await gate;
      else {
        const json = response.json.bind(response);
        response.json = async () => { await gate; return json(); };
      }
    }
    return response;
  };
  store.setState({ nodes: [node('original')] });
  let outcome;
  const first = saver.save().then(() => { outcome = 'saved'; }, e => { outcome = e.message; });
  try {
    await until(() => sent.length === 1);
    await wait(60);
    assert.match(outcome || '', /超时/);
    store.setState({ nodes: [node('newer')] });
    await saver.save();
    assert.deepEqual(sent[1], sent[0], 'retry must verify the original unknown result');
    assert.equal(sent[2].snapshot.nodes[0].id, 'newer');
    release(); await first; await wait(10);
    const draft = await repository.read(store.getState().currentWorkflowId);
    assert.equal(draft.serverVersion, 2);
    assert.equal(draft.localVersion, draft.confirmedLocalVersion);
    assert.equal(store.getState().saveStatus, 'synced');
  } finally { release?.(); await first; }
});

test('validation rejection pauses retries and corrected content can resume saving', async t => {
  const { store, saver, repository } = await setup(t);
  const sent = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    return body.snapshot.name.trim() ? ack(body) : Response.json({ success: false, error: 'Invalid name' }, { status: 400 });
  };
  store.setState({ nodes: [node('kept')], projectName: ' ' });
  await assert.rejects(saver.save(), /Invalid name/);
  await wait(1100);
  assert.equal(sent.length, 1, 'validation errors must not loop automatically');
  assert.equal(store.getState().saveStatus, 'sync-error');
  store.setState({ projectName: 'Corrected' });
  await saver.save();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].requestId, sent[0].requestId);
  const draft = await repository.read(store.getState().currentWorkflowId);
  assert.equal(draft.snapshot.nodes[0].id, 'kept');
  assert.equal(draft.confirmedLocalVersion, 2);
  assert.equal(store.getState().saveStatus, 'synced');
});

// IndexedDB uses asynchronous events; drain those without advancing retry time.
async function drain() { for (let i = 0; i < 60; i++) await new Promise(resolve => setImmediate(resolve)); }

test('rate limiting honors Retry-After even for manual saves and resumes at the deadline', async t => {
  const { store, saver } = await setup(t);
  const sent = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    return sent.length === 1 ? Response.json({ success: false, error: '限流' }, {
      status: 429, headers: { 'Retry-After': '3' },
    }) : ack(body);
  };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  try {
    store.setState({ nodes: [node('rate-limited')] });
    await assert.rejects(saver.save(), /限流/);
    await assert.rejects(saver.save(), /限流|等待/);
    assert.equal(sent.length, 1);
    t.mock.timers.tick(2999); await drain();
    assert.equal(sent.length, 1);
    t.mock.timers.tick(1); await drain();
    assert.equal(store.getState().saveStatus, 'synced');
    assert.deepEqual(sent[1], sent[0]);
  } finally { t.mock.timers.reset(); }
});

test('restarting while a request is unresolved preserves a retry deadline instead of immediately resending', async t => {
  const { store, saver, repository, stop } = await setup(t);
  const sent = []; let release;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    if (sent.length === 1) await new Promise(resolve => { release = resolve; });
    return ack(body);
  };
  store.setState({ nodes: [node('unresolved')] });
  const saving = saver.save();
  await until(() => sent.length === 1);
  stop();
  const restoredStore = createStore(() => ({ ...store.getState(), persistenceReady: false }));
  const restored = createCanvasAutosave(restoredStore, () => {}, 10, repository);
  const stopRestored = restored.start();
  try {
    await restored.open(); await drain();
    assert.equal(sent.length, 1, 'a restart must retain the in-flight retry deadline');
    assert.equal(restoredStore.getState().nodes[0].id, 'unresolved');
    await restored.save();
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(restoredStore.getState().saveStatus, 'synced');
  } finally { release?.(); await saving; stopRestored(); }
});

test('transient failures use jittered exponential backoff capped near 30 seconds across restart', async t => {
  const { store, saver, repository, stop } = await setup(t);
  const sent = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); sent.push({ body, at: Date.now() });
    return sent.length < 8 ? Response.json({ success: false, error: 'temporary' }, { status: 503 }) : ack(body);
  };
  t.mock.method(Math, 'random', () => 0.5);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  let stopRestored;
  try {
    store.setState({ nodes: [node('backoff')] });
    await assert.rejects(saver.save(), /temporary/);
    stop();
    const restoredStore = createStore(() => ({ ...store.getState(), persistenceReady: false }));
    const restored = createCanvasAutosave(restoredStore, () => {}, 10, repository);
    stopRestored = restored.start();
    await restored.open(); await drain();
    assert.equal(sent.length, 1);
    for (const [index, interval] of [875, 1750, 3500, 7000, 14000, 26250, 26250].entries()) {
      t.mock.timers.tick(interval - 1); await drain();
      assert.equal(sent.length, index + 1, 'must not send early');
      t.mock.timers.tick(1); await drain();
      assert.equal(sent.length, index + 2);
      assert.deepEqual(sent[index + 1].body, sent[0].body);
      assert.equal(sent[index + 1].at - sent[index].at, interval);
    }
    assert.equal(restoredStore.getState().saveStatus, 'synced');
  } finally { stopRestored?.(); t.mock.timers.reset(); }
});

for (const status of [401, 403, 404, 409, 410]) {
  test(`HTTP ${status} remains paused after edits and restart with its original request intact`, async t => {
    const { store, saver, repository, stop } = await setup(t);
    const sent = [];
    global.fetch = async (url, options) => {
      sent.push(JSON.parse(options.body));
      return Response.json({ success: false, error: `blocked ${status}` }, { status });
    };
    store.setState({ nodes: [node('original')] });
    await assert.rejects(saver.save(), /blocked/);
    store.setState({ nodes: [node('preserved edit')] });
    await saver.flush();
    stop();
    const restoredStore = createStore(() => ({ ...store.getState(), persistenceReady: false }));
    const restored = createCanvasAutosave(restoredStore, () => {}, 10, repository);
    const stopRestored = restored.start();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    try {
      await restored.open(); await drain();
      t.mock.timers.tick(60_000); await drain();
      assert.equal(sent.length, 1);
      assert.equal(restoredStore.getState().saveStatus, status === 409 || status === 410 ? 'recovery' : 'sync-error');
      if (status !== 409 && status !== 410) assert.match(restoredStore.getState().saveError, /blocked/);
      assert.equal(restoredStore.getState().nodes[0].id, 'preserved edit');
      assert.equal((await repository.pending(sent[0].id)).requestId, sent[0].requestId);
    } finally { stopRestored(); t.mock.timers.reset(); }
  });
}

test('offline manual saving commits locally without reporting server success; reconnect flush wakes the queue', async t => {
  const { store, saver, calls, repository } = await setup(t);
  const original = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  try {
    store.setState({ nodes: [node('offline')] });
    await assert.rejects(saver.save(), /本地|网络/);
    assert.equal(calls.length, 0);
    assert.equal(store.getState().saveStatus, 'pending');
    assert.equal((await repository.read(store.getState().currentWorkflowId)).snapshot.nodes[0].id, 'offline');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    await saver.flush();
    assert.equal(store.getState().saveStatus, 'synced');
    assert.equal(calls.length, 1);
  } finally {
    if (original) Object.defineProperty(navigator, 'onLine', original); else delete navigator.onLine;
  }
});

test('offline startup restores a persisted permanent error instead of treating it as a retryable draft', async t => {
  const { store, saver, repository, stop } = await setup(t);
  global.fetch = async () => Response.json({ success: false, error: 'Permission denied' }, { status: 403 });
  store.setState({ nodes: [node('retained')] });
  await assert.rejects(saver.save(), /Permission denied/);
  stop();
  const original = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  const restoredStore = createStore(() => ({ ...store.getState(), persistenceReady: false }));
  const restored = createCanvasAutosave(restoredStore, () => {}, 10, repository);
  const stopRestored = restored.start();
  try {
    await restored.open(); await drain();
    assert.equal(restoredStore.getState().saveStatus, 'sync-error');
    assert.equal(restoredStore.getState().saveError, 'Permission denied');
  } finally {
    stopRestored();
    if (original) Object.defineProperty(navigator, 'onLine', original); else delete navigator.onLine;
  }
});

test('an edit committed before a validation response arrives resumes with the corrected snapshot', async t => {
  const { store, saver } = await setup(t);
  const sent = []; let release;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    if (sent.length === 1) {
      await new Promise(resolve => { release = resolve; });
      return Response.json({ success: false, error: 'Invalid name' }, { status: 422 });
    }
    return ack(body);
  };
  store.setState({ nodes: [node('kept')], projectName: ' ' });
  const first = saver.save();
  await until(() => sent.length === 1);
  store.setState({ projectName: 'Corrected during request' });
  const second = saver.save();
  await wait(20);
  release();
  await Promise.all([first, second]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].baseVersion, 0);
  assert.equal(sent[1].snapshot.name, 'Corrected during request');
  assert.equal(store.getState().saveStatus, 'synced');
});

test('manual save joining an automatic backoff check still wakes the original operation', async t => {
  const { store, saver, calls } = await setup(t);
  const success = global.fetch;
  global.fetch = async () => { throw Error('temporary'); };
  store.setState({ nodes: [node('manual wake')] });
  await assert.rejects(saver.save(), /temporary/);
  global.fetch = success;
  await Promise.all([saver.flush(), saver.save()]);
  assert.equal(calls.length, 1);
  assert.equal(store.getState().saveStatus, 'synced');
});

test('manual saving after permission is restored retries the original operation before newer edits', async t => {
  const { store, saver } = await setup(t);
  const sent = []; let authorized = false;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    return authorized ? ack(body) : Response.json({ success: false, error: 'Permission denied' }, { status: 403 });
  };
  store.setState({ nodes: [node('before permission repair')] });
  await assert.rejects(saver.save(), /Permission denied/);
  store.setState({ nodes: [node('after permission repair')] });
  await saver.flush();
  assert.equal(sent.length, 1);
  authorized = true;
  await saver.save();
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(sent[2].snapshot.nodes[0].id, 'after permission repair');
  assert.equal(store.getState().saveStatus, 'synced');
});

test('a hanging canvas cannot prevent a second canvas from saving with its own identity', async t => {
  const { store, saver, repository } = await setup(t, 10000);
  let release;
  const sent = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    if (body.snapshot.nodes[0]?.id === 'A') await new Promise(resolve => { release = resolve; });
    return ack(body);
  };
  store.setState({ nodes: [node('A')] });
  const savingA = saver.flush();
  await until(() => sent.length === 1);
  const idA = sent[0].id;
  store.setState({ canvasSession: store.getState().canvasSession + 1, currentWorkflowId: null, serverVersion: 0, nodes: [], projectName: 'B' });
  store.setState({ nodes: [node('B')] });
  const savingB = saver.save();
  try {
    await until(() => sent.length === 2);
    await savingB;
    const idB = store.getState().currentWorkflowId;
    assert.notEqual(idA, idB);
    assert.equal((await repository.read(idB)).snapshot.nodes[0].id, 'B');
    assert.equal(store.getState().saveStatus, 'synced');
    release(); await savingA;
    assert.equal(store.getState().currentWorkflowId, idB);
    assert.equal(store.getState().nodes[0].id, 'B');
  } finally { release(); await Promise.allSettled([savingA, savingB]); }
});

test('restored canvases share two sync slots and a third progresses as soon as either finishes', async t => {
  const { saver, repository } = await setup(t, 10000);
  for (const id of ['one', 'two', 'three']) await repository.commit(id, {
    name: id, nodes: [node(id)], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  }, 0, 0);
  const sent = [], release = new Map();
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); sent.push(body.id);
    await new Promise(resolve => release.set(body.id, resolve));
    return ack(body);
  };
  const saving = saver.flush();
  try {
    await until(() => sent.length === 2);
    await wait(30);
    assert.equal(sent.length, 2);
    release.get(sent[0])();
    await until(() => sent.length === 3);
    for (const resolve of release.values()) resolve();
    await saving;
    assert.equal(new Set(sent).size, 3);
    for (const id of sent) assert.equal((await repository.read(id)).confirmedLocalVersion, 1);
  } finally { for (const resolve of release.values()) resolve(); await saving; }
});

test('returning to a canvas during its request restores the eventual error to that canvas only', async t => {
  const { store, saver } = await setup(t, 10000);
  let reject;
  global.fetch = async () => new Promise((resolve, fail) => { reject = fail; });
  store.setState({ nodes: [node('A')] });
  const saving = saver.flush();
  const result = assert.rejects(saving, /A failed/);
  await until(() => reject);
  const id = store.getState().currentWorkflowId;
  store.setState({ canvasSession: store.getState().canvasSession + 1, currentWorkflowId: null, serverVersion: 0, nodes: [] });
  await saver.open(id);
  reject(Error('A failed'));
  await result;
  assert.equal(store.getState().saveStatus, 'sync-error');
  assert.equal(store.getState().saveError, 'A failed');
});

test('a late acknowledgement cannot replace the loading state while another canvas opens', async t => {
  const { store, saver } = await setup(t, 10000);
  let finishSave, finishRead;
  global.fetch = async (url, options) => {
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      await new Promise(resolve => { finishSave = resolve; }); return ack(body);
    }
    await new Promise(resolve => { finishRead = resolve; });
    return Response.json({ success: true, data: { id: 'other', name: 'Other', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, version: 1 } });
  };
  store.setState({ nodes: [node('A')] });
  const saving = saver.flush();
  await until(() => finishSave);
  const opening = saver.open('other');
  await until(() => finishRead);
  finishSave(); await saving;
  try {
    assert.equal(store.getState().saveStatus, 'loading');
    assert.equal(store.getState().persistenceReady, false);
  } finally { finishRead(); await opening; }
});

for (const outcome of [200, 409, 410]) {
  test(`a late HTTP ${outcome} for the source canvas cannot invalidate a stale tab recovery copy`, async t => {
    const { store, saver, repository } = await setup(t, 10000);
    let release;
    let first = true;
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (first) {
        first = false;
        await new Promise(resolve => { release = resolve; });
        if (outcome !== 200) return Response.json({ success: false, error: 'source changed' }, { status: outcome });
      }
      return ack(body);
    };
    store.setState({ nodes: [node('original')] });
    const saving = saver.flush().catch(() => {});
    await until(() => release);
    const sourceId = store.getState().currentWorkflowId;
    await repository.commit(sourceId, { name: 'other tab', nodes: [node('other')], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, 0, 1);
    store.setState({ nodes: [node('stale local')] });
    const localSaving = saver.flush().catch(() => {});
    await until(() => store.getState().recovery?.kind === 'copy');
    const recoveryId = store.getState().currentWorkflowId;
    release(); await Promise.all([saving, localSaving]);
    assert.equal(store.getState().recovery.kind, 'copy');
    assert.equal(store.getState().saveStatus, 'recovery');
    await saver.recover('copy');
    await saver.save();
    assert.notEqual(store.getState().currentWorkflowId, sourceId);
    assert.notEqual(store.getState().currentWorkflowId, recoveryId);
    assert.equal(store.getState().nodes[0].data.text, 'stale local');
    assert.equal(store.getState().saveStatus, 'synced');
  });
}

test('undo before the first save persists an empty canvas with a redo branch', async t => {
  const { createCanvasHistory } = require('../lib/canvas/history.ts');
  const { store, saver, repository } = await setup(t, 1000, 2000, { history: true });
  const edit = createCanvasHistory(store.getState, update => store.setState(update));
  edit.change({ nodes: [node('created')] }, { record: true });
  edit.undo();
  await saver.save();
  const id = store.getState().currentWorkflowId;
  assert.ok(id);
  const saved = await repository.read(id);
  assert.equal(saved.snapshot.nodes.length, 0);
  assert.equal(saved.snapshot.history.redo.length, 1);
  store.setState({ history: saved.snapshot.history });
  edit.redo();
  assert.equal(store.getState().nodes[0].id, 'created');
});

test('paused old drafts do not repeatedly report autosave failure on a healthy canvas', async t => {
  const { store, saver, repository, errors, calls } = await setup(t);
  const snapshot = { name: 'Old draft', nodes: [node('old')], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repository.commit('old-conflict', snapshot, 0, 0);
  await repository.markRecovery('old-conflict', 'conflict');
  for (let i = 0; i < 3; i++) {
    store.setState({ nodes: [node(`healthy-${i}`)] });
    await saver.flush().catch(error => errors.push(error));
  }
  assert.deepEqual(errors.map(error => error.message), []);
  assert.equal(store.getState().saveStatus, 'synced');
  assert.equal(calls.length, 3);
  assert.equal((await repository.read('old-conflict')).snapshot.name, 'Old draft');
  assert.equal((await repository.all()).length, 2);
  await saver.open('old-conflict');
  await saver.flush();
  assert.equal(store.getState().saveStatus, 'recovery');
  await assert.rejects(saver.save(), /同步已暂停/);
});

test('remote refresh reads only the open canvas while still uploading other pending drafts', async t => {
  const { store, saver, repository } = await setup(t, 10, 50, { history: true });
  const snapshot = { name: 'Cached', nodes: [node('cached')], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  for (const id of ['previous', 'current', 'unopened']) await repository.adopt(id, snapshot, 1);
  const reads = [], writes = [];
  global.fetch = async (url, options) => {
    if (options?.method === 'PUT') { const body = JSON.parse(options.body); writes.push(body.id); return ack(body); }
    const id = url.split('/').at(-1); reads.push(id);
    return Response.json({ success: true, data: { id, ...snapshot, version: 1 } });
  };
  await saver.open('previous'); await saver.flush();
  await saver.open('current'); await saver.flush();
  await repository.commit('pending', snapshot, 0, 0);
  reads.length = 0; writes.length = 0;
  await saver.flush(); await saver.flush();
  assert.deepEqual(reads, ['current', 'current']);
  assert.deepEqual(writes, ['pending']);
  assert.equal(store.getState().currentWorkflowId, 'current');
});

test('an idle history-enabled canvas does not repeatedly fetch its full snapshot', async t => {
  const { saver, repository } = await setup(t, 10, 50, { history: true });
  const snapshot = { name: 'Idle', nodes: [node('one')], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repository.adopt('idle', snapshot, 1);
  let reads = 0;
  global.fetch = async () => { reads++; return Response.json({ success: true, data: { id: 'idle', ...snapshot, version: 1 } }); };
  await saver.open('idle'); await saver.flush();
  reads = 0;
  await wait(3200);
  assert.equal(reads, 0);
});
