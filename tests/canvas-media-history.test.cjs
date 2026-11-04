/* eslint-disable @typescript-eslint/no-require-imports -- Node test entry point. */
require('../scripts/register-typescript.cjs');
require('fake-indexeddb/auto');
const Module = require('node:module');
const path = require('node:path');
const resolveModule = Module._resolveFilename;
Module._resolveFilename = function (id, ...args) {
  return resolveModule.call(this, id.startsWith('@/') ? path.resolve(__dirname, '..', id.slice(2)) : id, ...args);
};
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useCanvasStore: store } = require('../store/useCanvasStore.ts');
const { NodeType: T } = require('../types/index.ts');
const { createCanvasRepository } = require('../lib/canvas/local-repository.ts');
const { canvasSnapshot } = require('../lib/canvas/snapshot.ts');
function start() {
  store.getState().clearWorkflow();
  store.setState({ persistenceReady: true });
  return store.getState();
}
const node = id => store.getState().nodes.find(n => n.id === id);
const connect = (source, target) => store.getState().onConnect({ source, target, sourceHandle: 'output', targetHandle: 'input' });

test('media replacement, removal and reference ordering replay durable content after reopen', async () => {
  const edit = start();
  const id = edit.addNode(T.ORIGINAL_IMAGE);
  edit.updateNodeData(id, { imageSrc: 'https://oss.test/one.png', isLoading: false, error: undefined });
  edit.updateNodeData(id, { imageSrc: 'https://oss.test/two.png' });
  edit.undo();
  assert.equal(node(id).data.imageSrc, 'https://oss.test/one.png');
  edit.redo();
  edit.updateNodeData(id, { imageSrc: undefined });
  edit.undo();
  assert.equal(node(id).data.imageSrc, 'https://oss.test/two.png');
  const video = edit.addNode(T.IMAGE_TO_VIDEO);
  edit.updateNodeData(video, { videoReferences: [{ id: 'one', kind: 'video', url: 'https://oss.test/ref.mp4', name: 'Video' }],
    videoReferenceOrder: ['one'], videoReferenceAudio: { one: true } });
  edit.updateNodeData(video, { videoReferenceAudio: { one: false } });
  const repo = createCanvasRepository('media-' + crypto.randomUUID());
  const draft = await repo.commit('media', canvasSnapshot(store.getState()), 0);
  edit.loadWorkflow({ id: draft.id, ...draft.snapshot });
  edit.undo();
  assert.equal(node(video).data.videoReferenceAudio.one, true);
  edit.redo();
  assert.equal(node(video).data.videoReferenceAudio.one, false);
  assert.equal(node(video).data.videoReferences[0].url, 'https://oss.test/ref.mp4');
  const steps = store.getState().history.undo.length;
  edit.removeVideoReference(video, 'one');
  assert.equal(node(video).data.videoReferences.length, 0);
  assert.equal(store.getState().history.undo.length, steps + 1);
  edit.undo();
  assert.deepEqual(node(video).data.videoReferenceOrder, ['one']);
  assert.equal(node(video).data.videoReferences.length, 1);
});

test('embedded legacy media is stored once in history and survives refresh and repeated replay', async () => {
  const edit = start();
  const inline = 'data:image/png;base64,' + 'a'.repeat(2000);
  edit.importGraph([{ id: 'legacy', type: T.ORIGINAL_IMAGE, position: { x: 0, y: 0 }, data: { type: T.ORIGINAL_IMAGE, label: 'Legacy', imageSrc: inline } }], []);
  const id = store.getState().nodes[0].id;
  edit.updateNodeData(id, { customTitle: 'One' });
  edit.updateNodeData(id, { imageSrc: 'https://oss.test/replacement.png' });
  edit.deleteNode(id);
  const history = JSON.stringify(store.getState().history);
  assert.equal(history.split(inline).length - 1, 1);
  const repo = createCanvasRepository('inline-' + crypto.randomUUID());
  const saved = await repo.commit('inline', canvasSnapshot(store.getState()), 0);
  edit.loadWorkflow({ id: saved.id, ...saved.snapshot });
  edit.undo(); edit.undo();
  assert.equal(node(id).data.imageSrc, inline);
  for (let i = 0; i < 3; i++) { edit.redo(); edit.undo(); assert.equal(node(id).data.imageSrc, inline); }
});

