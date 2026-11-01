require('../scripts/register-typescript.cjs');
require('fake-indexeddb/auto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCanvasRepository } = require('../lib/canvas/local-repository.ts');
const snapshot = { name: '旧草稿', nodes: [{ id: 'old-node', type: 'text', position: { x: 20, y: 30 }, data: { prompt: '保留文字' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
const legacy = (id = null, content = snapshot) => JSON.stringify({ version: 0, state: { currentWorkflowId: id, projectName: content.name, nodes: content.nodes, edges: content.edges, viewport: content.viewport, isDarkMode: false } });
const repository = () => createCanvasRepository('migration-' + crypto.randomUUID());

test('legacy import retains identity and atomically records completion without overwriting later edits', async () => {
  const repo = repository();
  await repo.migrateLegacy(legacy('existing'));
  const imported = await repo.read();
  assert.equal(imported.id, 'existing');
  assert.deepEqual(imported.snapshot, snapshot);
  assert.equal(imported.recovery.kind, 'unverified');
  assert.equal(await repo.pending('existing'), undefined);
  await repo.commit('existing', { ...snapshot, name: '后来的编辑' }, 0);
  await repo.migrateLegacy(legacy('existing'));
  assert.equal((await repo.read()).snapshot.name, '后来的编辑');
  assert.equal(await repo.pending('existing'), undefined);
});

test('existing IndexedDB content wins and the distinct legacy content remains an accessible recovery copy', async () => {
  const repo = repository();
  await repo.commit('same-id', { ...snapshot, name: 'IndexedDB 编辑' }, 3);
  await repo.migrateLegacy(legacy('same-id'));
  assert.equal((await repo.read('same-id')).snapshot.name, 'IndexedDB 编辑');
  const [copy] = await repo.recoveries();
  assert.equal(copy.snapshot.name, '旧草稿');
  assert.notEqual(copy.id, 'same-id');
  assert.notEqual(copy.snapshot.nodes[0].id, 'old-node');
  assert.equal(await repo.pending(copy.id), undefined);
  await repo.migrateLegacy(legacy('same-id'));
  assert.equal((await repo.recoveries()).length, 1);
});

test('matching remote content establishes a baseline, while a mismatch requires a choice and preserves local content', async () => {
  const repo = repository();
  await repo.migrateLegacy(legacy('remote'));
  let draft = await repo.reconcile('remote', snapshot, 7);
  assert.equal(draft.recovery, undefined);
  assert.equal(draft.serverVersion, 7);
  assert.equal(draft.localVersion, draft.confirmedLocalVersion);
  await repo.commit('remote', { ...snapshot, name: '已核对后的修改' }, 0);
  assert.equal((await repo.pending('remote')).baseVersion, 7);

  const conflict = repository();
  await conflict.migrateLegacy(legacy('remote'));
  draft = await conflict.reconcile('remote', { ...snapshot, name: '远端编辑' }, 9);
  assert.equal(draft.recovery.kind, 'conflict');
  assert.equal(draft.snapshot.name, '旧草稿');
  assert.equal(await conflict.pending('remote'), undefined);
  await conflict.adoptRemote('remote', { ...snapshot, name: '远端编辑' }, 9);
  assert.equal((await conflict.read('remote')).snapshot.name, '远端编辑');
  assert.equal((await conflict.recoveries())[0].snapshot.name, '旧草稿');
});

test('identical drafts in independent browsers get independent IDs, stable after restart', async () => {
  const first = repository();
  const second = repository();
  await first.migrateLegacy(legacy());
  await second.migrateLegacy(legacy());
  const id = (await first.read()).id;
  assert.notEqual(id, (await second.read()).id);
  await first.migrateLegacy(legacy());
  assert.equal((await first.read()).id, id);
});

test('an untouched empty legacy canvas does not create a server project', async () => {
  const repo = repository();
  await repo.migrateLegacy(legacy(null, { ...snapshot, nodes: [] }));
  const draft = await repo.read();
  assert.deepEqual(draft.snapshot.nodes, []);
  assert.equal(await repo.pending(draft.id), undefined);
});

test('adopting a server-only pending generation node retains read-only recovery until an explicit start', async () => {
  const repo = repository();
  await repo.migrateLegacy(legacy('remote'));
  const remote = { ...snapshot, nodes: [{ ...snapshot.nodes[0], id: 'server-only-node' }] };
  const adopted = await repo.adoptRemote('remote', remote, 2);
  assert.ok(adopted.generationRecoveryReadOnly.includes('server-only-node'));
  await repo.allowGenerationRecovery('remote', 'server-only-node');
  assert.ok(!(await repo.read('remote')).generationRecoveryReadOnly.includes('server-only-node'));
});

test('read-only legacy generation recovery exposes a stopped request for explicit confirmation without submitting it', async () => {
  const { generationRecovery } = require('../lib/generation/recovery.ts');
  const pending = { requestId: 'legacy-request', nodeId: 'node', canvasId: 'old', modelId: 'model' };
  const node = { pendingGeneration: pending, isLoading: true };
  const raw = JSON.stringify({ request: pending });
  const storage = { getItem: () => raw, setItem: () => assert.fail('must retain independent recovery records'), removeItem: () => assert.fail() };
  const recovery = generationRecovery('node', { read: () => node, update: value => Object.assign(node, value) }, storage,
    { create: () => assert.fail('must not submit a new request') });
  await recovery.recover({ submitPending: false });
  assert.equal(node.isLoading, false);
  assert.equal(node.pendingGeneration.requestId, 'legacy-request');
  assert.match(node.generationStatus, /待核实/);
});
