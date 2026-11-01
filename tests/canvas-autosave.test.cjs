require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('zustand/vanilla');
const { createCanvasAutosave } = require('../lib/canvas/autosave.ts');

function setup(t) {
  const calls = [];
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    return Response.json({ success: true, data: { id: 'created' } });
  };
  const store = createStore(set => ({
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    projectName: 'Canvas', currentWorkflowId: null, canvasSession: 0,
    setCurrentWorkflowId: id => set({ currentWorkflowId: id }),
  }));
  const errors = [];
  const saver = createCanvasAutosave(store, e => errors.push(e), 10);
  const stop = saver.start();
  t.after(async () => { stop(); await saver.flush(); global.fetch = previousFetch; });
  return { store, saver, calls, errors };
}
const node = id => ({ id, position: { x: 0, y: 0 }, data: { text: id } });

test('autosave creates once, updates edits, and persists deleting the last node', async t => {
  const { store, saver, calls } = setup(t);
  store.setState({ nodes: [node('one')] });
  await saver.flush();
  store.setState({ nodes: [node('one'), node('two')], projectName: 'Edited' });
  await saver.save();
  store.setState({ nodes: [] });
  await saver.flush();
  assert.deepEqual(calls.map(c => c.method), ['POST', 'PUT', 'PUT']);
  assert.equal(calls[1].url, '/api/workflow/created');
  assert.equal(calls[1].body.nodes.length, 2);
  assert.equal(calls[1].body.name, 'Edited');
  assert.deepEqual(calls[2].body.nodes, []);
});

test('edits and manual save during creation serialize behind one POST', async t => {
  const { store, saver } = setup(t);
  const calls = [];
  let release;
  global.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    if (options.method === 'POST') await new Promise(resolve => { release = resolve; });
    return Response.json({ success: true, data: { id: 'created' } });
  };
  store.setState({ nodes: [node('one')] });
  const first = saver.flush();
  store.setState({ nodes: [node('one'), node('two')] });
  const manual = saver.save();
  release();
  await Promise.all([first, manual]);
  assert.deepEqual(calls.map(c => c.method), ['POST', 'PUT']);
  assert.equal(calls[1].body.nodes.length, 2);
});

test('switching canvases keeps pending edits and late creation IDs on their original canvas', async t => {
  const { store, saver } = setup(t);
  const calls = [];
  let release;
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (options.method === 'POST') await new Promise(resolve => { release = resolve; });
    return Response.json({ success: true, data: { id: 'old-canvas' } });
  };
  store.setState({ nodes: [node('old')] });
  const saving = saver.flush();
  store.setState({ nodes: [node('loaded')], currentWorkflowId: 'other', canvasSession: 1 });
  store.setState({ nodes: [node('loaded'), node('new')] });
  release();
  await saving;
  assert.equal(store.getState().currentWorkflowId, 'other');
  assert.equal(calls[1].url, '/api/workflow/other');
  assert.deepEqual(calls[1].body.nodes.map(n => n.id), ['loaded', 'new']);
});

test('failed saves remain pending and retry the latest snapshot', async t => {
  const { store, saver, calls } = setup(t);
  const success = global.fetch;
  global.fetch = async () => Response.json({ success: false, error: 'offline' }, { status: 503 });
  store.setState({ nodes: [node('one')] });
  await assert.rejects(saver.flush(), /offline/);
  store.setState({ nodes: [node('one'), node('two')] });
  global.fetch = success;
  await saver.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.nodes.length, 2);
});

test('loading a canvas or changing unrelated UI state does not write it back', async t => {
  const { store, saver, calls } = setup(t);
  store.setState({ nodes: [node('loaded')], currentWorkflowId: 'existing', canvasSession: 1 });
  store.setState({ isDarkMode: true });
  await saver.flush();
  assert.equal(calls.length, 0);
});