test('deleting a queued task then undoing restores content without resubmitting; new generation gets an independent execution identity', async () => {
  const { GenerationService } = require('../lib/generation/service.ts');
  const { defaultConfig } = require('../lib/generation/config.ts');
  const { generationHttp } = require('../lib/generation/http.ts');
  const { generationRecovery } = require('../lib/generation/recovery.ts');
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  const config = structuredClone(defaultConfig);
  process.env.RUNNINGHUB_API_KEY = 'test-key';
  config.connections[0].baseUrl = 'https://platform.test';
  const service = new GenerationService(db, config);
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const previousFetch = global.fetch;
  let creates = 0;
  global.localStorage = storage;
  global.fetch = async (url, options = {}) => {
    if (options.method === 'POST') creates++;
    const id = String(url).split('/')[4];
    return generationHttp(new Request('http://app.test' + url, options), service, 'tasks', id);
  };
  try {
    const edit = start();
    const id = edit.addNode(T.TEXT_TO_IMAGE);
    edit.updateNodeData(id, { imageSrc: 'https://oss.test/previous.png' });
    const recovery = () => generationRecovery(id, { read: () => node(id)?.data, update: data => edit.updateNodeData(id, data) }, storage);
    await recovery().start({ requestId: 'queued', nodeId: id, canvasId: 'draft', modelId: 'runninghub-krea2', input: { prompt: 'garden', width: 1920, height: 1080 } });
    const taskId = node(id).data.generationTaskId;
    edit.deleteNode(id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.get(taskId).status, 'cancelled');
    const repo = createCanvasRepository('cancelled-' + crypto.randomUUID());
    const saved = await repo.commit('cancelled', canvasSnapshot(store.getState()), 0);
    values.clear(); // Reopen on a client without the old browser's recovery records.
    edit.loadWorkflow({ id: saved.id, ...saved.snapshot });
    edit.undo();
    assert.equal(node(id).data.imageSrc, 'https://oss.test/previous.png');
    await recovery().recover();
    await recovery().poll(taskId);
    assert.equal(node(id).data.generationStatus, '已取消');
    assert.equal(creates, 1);
    edit.redo(); edit.undo();
    await recovery().recover();
    assert.equal(creates, 1);
    await recovery().start({ requestId: 'explicit-new', nodeId: id, canvasId: 'draft', modelId: 'runninghub-krea2', input: { prompt: 'new garden', width: 1920, height: 1080 } });
    assert.equal(creates, 2);
    assert.notEqual(node(id).data.generationTaskId, taskId);
    assert.equal(service.get(node(id).data.generationTaskId).status, 'queued');
    const { recoverySnapshot } = require('../lib/canvas/recovery-copy.ts');
    const copy = recoverySnapshot(canvasSnapshot(store.getState()));
    assert.notEqual(copy.nodes[0].id, id);
    assert.equal(copy.nodes[0].data.generationNodeId, undefined);
    assert.equal(copy.nodes[0].data.generationTaskId, undefined);
    assert.equal(copy.nodes[0].data.generationBindingVersion, undefined);
  } finally { global.fetch = previousFetch; delete global.localStorage; db.close(); }
});

