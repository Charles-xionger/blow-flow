require('../scripts/register-typescript.cjs');
require('fake-indexeddb/auto');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

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

const { useCanvasStore: store } = load('store/useCanvasStore.ts');
const { expandPrompt, referenceImages, upstreamNodes } = load('lib/canvas/prompt.ts');

const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: id, ...data } });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target, sourceHandle: 'output', targetHandle: 'input' });
const connection = (source, target) => ({ source, target, sourceHandle: 'output', targetHandle: 'input' });
const promptOf = id => store.getState().nodes.find(candidate => candidate.id === id)?.data.prompt;
const removeEdge = (source, target) => store.getState().onEdgesChange([{ type: 'remove', id: `${source}-${target}` }]);

beforeEach(() => store.setState({ nodes: [], edges: [], selectedNodeIds: [] }));

test('connecting a text node appends its reference to the end of the prompt', () => {
  store.setState({ nodes: [node('image', 'textToImage', { prompt: '一朵花' }), node('scene', 'text', { prompt: '花园' })] });
  store.getState().onConnect(connection('scene', 'image'));
  assert.equal(store.getState().edges.length, 1);
  assert.deepEqual(promptOf('image'), [{ text: '一朵花' }, { ref: 'scene' }]);
  assert.equal(expandPrompt('image', store.getState()), '一朵花花园');
});

test('connecting reference material inserts nothing, because it is sent anyway', () => {
  store.setState({ nodes: [node('image', 'textToImage', { prompt: '花' }), node('hero', 'character')] });
  store.getState().onConnect(connection('hero', 'image'));
  assert.equal(store.getState().edges.length, 1);
  assert.equal(promptOf('image'), '花');
});

test('a refused connection leaves the prompt alone', () => {
  store.setState({ nodes: [node('image', 'textToImage', { prompt: '花' }), node('scene', 'text', { prompt: '花园' })], edges: [edge('scene', 'image')] });
  store.getState().onConnect(connection('scene', 'image'));
  assert.equal(promptOf('image'), '花');
});

test('quick-adding a node from a text node references it', () => {
  store.setState({ nodes: [node('scene', 'text', { prompt: '花园' })] });
  const [added] = store.getState().addMultipleConnectedNodes([{ type: 'textToImage', data: {} }], 'scene', { x: 0, y: 0 });
  assert.deepEqual(promptOf(added), [{ ref: 'scene' }]);
});

test('deleting the reference stops the text being sent and keeps the connection', () => {
  store.setState({ nodes: [node('image', 'textToImage', { prompt: '花' }), node('scene', 'text', { prompt: '花园' })] });
  store.getState().onConnect(connection('scene', 'image'));
  store.getState().updateNodeData('image', { prompt: [{ text: '花' }] });
  assert.equal(store.getState().edges.length, 1);
  assert.equal(expandPrompt('image', store.getState()), '花');
});

test('disconnecting turns the reference into text with the name at that moment, in one update', () => {
  store.setState({
    nodes: [node('image', 'textToImage', { prompt: [{ text: '一只' }, { ref: 'scene' }, { text: '里' }, { ref: 'hero' }] }),
      node('scene', 'text', { prompt: '花园', customTitle: '场景' }), node('hero', 'character', { customTitle: '小明' })],
    edges: [edge('scene', 'image'), edge('hero', 'image')],
  });
  const updates = [];
  const unsubscribe = store.subscribe(state => updates.push({ edges: state.edges.length, prompt: state.nodes[0].data.prompt }));
  removeEdge('scene', 'image');
  unsubscribe();
  assert.deepEqual(updates, [{ edges: 1, prompt: [{ text: '一只@场景里' }, { ref: 'hero' }] }]);
});

test('reconnecting leaves the converted text unchanged and only appends a new text reference', () => {
  store.setState({
    nodes: [node('image', 'textToImage', { prompt: [{ ref: 'scene' }, { text: ' ' }, { ref: 'hero' }] }),
      node('scene', 'text', { prompt: '花园', customTitle: '场景' }), node('hero', 'character', { customTitle: '小明' })],
    edges: [edge('scene', 'image'), edge('hero', 'image')],
  });
  removeEdge('hero', 'image');
  store.getState().onConnect(connection('hero', 'image'));
  assert.deepEqual(promptOf('image'), [{ ref: 'scene' }, { text: ' @小明' }]);
  removeEdge('scene', 'image');
  store.getState().onConnect(connection('scene', 'image'));
  assert.deepEqual(promptOf('image'), [{ text: '@场景 @小明' }, { ref: 'scene' }]);
});

