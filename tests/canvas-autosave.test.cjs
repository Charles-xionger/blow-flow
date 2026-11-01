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
    await assert.rejects(saver.flush(), /blocked/);
    stop();
    const restoredStore = createStore(() => ({ ...store.getState(), persistenceReady: false }));
    const restored = createCanvasAutosave(restoredStore, () => {}, 10, repository);
    const stopRestored = restored.start();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    try {
      await restored.open(); await drain();
      t.mock.timers.tick(60_000); await drain();
      assert.equal(sent.length, 1);
      assert.equal(restoredStore.getState().saveStatus, 'sync-error');
      assert.match(restoredStore.getState().saveError, /blocked/);
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
  await assert.rejects(saver.flush(), /Permission denied/);
  assert.equal(sent.length, 1);
  authorized = true;
  await saver.save();
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(sent[2].snapshot.nodes[0].id, 'after permission repair');
  assert.equal(store.getState().saveStatus, 'synced');
});
