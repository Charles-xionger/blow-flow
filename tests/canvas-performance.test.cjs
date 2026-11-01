require('../scripts/register-typescript.cjs');
require('fake-indexeddb/auto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
// Load the small TypeScript units without requiring a browser or a Next build.
const cache = new Map();
function load(relative) {
  const filename = path.resolve(__dirname, '..', relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const baseRequire = mod.require.bind(mod);
  mod.require = (id) => id.startsWith('@/')
    ? load(id === '@/types' ? 'types/index.ts' : id.slice(2) + '.ts')
    : baseRequire(id);
  cache.set(filename, mod);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, filename);
  return mod.exports;
}
const { createDraftStorage } = load('lib/canvas/draft-storage.ts');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('draft serializes once after a burst and never during active interaction', async () => {
  const writes = [];
  let serializations = 0;
  const draft = createDraftStorage(() => ({ setItem: (key, value) => writes.push(value) }), assert.fail, 10, 30);
  draft.beginInteraction('drag');
  for (let i = 0; i < 100; i++) draft.storage.setItem('canvas-storage', {
    state: { value: i, toJSON() { serializations++; return { value: i }; } }, version: 0,
  });
  await wait(50);
  assert.equal(serializations, 0);
  assert.equal(writes.length, 0);
  draft.endInteraction('drag');
  await wait(30);
  assert.equal(serializations, 1);
  assert.equal(JSON.parse(writes[0]).state.value, 99);
});

test('unchanged snapshot skips saving; flush and retry preserve latest value', () => {
  let fail = true;
  let errors = 0;
  const writes = [];
  const draft = createDraftStorage(() => ({ setItem: (key, value) => {
    if (fail) throw Error('quota');
    writes.push(value);
  } }), () => errors++);
  draft.storage.setItem('canvas-storage', { state: { value: 1 } });
  draft.flush();
  assert.equal(errors, 1);
  fail = false;
  draft.flush();
  draft.storage.setItem('canvas-storage', { state: { value: 1 } });
  draft.flush();
  assert.equal(writes.length, 1);
});

test('legacy envelope loads; remove cancels scheduled writes', async () => {
  let writes = 0;
  const legacy = { state: { value: 7 }, version: 0 };
  const draft = createDraftStorage(() => ({ getItem: () => JSON.stringify(legacy), setItem: () => writes++, removeItem() {} }), assert.fail, 10);
  assert.deepEqual(draft.storage.getItem('canvas-storage'), legacy);
  draft.storage.setItem('canvas-storage', { state: { value: 8 } });
  draft.storage.removeItem('canvas-storage');
  await wait(30);
  assert.equal(writes, 0);
});

test('batch creation emits one complete graph; dragging preserves selection and unrelated data', () => {
  const { useCanvasStore: store, canvasDraftStorage } = load('store/useCanvasStore.ts');
  const { NodeType } = load('types/index.ts');
  const source = store.getState().addNode(NodeType.TEXT);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  const ids = store.getState().addMultipleConnectedNodes(
    Array.from({ length: 20 }, () => ({ type: NodeType.TEXT_TO_IMAGE, data: {} })), source, { x: 400, y: 0 },
  );
  assert.equal(notifications, 1);
  assert.equal(store.getState().edges.length, 20);
  assert.equal(new Set(ids).size, 20);
  store.getState().onNodesChange([{ id: source, type: 'select', selected: true }]);
  const before = store.getState();
  store.getState().onNodesChange([{ id: source, type: 'position', position: { x: 20, y: 30 }, dragging: true }]);
  assert.equal(store.getState().selectedNodeIds, before.selectedNodeIds);
  assert.equal(store.getState().nodes[1], before.nodes[1]);
  assert.equal(store.getState().nodes[0].data, before.nodes[0].data);
  unsubscribe();
  canvasDraftStorage.flush();
});

test('group bounds follow measured image previews rather than legacy fixed dimensions', () => {
  const { useCanvasStore: store } = load('store/useCanvasStore.ts');
  const { NodeType } = load('types/index.ts');
  const id = store.getState().addNode(NodeType.TEXT_TO_IMAGE, { x: 20, y: 40 });
  store.getState().onNodesChange([{ id, type: 'dimensions', dimensions: { width: 180, height: 320 } }]);
  store.getState().groupNodes([id]);
  const child = store.getState().nodes.find(node => node.id === id);
  const group = store.getState().nodes.find(node => node.id === child.parentId);
  assert.deepEqual(group.style, { width: 260, height: 400 });
  assert.deepEqual(child.position, { x: 40, y: 40 });
});

test('rendering image previews preserves unrelated node references and stored style metadata', () => {
  const { canvasRenderNodes } = load('lib/canvas/render-nodes.ts');
  const { NodeType } = load('types/index.ts');
  const a = { id: 'a', type: NodeType.TEXT_TO_IMAGE, position: { x: 0, y: 0 }, data: {},
    parentId: 'group', extent: 'parent', style: { width: 320, height: 240, opacity: 0.8 } };
  const b = { ...a, id: 'b' };
  const group = { id: 'group', type: NodeType.GROUP, position: { x: 0, y: 0 }, data: {}, style: { width: 900, height: 800 } };
  const before = canvasRenderNodes([a, b, group]);
  const after = canvasRenderNodes([{ ...a, position: { x: 30, y: 50 } }, b, group]);
  assert.equal(after[1], before[1]);
  assert.equal(after[2], group);
  assert.notEqual(after[0], before[0]);
  assert.equal(after[0].style.width, undefined);
  assert.equal(after[0].style.height, undefined);
  assert.equal(after[0].style.opacity, 0.8);
  assert.equal(after[0].parentId, 'group');
  assert.equal(after[0].extent, 'parent');
  assert.deepEqual(a.style, { width: 320, height: 240, opacity: 0.8 });
});

test('connection policy rejects invalid ports, types, duplicates and cycles', () => {
  const { isValidCanvasConnection: valid } = load('lib/canvas/connections.ts');
  const { NodeType: T } = load('types/index.ts');
  const nodes = [T.TEXT, T.TEXT_TO_IMAGE, T.IMAGE_TO_IMAGE, T.TEXT, T.ORIGINAL_IMAGE].map((type, i) => ({ id: String(i), data: { type } }));
  const connection = (source, target, extra = {}) => ({ source, target, sourceHandle: 'output', targetHandle: 'input', ...extra });
  assert.equal(valid(connection('0', '1'), nodes, []), true);
  assert.equal(valid(connection('1', '2', { targetHandle: null }), nodes, []), true);
  assert.equal(valid(connection('0', '0'), nodes, []), false);
  assert.equal(valid(connection('missing', '1'), nodes, []), false);
  assert.equal(valid(connection('0', '2'), nodes, []), false);
  assert.equal(valid(connection('1', '4'), nodes, []), false);
  assert.equal(valid(connection('0', '1', { sourceHandle: 'input' }), nodes, []), false);
  assert.equal(valid(connection('0', '1'), nodes, [connection('0', '1')]), false);
  assert.equal(valid(connection('0', '3'), nodes, [connection('3', '0')]), false);
});

test('store refuses invalid connections even without canvas preview validation', () => {
  const { useCanvasStore: store, canvasDraftStorage } = load('store/useCanvasStore.ts');
  const id = store.getState().nodes[0].id;
  const before = store.getState().edges;
  store.getState().onConnect({ source: id, target: id, sourceHandle: 'output', targetHandle: 'input' });
  assert.equal(store.getState().edges, before);
  canvasDraftStorage.flush();
});

test('video reference connections are enabled for H3 without changing legacy model input types', () => {
  const { isValidCanvasConnection: valid } = load('lib/canvas/connections.ts');
  const { NodeType: T } = load('types/index.ts');
  const nodes = [{ id: 'video', data: { type: T.TEXT_TO_VIDEO } },
    { id: 'target', data: { type: T.IMAGE_TO_VIDEO, model: 'runninghub-h3' } }];
  const connection = { source: 'video', target: 'target', sourceHandle: 'output', targetHandle: 'input' };
  assert.equal(valid(connection, nodes, []), true);
  nodes[1].data.model = 'sora-2';
  assert.equal(valid(connection, nodes, []), false);
});

test('switching canvases does not cancel; explicit deletion persists cancellation and duplicating does not copy task identity', async () => {
  const { useCanvasStore: store, canvasDraftStorage } = load('store/useCanvasStore.ts');
  const { NodeType } = load('types/index.ts');
  const values = new Map(); const calls = [];
  const previousStorage = global.localStorage; const previousFetch = global.fetch;
  global.localStorage = { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  global.fetch = async (url, options) => { calls.push({ url, options }); return Response.json({ deleted: true }); };
  try {
    store.getState().setCurrentWorkflowId('one');
    const id = store.getState().addNode(NodeType.TEXT_TO_IMAGE);
    const pending = { requestId: 'lost', canvasId: 'one', nodeId: id, modelId: 'runninghub-krea2',
      input: { prompt: 'garden', width: 1920, height: 1080 } };
    store.getState().updateNodeData(id, { pendingGeneration: pending, isLoading: true });
    const original = store.getState().nodes.find(n => n.id === id);
    store.getState().duplicateNode(id);
    const copy = store.getState().nodes.at(-1);
    assert.equal(copy.data.pendingGeneration, undefined);
    assert.equal(copy.data.isLoading, false);
    store.getState().loadWorkflow({ id: 'two', name: 'Other', nodes: [], edges: [] });
    assert.equal(calls.length, 0);
    store.getState().loadWorkflow({ id: 'one', name: 'Original', nodes: [original], edges: [] });
    store.getState().deleteNode(id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, 'DELETE');
    assert.deepEqual(JSON.parse(calls[0].options.body), { canvasId: 'one', nodeId: id });
    assert.equal(store.getState().nodes.length, 0);
    assert.equal(JSON.parse(values.get('generation-node-v1:' + id)).deleted, true);
    canvasDraftStorage.flush();
  } finally { global.fetch = previousFetch; global.localStorage = previousStorage; }
});

test('imported canvas copies have independent task identities while preserving connections and groups', () => {
  const { useCanvasStore: store, canvasDraftStorage } = load('store/useCanvasStore.ts');
  const { NodeType } = load('types/index.ts');
  store.getState().importGraph([
    { id: 'group', type: NodeType.GROUP, position: { x: 0, y: 0 }, data: { type: NodeType.GROUP } },
    { id: 'source', type: NodeType.TEXT, position: { x: 1, y: 1 }, parentId: 'group', data: { type: NodeType.TEXT } },
    { id: 'image', type: NodeType.TEXT_TO_IMAGE, position: { x: 2, y: 2 }, data: {
      type: NodeType.TEXT_TO_IMAGE, generationTaskId: 'old-task', isLoading: true, imageSrc: 'saved.png',
    } },
  ], [{ id: 'edge', source: 'source', target: 'image' }]);
  const { nodes, edges } = store.getState();
  assert.ok(nodes.every(n => !['group', 'source', 'image'].includes(n.id)));
  assert.equal(nodes[1].parentId, nodes[0].id);
  assert.equal(nodes[2].data.generationTaskId, undefined);
  assert.equal(nodes[2].data.isLoading, false);
  assert.equal(nodes[2].data.imageSrc, 'saved.png');
  assert.equal(edges[0].source, nodes[1].id);
  assert.equal(edges[0].target, nodes[2].id);
  canvasDraftStorage.flush();
});

test('adding a node automatically persists the canvas to SQLite without manual save', async () => {
  process.env.DATABASE_PATH = ':memory:';
  const db = require('../lib/db/workflows.ts');
  const { useCanvasStore: store, canvasDraftStorage, canvasAutosave } = load('store/useCanvasStore.ts');
  const { NodeType } = load('types/index.ts');
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    const data = JSON.parse(options.body);
    return Response.json({ success: true, data: db.saveWorkflow(data) });
  };
  store.getState().clearWorkflow();
  const stop = canvasAutosave.start();
  await canvasAutosave.open();
  try {
    const id = store.getState().addNode(NodeType.TEXT);
    await wait(800);
    const saved = db.getAllWorkflows().find(w => w.nodes.some(n => n.id === id));
    assert.ok(saved, 'new node must be in the database without clicking Save');
    assert.equal(store.getState().currentWorkflowId, saved.id);
  } finally {
    stop(); await canvasAutosave.flush(); global.fetch = previousFetch;
  }
});