test('other prompts and references to the same source elsewhere only change where the connection broke', () => {
  store.setState({
    nodes: [node('a', 'textToImage', { prompt: [{ ref: 'scene' }] }), node('b', 'textToImage', { prompt: [{ ref: 'scene' }] }), node('scene', 'text', { customTitle: '场景' })],
    edges: [edge('scene', 'a'), edge('scene', 'b')],
  });
  removeEdge('scene', 'a');
  assert.deepEqual(promptOf('a'), [{ text: '@场景' }]);
  assert.deepEqual(promptOf('b'), [{ ref: 'scene' }]);
});

const upstreamDeleted = {
  deleteNode: () => store.getState().deleteNode('scene'),
  deleteSelectedNodes: () => { store.setState({ selectedNodeIds: ['scene'] }); store.getState().deleteSelectedNodes(); },
  // Canvas delete keys send the node removal through xyflow, in either order with its edges.
  'node removal change': () => store.getState().onNodesChange([{ type: 'remove', id: 'scene' }]),
};
for (const [name, remove] of Object.entries(upstreamDeleted)) {
  test(`deleting the upstream node counts as disconnecting: ${name}`, () => {
    store.setState({
      nodes: [node('image', 'textToImage', { prompt: [{ text: '在' }, { ref: 'scene' }] }), node('scene', 'text', { prompt: '花园', customTitle: '场景' })],
      edges: [edge('scene', 'image')],
    });
    remove();
    assert.deepEqual(store.getState().nodes.map(candidate => candidate.id), ['image']);
    assert.deepEqual(store.getState().edges, []);
    assert.deepEqual(promptOf('image'), [{ text: '在@场景' }]);
  });
}

test('deleting a node whose edge removal arrives first still keeps the name', () => {
  store.setState({
    nodes: [node('image', 'textToImage', { prompt: [{ ref: 'scene' }] }), node('scene', 'text', { customTitle: '场景' })],
    edges: [edge('scene', 'image')],
  });
  removeEdge('scene', 'image');
  store.getState().onNodesChange([{ type: 'remove', id: 'scene' }]);
  assert.deepEqual(promptOf('image'), [{ text: '@场景' }]);
});

test('duplicating a node copies no connection, and the copy references nothing', () => {
  const prompt = [{ text: '在' }, { ref: 'scene' }, { text: '画' }, { ref: 'hero' }];
  store.setState({
    nodes: [node('image', 'textToImage', { prompt }), node('scene', 'text', { customTitle: '场景' }), node('hero', 'character', { customTitle: '小明' })],
    edges: [edge('scene', 'image'), edge('hero', 'image')],
  });
  store.getState().duplicateNode('image');
  const copy = store.getState().nodes.at(-1);
  assert.deepEqual(copy.data.prompt, [{ text: '在@场景画@小明' }]);
  assert.equal(store.getState().edges.length, 2);
  assert.ok(store.getState().edges.every(candidate => candidate.target === 'image'));
  assert.deepEqual(promptOf('image'), prompt);
});

test('duplicating keeps an old prompt string as it is', () => {
  store.setState({ nodes: [node('image', 'textToImage', { prompt: '一朵花' })] });
  store.getState().duplicateNode('image');
  assert.equal(store.getState().nodes.at(-1).data.prompt, '一朵花');
});

test('importing a graph keeps references pointing at the imported nodes', () => {
  store.getState().importGraph(
    [node('image', 'textToImage', { prompt: [{ text: '在' }, { ref: 'scene' }] }), node('scene', 'text', { prompt: '花园' })],
    [edge('scene', 'image')],
  );
  const { nodes } = store.getState();
  const image = nodes.find(candidate => candidate.data.type === 'textToImage');
  assert.equal(expandPrompt(image.id, store.getState()), '在花园');
});

test('an imported reference whose node is missing from the file becomes text', () => {
  store.getState().importGraph([node('image', 'textToImage', { prompt: [{ text: '在' }, { ref: 'gone' }] })], [edge('gone', 'image')]);
  assert.deepEqual(store.getState().nodes[0].data.prompt, [{ text: '在@节点' }]);
});

