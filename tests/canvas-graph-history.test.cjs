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

test('node creation and deletion with references undo as complete graph operations', () => {
  const edit = start();
  const source = edit.addNode(T.TEXT);
  edit.updateNodeData(source, { customTitle: 'Source' });
  const target = edit.addNode(T.TEXT_TO_IMAGE);
  connect(source, target);
  assert.deepEqual(node(target).data.prompt, [{ ref: source }]);
  const steps = store.getState().history.undo.length;
  edit.deleteNode(source);
  assert.equal(store.getState().history.undo.length, steps + 1);
  assert.deepEqual(node(target).data.prompt, [{ text: '@Source' }]);
  assert.equal(store.getState().edges.length, 0);
  edit.undo();
  assert.ok(node(source));
  assert.deepEqual(node(target).data.prompt, [{ ref: source }]);
  assert.equal(store.getState().edges.length, 1);
  edit.redo();
  assert.equal(node(source), undefined);
  edit.undo();
  edit.undo(); // connection
  assert.equal(store.getState().edges.length, 0);
  edit.undo(); // target creation
  assert.equal(node(target), undefined);
});

test('connected creation, upstream ordering and multi-selection deletion are atomic across reopen', async () => {
  const edit = start();
  const source = edit.addNode(T.TEXT);
  const baseline = store.getState().history.undo.length;
  const ids = edit.addMultipleConnectedNodes([{ type: T.TEXT, data: {} }, { type: T.TEXT_TO_IMAGE, data: {} }], source, { x: 500, y: 50 });
  assert.equal(store.getState().history.undo.length, baseline + 1);
  edit.undo();
  assert.deepEqual(store.getState().nodes.map(n => n.id), [source]);
  edit.redo();
  assert.deepEqual(store.getState().nodes.slice(1).map(n => n.id), ids);
  connect(ids[0], ids[1]);
  edit.reorderUpstream(ids[1], [ids[0], source]);
  assert.deepEqual(store.getState().edges.filter(e => e.target === ids[1]).map(e => e.source), [ids[0], source]);
  edit.undo();
  assert.deepEqual(store.getState().edges.filter(e => e.target === ids[1]).map(e => e.source), [source, ids[0]]);
  edit.redo();
  edit.setSelectedNodeIds([source, ids[0]]);
  const beforeDelete = store.getState().history.undo.length;
  edit.deleteSelectedNodes();
  assert.equal(store.getState().history.undo.length, beforeDelete + 1);
  assert.equal(store.getState().nodes.length, 1);
  const repo = createCanvasRepository('graph-' + crypto.randomUUID());
  const draft = await repo.commit('graph', canvasSnapshot(store.getState()), 4);
  edit.loadWorkflow({ id: draft.id, ...draft.snapshot, version: draft.serverVersion });
  edit.undo();
  assert.deepEqual(store.getState().nodes.map(n => n.id), [source, ...ids]);
  assert.equal(store.getState().edges.length, 3);
  assert.deepEqual(node(ids[1]).data.prompt, [{ ref: source }, { ref: ids[0] }]);
  edit.redo();
  assert.equal(store.getState().nodes.length, 1);
  const stable = canvasSnapshot(store.getState());
  assert.deepEqual(edit.addMultipleConnectedNodes([{ type: T.TEXT, data: {} }], 'missing', { x: 0, y: 0 }), []);
  assert.deepEqual(canvasSnapshot(store.getState()), stable);
});

