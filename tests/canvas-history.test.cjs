require('../scripts/register-typescript.cjs');
require('fake-indexeddb/auto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('zustand/vanilla');
const { createCanvasHistory } = require('../lib/canvas/history.ts');
const { createCanvasRepository } = require('../lib/canvas/local-repository.ts');
const { canvasSnapshot } = require('../lib/canvas/snapshot.ts');

const initial = () => ({ nodes: [{ id: 'one', position: { x: 0, y: 0 }, data: { label: 'Text', prompt: [{ text: 'before' }] } }],
  edges: [], viewport: { x: 0, y: 0, zoom: 1 }, projectName: 'Project', canvasSession: 1 });
function editor(state = initial()) {
  const store = createStore(() => state);
  const edits = createCanvasHistory(store.getState, store.setState);
  const prompt = (text, id) => edits.change({ nodes: store.getState().nodes.map(n => ({ ...n, data: { ...n.data, prompt: [{ text }] } })) }, { record: true, id });
  return { store, edits, prompt };
}

test('an edit and its undo position survive a real repository reopen; redo restores saved content', async () => {
  const { store, edits, prompt } = editor();
  const name = 'history-' + crypto.randomUUID();
  const repository = createCanvasRepository(name);
  await repository.adopt('project', canvasSnapshot(store.getState()), 3);
  prompt('after', 'edit-1');
  edits.undo('undo-1');
  await repository.commit('project', canvasSnapshot(store.getState()), 3, 0);
  const draft = await createCanvasRepository(name).read('project');
  const resumed = editor({ ...initial(), ...draft.snapshot, projectName: draft.snapshot.name });
  assert.equal(resumed.store.getState().nodes[0].data.prompt[0].text, 'before');
  resumed.edits.redo('redo-1');
  assert.equal(resumed.store.getState().nodes[0].data.prompt[0].text, 'after');
  assert.equal(draft.serverVersion, 3);
});

test('drag and text boundaries merge, native undo to the starting text preserves the redo branch', () => {
  const { store, edits, prompt } = editor();
  prompt('first', 'first');
  edits.undo('undo');
  edits.begin('text');
  prompt('typing');
  prompt('before'); // Native editor undo before blur.
  edits.end('text');
  assert.equal(store.getState().history.undo.length, 0);
  assert.equal(store.getState().history.redo.length, 1);
  edits.redo();
  edits.begin('drag');
  for (let x = 1; x <= 20; x++) edits.change({ nodes: store.getState().nodes.map(n => ({ ...n, position: { x, y: 0 } })) }, { record: true });
  edits.end('drag');
  edits.undo();
  assert.deepEqual(store.getState().nodes[0].position, { x: 0, y: 0 });
  assert.equal(store.getState().nodes[0].data.prompt[0].text, 'first');
  edits.redo();
  assert.deepEqual(store.getState().nodes[0].position, { x: 20, y: 0 });
});

test('no-ops preserve redo, repeated operation IDs do not reapply, and unported changes establish a safe boundary', () => {
  const { store, edits, prompt } = editor();
  prompt('first', 'one');
  edits.undo('undo-one');
  prompt('first', 'one');
  assert.equal(store.getState().nodes[0].data.prompt[0].text, 'before');
  prompt('before', 'noop');
  assert.equal(store.getState().history.redo.length, 1);
  prompt('new', 'two');
  assert.equal(store.getState().history.redo.length, 0);
  assert.equal(store.getState().history.records.length, 2, 'abandoned records remain');
  edits.change({ nodes: store.getState().nodes.map(n => ({ ...n, data: { ...n.data, isLoading: true, generationStatus: 'running' } })) });
  edits.undo();
  assert.equal(store.getState().nodes[0].data.isLoading, true);
  assert.equal(store.getState().nodes[0].data.prompt[0].text, 'before');
  edits.change({ nodes: store.getState().nodes.map(n => ({ ...n, data: { ...n.data, imageSrc: '/new.png' } })) });
  edits.redo();
  assert.equal(store.getState().nodes[0].data.imageSrc, '/new.png');
  assert.equal(store.getState().nodes[0].data.prompt[0].text, 'before');
  assert.equal(store.getState().history.undo.length, 0);
  assert.match(store.getState().history.notice, /历史/);
});

test('the server atomically saves history with content and replay receipts, without rolling versions back', () => {
  process.env.DATABASE_PATH = ':memory:';
  const { saveWorkflow, getWorkflowById } = require('../lib/db/workflows.ts');
  const { closeDatabase } = require('../lib/db/index.ts');
  try {
    const { store, prompt, edits } = editor();
    prompt('server edit');
    const op = { id: 'server-history', requestId: 'save-1', baseVersion: 0, snapshot: canvasSnapshot(store.getState()) };
    const ack = saveWorkflow(op);
    edits.undo();
    saveWorkflow({ ...op, requestId: 'save-2', baseVersion: 1, snapshot: canvasSnapshot(store.getState()) });
    assert.deepEqual(saveWorkflow(op), ack);
    const remote = getWorkflowById(op.id);
    assert.equal(remote.version, 2);
    const resumed = editor({ ...initial(), ...remote, projectName: remote.name });
    resumed.edits.redo();
    assert.equal(resumed.store.getState().nodes[0].data.prompt[0].text, 'server edit');
  } finally { closeDatabase(); }
});

test('first-open checkpoint is durable and idempotent; projects have independent stacks', async () => {
  const repository = createCanvasRepository('checkpoints-' + crypto.randomUUID());
  await repository.adopt('a', canvasSnapshot(initial()), 7);
  const first = await repository.initializeHistory('a');
  const reopened = await repository.initializeHistory('a');
  assert.equal(reopened.localVersion, first.localVersion);
  assert.equal(reopened.snapshot.history.undo.length, 0);
  const a = editor({ ...initial(), ...reopened.snapshot });
  a.prompt('only A');
  await repository.commit('a', canvasSnapshot(a.store.getState()), 7, reopened.localVersion);
  await repository.adopt('b', canvasSnapshot(initial()), 2);
  const b = await repository.initializeHistory('b');
  assert.equal(b.snapshot.history.undo.length, 0);
  assert.equal((await repository.read('a')).snapshot.history.undo.length, 1);
});

test('unexpected content outside the operation boundary cannot be overwritten by old history', () => {
  const { store, edits, prompt } = editor();
  prompt('tracked');
  store.setState({ nodes: [{ ...store.getState().nodes[0], data: { label: 'Text', prompt: [{ text: 'external' }] } }] });
  edits.undo();
  assert.equal(store.getState().nodes[0].data.prompt[0].text, 'external');
  assert.equal(store.getState().history.undo.length, 0);
});

test('operation identity includes batched and no-op requests, even after refresh', async () => {
  const { store, edits, prompt } = editor();
  edits.begin('text');
  prompt('first', 'batch-1');
  prompt('second', 'batch-2');
  prompt('first', 'batch-1');
  assert.equal(store.getState().nodes[0].data.prompt[0].text, 'second');
  edits.end('text');
  prompt('second', 'noop');
  prompt('third', 'third');
  const repository = createCanvasRepository('receipts-' + crypto.randomUUID());
  await repository.commit('a', canvasSnapshot(store.getState()), 0);
  const saved = await repository.read('a');
  const reopened = editor({ ...initial(), ...saved.snapshot });
  reopened.prompt('second', 'noop');
  assert.equal(reopened.store.getState().nodes[0].data.prompt[0].text, 'third');
});

test('legacy server writers retain records behind a boundary and malformed history is rejected atomically', () => {
  process.env.DATABASE_PATH = ':memory:';
  const { saveWorkflow, getWorkflowById } = require('../lib/db/workflows.ts');
  const { closeDatabase } = require('../lib/db/index.ts');
  try {
    const { store, prompt } = editor();
    prompt('tracked');
    const snapshot = canvasSnapshot(store.getState());
    saveWorkflow({ id: 'legacy', requestId: 'a', baseVersion: 0, snapshot });
    const legacy = { ...snapshot, history: undefined, nodes: [{ ...snapshot.nodes[0], data: { label: 'external' } }] };
    saveWorkflow({ id: 'legacy', requestId: 'b', baseVersion: 1, snapshot: legacy });
    const saved = getWorkflowById('legacy');
    assert.equal(saved.history.records.length, 2);
    assert.equal(saved.history.undo.length, 0);
    assert.throws(() => saveWorkflow({ id: 'legacy', requestId: 'bad', baseVersion: 2,
      snapshot: { ...snapshot, history: { schema: 1 } } }), /history/i);
    assert.equal(getWorkflowById('legacy').version, 2);
    assert.equal(getWorkflowById('legacy').nodes[0].data.label, 'external');
  } finally { closeDatabase(); }
});

test('a single undo batch retains every internal edit in the durable operation log', async () => {
  const { store, edits, prompt } = editor();
  edits.begin('text');
  prompt('one', 'internal-1');
  prompt('two', 'internal-2');
  edits.end('text');
  assert.equal(store.getState().history.undo.length, 1);
  const repository = createCanvasRepository('audit-' + crypto.randomUUID());
  await repository.commit('a', canvasSnapshot(store.getState()), 0);
  const { snapshot } = await repository.read('a');
  assert.deepEqual(snapshot.history.operations.map(op => op.id), ['internal-1', 'internal-2']);
  assert.deepEqual(snapshot.history.operations[0].patches[0].value, [{ text: 'one' }]);
  assert.deepEqual(snapshot.history.operations[1].patches[0].value, [{ text: 'two' }]);
});

test('resize undo restores wrapper dimensions as well as content, without reverting live progress', () => {
  const { store, edits } = editor();
  edits.change({ nodes: [{ ...store.getState().nodes[0], style: { width: 300, height: 200 } }] });
  edits.change({ nodes: [{ ...store.getState().nodes[0], style: { width: 500, height: 400 }, width: 500, height: 400,
    measured: { width: 500, height: 400 } }] }, { record: true });
  edits.undo();
  assert.notEqual(store.getState().nodes[0].width, 500);
  assert.notEqual(store.getState().nodes[0].height, 400);
  assert.deepEqual(store.getState().nodes[0].style, { width: 300, height: 200 });
});

test('checkpoint installation does not send an implicit content write or change save versions', async () => {
  const repository = createCanvasRepository('baseline-' + crypto.randomUUID());
  const snapshot = canvasSnapshot(initial());
  await repository.adopt('a', snapshot, 5);
  const first = await repository.initializeHistory('a');
  assert.equal(first.localVersion, 0);
  assert.equal(await repository.pending('a'), undefined);
  const reopened = await repository.adopt('a', snapshot, 5);
  assert.deepEqual(reopened.snapshot.history, first.snapshot.history);
  assert.equal(reopened.localVersion, 0);
});