test('a recovery copy keeps references pointing at the copied nodes', () => {
  const { recoverySnapshot } = load('lib/canvas/recovery-copy.ts');
  const copy = recoverySnapshot({ name: '副本', viewport: { x: 0, y: 0, zoom: 1 }, edges: [edge('scene', 'image')],
    nodes: [node('image', 'textToImage', { prompt: [{ text: '在' }, { ref: 'scene' }] }), node('scene', 'text', { prompt: '花园' })] });
  const image = copy.nodes.find(candidate => candidate.data.type === 'textToImage');
  assert.equal(expandPrompt(image.id, copy), '在花园');
});

test('a node type still on the old shell gets no reference, so its text box and sending stay as they were', () => {
  store.setState({ nodes: [node('video', 'textToVideo', { prompt: '手写' }), node('scene', 'text', { prompt: '花园', customTitle: '场景' })] });
  store.getState().onConnect(connection('scene', 'video'));
  assert.equal(promptOf('video'), '手写');
  store.getState().onEdgesChange(store.getState().edges.map(candidate => ({ type: 'remove', id: candidate.id })));
  assert.equal(promptOf('video'), '手写');
});

test('selecting or dragging keeps node identity, so unrelated updates cost nothing', () => {
  store.setState({ nodes: [node('image', 'textToImage', { prompt: [{ ref: 'scene' }] }), node('scene', 'text')], edges: [edge('scene', 'image')] });
  const before = store.getState().nodes[0];
  store.getState().onEdgesChange([{ type: 'select', id: 'scene-image', selected: true }]);
  store.getState().onNodesChange([{ type: 'position', id: 'scene', position: { x: 5, y: 5 } }]);
  assert.equal(store.getState().nodes[0], before);
});

const image = (id, imageSrc) => node(id, 'originalImage', { imageSrc });

test('reordering upstream nodes renumbers references and reorders the material sent, together', () => {
  store.setState({
    nodes: [node('target', 'textToImage', { prompt: [{ ref: 'a' }, { text: '和' }, { ref: 'b' }] }), image('a', 'a.png'), image('b', 'b.png')],
    edges: [edge('a', 'target'), edge('b', 'target')],
  });
  assert.equal(expandPrompt('target', store.getState()), '图片1和图片2');
  store.getState().reorderUpstream('target', ['b', 'a']);
  assert.deepEqual(upstreamNodes('target', store.getState()).map(({ id, label }) => [id, label]), [['b', '图片1'], ['a', '图片2']]);
  assert.equal(expandPrompt('target', store.getState()), '图片2和图片1');
  assert.deepEqual(referenceImages('target', store.getState()), ['b.png', 'a.png']);
});

test('reordering one node leaves every other node and the edges themselves untouched', () => {
  const edges = [edge('a', 'other'), edge('a', 'target'), edge('b', 'other'), edge('b', 'target'), edge('t', 'target')];
  store.setState({ nodes: [node('target', 'textToImage'), node('other', 'textToImage'), image('a', 'a.png'), image('b', 'b.png'), node('t', 'text')], edges });
  store.getState().reorderUpstream('target', ['t', 'b', 'a']);
  assert.deepEqual(upstreamNodes('other', store.getState()).map(({ id }) => id), ['a', 'b']);
  assert.deepEqual(upstreamNodes('target', store.getState()).map(({ id }) => id), ['t', 'b', 'a']);
  assert.deepEqual(store.getState().edges.map(({ id }) => id).sort(), edges.map(({ id }) => id).sort());
});

test('text nodes can sit anywhere in the order without taking an image number', () => {
  store.setState({ nodes: [node('target', 'textToImage'), image('a', 'a.png'), node('t', 'text', { customTitle: '场景' }), image('b', 'b.png')], edges: [edge('a', 'target'), edge('t', 'target'), edge('b', 'target')] });
  store.getState().reorderUpstream('target', ['t', 'b', 'a']);
  assert.deepEqual(upstreamNodes('target', store.getState()).map(({ id, label }) => [id, label]), [['t', '场景'], ['b', '图片1'], ['a', '图片2']]);
});

test('reordering does not touch the prompt, so references stay references', () => {
  const prompt = [{ ref: 'a' }, { ref: 'b' }];
  store.setState({ nodes: [node('target', 'textToImage', { prompt }), image('a', 'a.png'), image('b', 'b.png')], edges: [edge('a', 'target'), edge('b', 'target')] });
  store.getState().reorderUpstream('target', ['b', 'a']);
  assert.deepEqual(promptOf('target'), prompt);
});