test('nested grouping, ungrouping and deleting a group preserve global layout through repeated replay', () => {
  const edit = start();
  const a = edit.addNode(T.TEXT, { x: 100, y: 120 });
  const b = edit.addNode(T.TEXT, { x: 400, y: 200 });
  edit.groupNodes([a, b]);
  const group = node(a).parentId;
  assert.deepEqual(node(group).position, { x: 60, y: 80 });
  edit.groupNodes([group, a]); // Selecting an ancestor and descendant moves the subtree once.
  const outer = node(group).parentId;
  assert.equal(node(a).parentId, group);
  edit.onNodesChange([{ id: outer, type: 'position', position: { x: 220, y: 340 }, dragging: false }]);
  edit.ungroupNodes(group);
  assert.equal(node(a).parentId, outer);
  assert.deepEqual(node(a).position, { x: 80, y: 80 });
  edit.ungroupNodes(outer);
  assert.deepEqual(node(a).position, { x: 300, y: 420 });
  assert.deepEqual(node(b).position, { x: 600, y: 500 });
  for (let i = 0; i < 3; i++) {
    edit.undo(); edit.undo();
    assert.equal(node(a).parentId, group);
    assert.equal(node(group).parentId, outer);
    edit.redo(); edit.redo();
    assert.deepEqual(node(a).position, { x: 300, y: 420 });
    assert.equal(node(a).parentId, undefined);
  }
  edit.undo(); edit.undo();
  edit.deleteNode(outer);
  assert.equal(store.getState().nodes.length, 0);
  edit.undo();
  assert.equal(store.getState().nodes.length, 4);
  assert.equal(node(a).parentId, group);
});

test('copy and import replay saved identities, remap references and drop task links across refresh', async () => {
  const edit = start();
  const source = edit.addNode(T.TEXT);
  edit.updateNodeData(source, { customTitle: 'Source' });
  const target = edit.addNode(T.TEXT_TO_IMAGE);
  connect(source, target);
  edit.duplicateNode(target);
  const copy = store.getState().nodes.at(-1);
  assert.deepEqual(copy.data.prompt, [{ text: '@Source' }]);
  edit.undo();
  assert.equal(node(copy.id), undefined);
  edit.redo();
  assert.ok(node(copy.id));
  edit.importGraph([
    { id: 'a', type: T.TEXT, position: { x: 50, y: 60 }, data: { type: T.TEXT, label: 'A' } },
    { id: 'b', type: T.TEXT_TO_IMAGE, position: { x: 400, y: 60 }, data: { type: T.TEXT_TO_IMAGE, label: 'B',
      prompt: [{ ref: 'a' }], generationTaskId: 'old-task', pendingGeneration: { requestId: 'old-request' }, isLoading: true } },
  ], [{ id: 'ab', source: 'a', target: 'b' }], { name: 'Imported' });
  assert.equal(store.getState().projectName, 'Imported');
  const imported = canvasSnapshot(store.getState());
  const [a, b] = imported.nodes;
  assert.notEqual(a.id, 'a');
  assert.deepEqual(b.data.prompt, [{ ref: a.id }]);
  assert.equal(b.data.generationTaskId, undefined);
  assert.equal(b.data.pendingGeneration, undefined);
  assert.equal(b.data.isLoading, false);
  const repo = createCanvasRepository('import-' + crypto.randomUUID());
  const draft = await repo.commit('imported', imported, 0);
  edit.loadWorkflow({ id: draft.id, ...draft.snapshot });
  edit.undo();
  assert.equal(store.getState().nodes.length, 0);
  edit.redo();
  assert.deepEqual(store.getState().nodes.map(n => n.id), [a.id, b.id]);
  assert.deepEqual(store.getState().edges, imported.edges.map(e => ({ ...e, selected: undefined })));
  assert.deepEqual(node(b.id).data.prompt, [{ ref: a.id }]);
});

