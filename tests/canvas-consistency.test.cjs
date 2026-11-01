require('../scripts/register-typescript.cjs');
require('fake-indexeddb/auto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCanvasRepository } = require('../lib/canvas/local-repository.ts');
const snapshot = name => ({ name, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });

test('stale tab commits preserve newer draft and retain losing edits as a recovery copy', async () => {
  const name = 'cas-' + crypto.randomUUID();
  const a = createCanvasRepository(name), b = createCanvasRepository(name);
  await a.adopt('shared', snapshot('original'), 1);
  await a.commit('shared', snapshot('newer'), 1, 0);
  const losing = await b.commit('shared', snapshot('stale'), 1, 0);
  assert.equal((await a.read('shared')).snapshot.name, 'newer');
  assert.notEqual(losing.id, 'shared');
  assert.equal(losing.snapshot.name, 'stale');
  assert.equal(losing.recovery.kind, 'copy');
  assert.equal((await a.recoveries()).length, 1);
  assert.equal(await a.pending(losing.id), undefined);
});

test('late success and failure cannot clear a newer conflict or deletion', async () => {
  const repo = createCanvasRepository('late-' + crypto.randomUUID());
  for (const kind of ['conflict', 'deleted']) {
    await repo.commit(kind, snapshot('local'), 0, 0);
    const sent = await repo.pending(kind);
    await repo.markRecovery(kind, kind, sent.requestId);
    await repo.acknowledge(sent, { id: kind, requestId: sent.requestId, version: 1 });
    await repo.retry(sent, { attempts: 1, nextAttemptAt: 0 });
    assert.equal((await repo.read(kind)).recovery.kind, kind);
    assert.equal((await repo.read(kind)).confirmedLocalVersion, 0);
    assert.equal((await repo.pending(kind)).requestId, sent.requestId);
  }
});

test('adopting changed remote content invalidates stale local tabs and preserves backup on recovery', async () => {
  const repo = createCanvasRepository('adopt-' + crypto.randomUUID());
  await repo.adopt('canvas', snapshot('original'), 1);
  await repo.adopt('canvas', snapshot('remote changed'), 2);
  const stale = await repo.commit('canvas', snapshot('stale editor'), 1, 0);
  assert.equal(stale.recovery.kind, 'copy');
  assert.equal((await repo.read('canvas')).snapshot.name, 'remote changed');
  await repo.commit('canvas', snapshot('local changed'), 2, 1);
  await repo.markRecovery('canvas', 'conflict');
  await repo.adoptRemote('canvas', snapshot('server chosen'), 3);
  assert.equal((await repo.read('canvas')).snapshot.name, 'server chosen');
  assert.ok((await repo.recoveries()).some(copy => copy.snapshot.name === 'local changed'));
});

test('a late remote read cannot downgrade confirmed content or erase a deletion', async () => {
  const repo = createCanvasRepository('late-read-' + crypto.randomUUID());
  await repo.adopt('canvas', snapshot('v1'), 1);
  await repo.adopt('canvas', snapshot('v2'), 2);
  let current = await repo.adopt('canvas', snapshot('v1'), 1);
  assert.equal(current.snapshot.name, 'v2');
  assert.equal(current.serverVersion, 2);
  await repo.markRecovery('canvas', 'deleted');
  current = await repo.adopt('canvas', snapshot('v2'), 2);
  assert.equal(current.recovery.kind, 'deleted');
  assert.equal((await repo.recoveries())[0].id, 'canvas');
});

test('a recovery choice using a late server read cannot erase deletion or replace a newer baseline', async () => {
  const repo = createCanvasRepository('late-choice-' + crypto.randomUUID());
  await repo.adopt('canvas', snapshot('v2'), 2);
  await repo.markRecovery('canvas', 'conflict');
  await assert.rejects(repo.adoptRemote('canvas', snapshot('v1'), 1), /过期/);
  assert.equal((await repo.read('canvas')).snapshot.name, 'v2');
  await repo.markRecovery('canvas', 'deleted');
  await assert.rejects(repo.adoptRemote('canvas', snapshot('v2'), 2), /删除/);
  assert.equal((await repo.read('canvas')).recovery.kind, 'deleted');
  assert.equal((await repo.recoveries()).length, 1);
});