test('late running results stay with the task after editing or offline deletion and undo', async () => {
  const { generationRecovery, retryGenerationDeletions } = require('../lib/generation/recovery.ts');
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const previousFetch = global.fetch;
  const deletions = [];
  global.localStorage = storage;
  global.fetch = async () => { throw Error('offline'); };
  const edit = start();
  const id = edit.addNode(T.TEXT_TO_IMAGE);
  edit.updateNodeData(id, { imageSrc: 'https://oss.test/before.png' });
  let submissions = 0;
  let task;
  const io = { create: async request => { submissions++; return task = { ...request, id: 'running-task', status: 'running', saveStatus: 'pending', artifacts: [], revision: 1 }; },
    get: async () => task, resume: async () => task, retrySave: async () => task };
  const recovery = () => generationRecovery(id, { read: () => node(id)?.data, update: data => edit.updateNodeData(id, data) }, storage, io);
  try {
    await recovery().start({ requestId: 'running', canvasId: 'draft', nodeId: id, modelId: 'runninghub-krea2', input: { prompt: 'garden', width: 1920, height: 1080 } });
    edit.updateNodeData(id, { prompt: [{ text: 'new intention' }] });
    task = { ...task, status: 'succeeded', saveStatus: 'saved', artifacts: ['https://oss.test/late.png'], revision: 2 };
    await recovery().poll(task.id);
    assert.equal(node(id).data.imageSrc, 'https://oss.test/before.png');
    assert.deepEqual(node(id).data.generationResultArtifacts, ['https://oss.test/late.png']);
    recovery().apply({ ...task, status: 'running', artifacts: [], revision: 1 });
    assert.equal(node(id).data.generationStatus, '已保存');
    edit.deleteNode(id);
    edit.undo();
    await recovery().recover();
    await recovery().poll(task.id);
    assert.equal(node(id).data.imageSrc, 'https://oss.test/before.png');
    const restoredIdentity = node(id).data.generationNodeId;
    global.fetch = async (url, options) => { deletions.push(JSON.parse(options.body)); return Response.json({ deleted: true }); };
    await retryGenerationDeletions(storage);
    assert.equal(deletions.at(-1).nodeId, id);
    assert.notEqual(deletions.at(-1).nodeId, restoredIdentity);
    edit.redo(); edit.undo();
    await recovery().poll(task.id);
    assert.equal(node(id).data.imageSrc, 'https://oss.test/before.png');
    assert.equal(submissions, 1);
  } finally { global.fetch = previousFetch; delete global.localStorage; }
});

test('late upload or legacy generation completion cannot overwrite edited, replaced or restored nodes', () => {
  const edit = start();
  const id = edit.addNode(T.ORIGINAL_IMAGE);
  const first = edit.beginMediaOperation(id);
  const second = edit.beginMediaOperation(id);
  assert.equal(first({ imageSrc: 'https://oss.test/old.png', isLoading: false }), false);
  assert.equal(second({ imageSrc: 'https://oss.test/new.png', isLoading: false }), true);
  const deleted = edit.beginMediaOperation(id);
  edit.deleteNode(id); edit.undo();
  assert.equal(deleted({ imageSrc: 'https://oss.test/late.png' }), false);
  assert.equal(node(id).data.imageSrc, 'https://oss.test/new.png');
  const edited = edit.beginMediaOperation(id);
  edit.updateNodeData(id, { customTitle: 'new intention' });
  assert.equal(edited({ imageSrc: 'https://oss.test/stale.png' }), false);
  assert.equal(node(id).data.imageSrc, 'https://oss.test/new.png');
});

test('a creation acknowledgement arriving after deletion and undo remains traceable without applying its result', async () => {
  const { generationRecovery } = require('../lib/generation/recovery.ts');
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const previousFetch = global.fetch;
  global.localStorage = storage;
  global.fetch = async () => Response.json({ deleted: true });
  try {
    const edit = start();
    const id = edit.addNode(T.TEXT_TO_IMAGE);
    edit.updateNodeData(id, { imageSrc: 'https://oss.test/before.png' });
    let resolve;
    const response = new Promise(done => { resolve = done; });
    const recovery = generationRecovery(id, { read: () => node(id)?.data, update: data => edit.updateNodeData(id, data) }, storage,
      { create: () => response });
    const request = { requestId: 'delayed', canvasId: 'draft', nodeId: id, modelId: 'runninghub-krea2', input: { prompt: 'garden', width: 1920, height: 1080 } };
    const started = recovery.start(request);
    edit.deleteNode(id); edit.undo();
    resolve({ ...request, id: 'accepted-before-deletion', status: 'succeeded', saveStatus: 'saved', artifacts: ['https://oss.test/late.png'], revision: 3 });
    await started;
    assert.equal(node(id).data.generationTaskId, 'accepted-before-deletion');
    assert.equal(node(id).data.imageSrc, 'https://oss.test/before.png');
    assert.deepEqual(node(id).data.generationResultArtifacts, ['https://oss.test/late.png']);
  } finally { global.fetch = previousFetch; delete global.localStorage; }
});

