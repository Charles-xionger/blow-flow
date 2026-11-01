require('../scripts/register-typescript.cjs');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_PATH = ':memory:';
const { getDatabase, closeDatabase } = require('../lib/db/index.ts');
const { saveWorkflow, getWorkflowById, getAllWorkflows, deleteWorkflow } = require('../lib/db/workflows.ts');
after(closeDatabase);
const operation = (id, extra = {}) => ({ id, requestId: 'first', baseVersion: 0,
  snapshot: { name: '画布', nodes: [{ id: 'node', position: { x: 1, y: 2 }, data: {} }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, ...extra });

test('stable canvas identity, replay and version conflicts preserve accepted content', () => {
  const first = operation('stable');
  const ack = saveWorkflow(first);
  assert.deepEqual(ack, { id: 'stable', requestId: 'first', version: 1 });
  assert.deepEqual(saveWorkflow(first), ack);
  assert.equal(getAllWorkflows().filter(w => w.id === 'stable').length, 1);
  assert.throws(() => saveWorkflow({ ...first, snapshot: { ...first.snapshot, name: 'changed' } }), /request/i);
  assert.throws(() => saveWorkflow({ ...first, requestId: 'stale' }), /conflict/i);
  saveWorkflow({ ...first, requestId: 'second', baseVersion: 1, snapshot: { ...first.snapshot, nodes: [] } });
  assert.deepEqual(saveWorkflow(first), ack, 'replay is checked before current version');
  assert.equal(getWorkflowById('stable').version, 2);
  assert.deepEqual(getWorkflowById('stable').nodes, []);
});

test('receipt failure rolls back both content and version, and the same request can retry', () => {
  const first = operation('atomic');
  saveWorkflow(first);
  const update = { ...first, requestId: 'update', baseVersion: 1, snapshot: { ...first.snapshot, name: 'updated' } };
  const db = getDatabase();
  db.exec("CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON canvas_save_receipts WHEN NEW.request_id = 'update' BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
  assert.throws(() => saveWorkflow(update), /disk failure/);
  assert.equal(getWorkflowById('atomic').name, '画布');
  assert.equal(getWorkflowById('atomic').version, 1);
  db.exec('DROP TRIGGER fail_receipt');
  assert.equal(saveWorkflow(update).version, 2);
  assert.equal(getWorkflowById('atomic').name, 'updated');
});

test('legacy unversioned writes and malformed snapshots are rejected', () => {
  assert.throws(() => saveWorkflow({ name: 'old', nodes: [], edges: [] }), /required/);
  assert.throws(() => saveWorkflow(operation('bad', { baseVersion: -1 })), /required/);
  assert.equal(getWorkflowById('bad'), null);
});

test('deletion retains identity and rejects offline writes, creates and successful receipt replays', () => {
  const first = operation('deleted');
  saveWorkflow(first);
  assert.equal(deleteWorkflow('deleted'), true);
  assert.equal(getWorkflowById('deleted'), null);
  assert.ok(!getAllWorkflows().some(canvas => canvas.id === 'deleted'));
  for (const request of [first, { ...first, requestId: 'offline', baseVersion: 1 }, { ...first, requestId: 'create' }]) {
    assert.throws(() => saveWorkflow(request), error => error.status === 410);
  }
  assert.equal(getWorkflowById('deleted'), null);
  assert.equal(saveWorkflow({ ...first, id: 'new-copy', requestId: 'copy' }).version, 1);
});

test('a failed delete transaction leaves the original canvas writable at its original version', () => {
  const first = operation('delete-atomic');
  saveWorkflow(first);
  const db = getDatabase();
  db.exec("CREATE TEMP TRIGGER fail_delete BEFORE UPDATE OF deleted_at ON workflows WHEN OLD.id = 'delete-atomic' BEGIN SELECT RAISE(ABORT, 'delete disk failure'); END");
  try {
    assert.throws(() => deleteWorkflow(first.id), /delete disk failure/);
    assert.equal(getWorkflowById(first.id).version, 1);
    assert.equal(getWorkflowById(first.id).name, '画布');
  } finally { db.exec('DROP TRIGGER fail_delete'); }
  assert.equal(saveWorkflow({ ...first, baseVersion: 1, requestId: 'after-delete-failed' }).version, 2);
});

test('historical database upgrades preserve canvases and can be opened repeatedly', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'canvas-upgrade-'));
  closeDatabase();
  process.env.DATABASE_PATH = path.join(dir, 'old.db');
  const legacy = new (require('better-sqlite3'))(process.env.DATABASE_PATH);
  legacy.exec('CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  legacy.prepare('INSERT INTO workflows VALUES (?, ?, ?, ?, ?)').run('old', '历史画布', JSON.stringify({ nodes: operation('old').snapshot.nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } }), 10, 20);
  legacy.close();
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal(getWorkflowById('old').version, 1);
      assert.equal(getWorkflowById('old').name, '历史画布');
      assert.equal(getWorkflowById('old').nodes[0].id, 'node');
      assert.equal(getWorkflowById('old').createdAt, 10);
      closeDatabase();
    }
  } finally { closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); }
});