test('structural callbacks delete a subtree in one step and reject invalid imports without changing session', () => {
  const edit = start();
  const a = edit.addNode(T.TEXT);
  const b = edit.addNode(T.TEXT_TO_IMAGE);
  connect(a, b);
  edit.groupNodes([a, b]);
  const group = node(a).parentId;
  const steps = store.getState().history.undo.length;
  edit.onNodesChange([{ type: 'remove', id: group }]);
  assert.equal(store.getState().nodes.length, 0);
  assert.equal(store.getState().edges.length, 0);
  assert.equal(store.getState().history.undo.length, steps + 1);
  edit.undo();
  assert.equal(store.getState().nodes.length, 3);
  const before = canvasSnapshot(store.getState());
  const session = store.getState().canvasSession;
  assert.throws(() => edit.importGraph([node(a), node(a)], []));
  assert.throws(() => edit.importGraph([node(a)], [])); // Missing parent.
  assert.deepEqual(canvasSnapshot(store.getState()), before);
  assert.equal(store.getState().canvasSession, session);
  connect(b, a); // Invalid reverse type/cycle.
  edit.reorderUpstream(b, ['missing']);
  edit.deleteElements(['missing']);
  assert.deepEqual(canvasSnapshot(store.getState()), before);
  edit.redo();
  assert.equal(store.getState().nodes.length, 0);
});

test('failed restoration of a deletion tombstone leaves the graph and history intact', () => {
  const edit = start();
  const id = edit.addNode(T.TEXT);
  edit.deleteNode(id);
  const before = canvasSnapshot(store.getState());
  global.localStorage = { getItem: key => key === 'generation-node-v1:' + id ? JSON.stringify({ deleted: true }) : null };
  try {
    edit.undo();
    assert.equal(node(id), undefined);
    assert.deepEqual(canvasSnapshot(store.getState()), before);
  } finally { delete global.localStorage; }
});

test('task deletion failure leaves the graph intact; redo reapplies cancellation without new generation', async () => {
  const edit = start();
  const id = edit.addNode(T.TEXT_TO_IMAGE);
  const pendingGeneration = { requestId: 'pending', canvasId: 'draft', nodeId: id, modelId: 'runninghub-krea2', input: { prompt: 'test', width: 1920, height: 1080 } };
  edit.updateNodeData(id, { pendingGeneration, isLoading: true });
  const values = new Map();
  let fail = true;
  const previousFetch = global.fetch;
  let calls = 0;
  global.localStorage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { if (fail) throw Error('quota'); values.set(key, value); }, removeItem: key => values.delete(key) };
  global.fetch = async () => { calls++; return Response.json({ deleted: true }); };
  try {
    const before = canvasSnapshot(store.getState());
    assert.throws(() => edit.deleteNode(id), /取消请求/);
    assert.deepEqual(canvasSnapshot(store.getState()), before);
    fail = false;
    edit.duplicateNode(id);
    const copy = store.getState().nodes.at(-1);
    assert.equal(copy.data.pendingGeneration, undefined);
    edit.undo();
    assert.equal(node(copy.id), undefined);
    edit.redo();
    assert.equal(node(copy.id).data.pendingGeneration, undefined);
    edit.deleteNode(id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    edit.undo();
    assert.ok(node(id));
    edit.redo();
    assert.equal(node(id), undefined);
    assert.equal(calls, 2);
  } finally { delete global.localStorage; global.fetch = previousFetch; }
});

test('switching models detaches incompatible inputs atomically and undo restores model and connections', () => {
  const edit = start();
  const source = edit.addNode(T.TEXT_TO_VIDEO);
  const target = edit.addNode(T.IMAGE_TO_VIDEO);
  edit.updateNodeData(target, { model: 'runninghub-h3', usesGenerationTasks: true });
  connect(source, target);
  edit.updateNodeData(target, { prompt: [{ ref: source }] });
  const steps = store.getState().history.undo.length;
  edit.updateNodeData(target, { model: 'Sora 2', usesGenerationTasks: false });
  assert.equal(store.getState().edges.length, 0);
  assert.equal(store.getState().history.undo.length, steps + 1);
  assert.equal(node(target).data.prompt[0].ref, undefined);
  edit.undo();
  assert.equal(node(target).data.model, 'runninghub-h3');
  assert.equal(store.getState().edges.length, 1);
  assert.deepEqual(node(target).data.prompt, [{ ref: source }]);
  edit.redo();
  assert.equal(store.getState().edges.length, 0);
  const added = edit.addNode(T.TEXT);
  edit.undo();
  assert.equal(node(added), undefined);
});