test('recovering a lost acknowledgement retains the original request binding across newer edits and reload', async () => {
  const { generationRecovery } = require('../lib/generation/recovery.ts');
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const edit = start();
  const id = edit.addNode(T.TEXT_TO_IMAGE);
  edit.updateNodeData(id, { imageSrc: 'https://oss.test/before.png' });
  const requests = [];
  const io = { create: async request => {
    requests.push(request);
    if (requests.length === 1) throw Error('acknowledgement lost');
    return { ...request, id: 'same-task', status: 'succeeded', saveStatus: 'saved', artifacts: ['https://oss.test/old-result.png'], revision: 2 };
  } };
  const recovery = () => generationRecovery(id, { read: () => node(id)?.data, update: data => edit.updateNodeData(id, data) }, storage, io);
  await recovery().start({ requestId: 'same-request', nodeId: id, canvasId: 'draft', modelId: 'runninghub-krea2', input: { prompt: 'old intention', width: 1920, height: 1080 } });
  edit.updateNodeData(id, { imageSrc: 'https://oss.test/user-replacement.png' });
  const repo = createCanvasRepository('pending-' + crypto.randomUUID());
  const saved = await repo.commit('pending', canvasSnapshot(store.getState()), 0);
  edit.loadWorkflow({ id: saved.id, ...saved.snapshot });
  await recovery().recover();
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(node(id).data.imageSrc, 'https://oss.test/user-replacement.png');
  assert.deepEqual(node(id).data.generationResultArtifacts, ['https://oss.test/old-result.png']);
  values.clear();
  edit.loadWorkflow({ id: saved.id, ...saved.snapshot });
  await recovery().recover();
  assert.deepEqual(requests[2], requests[0]);
  assert.equal(node(id).data.imageSrc, 'https://oss.test/user-replacement.png');
});

test('reference connection order and disconnection invalidate old results, including after undo', async () => {
  const { generationRecovery } = require('../lib/generation/recovery.ts');
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const edit = start();
  const a = edit.addNode(T.CHARACTER);
  const b = edit.addNode(T.CHARACTER);
  const id = edit.addNode(T.TEXT_TO_IMAGE);
  connect(a, id); connect(b, id);
  edit.updateNodeData(id, { imageSrc: 'https://oss.test/current.png' });
  let task;
  const recovery = generationRecovery(id, { read: () => node(id)?.data, update: data => edit.updateNodeData(id, data) }, storage,
    { create: async request => task = { ...request, id: request.requestId, status: 'running', saveStatus: 'pending', artifacts: [], revision: 0 } });
  const begin = requestId => recovery.start({ requestId, nodeId: id, canvasId: 'draft', modelId: 'runninghub-krea2', input: { prompt: 'references', width: 1920, height: 1080 } });
  await begin('order');
  edit.reorderUpstream(id, [b, a]);
  recovery.apply({ ...task, status: 'succeeded', saveStatus: 'saved', artifacts: ['https://oss.test/old-order.png'], revision: 1 });
  assert.equal(node(id).data.imageSrc, 'https://oss.test/current.png');
  await begin('disconnect');
  edit.onEdgesChange([{ type: 'remove', id: store.getState().edges.find(edge => edge.source === a).id }]);
  edit.undo();
  recovery.apply({ ...task, status: 'succeeded', saveStatus: 'saved', artifacts: ['https://oss.test/old-connection.png'], revision: 1 });
  assert.equal(node(id).data.imageSrc, 'https://oss.test/current.png');
});
