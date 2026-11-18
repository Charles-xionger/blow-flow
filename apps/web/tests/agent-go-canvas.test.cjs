require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GoCanvasEditor, GoCanvasHTTP, GoRunCanvasHTTP, CanvasStoreError } = require('../lib/agent/go-canvas');

const initial = () => ({ name: '故事', nodes: [
  { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { type: 'text', label: 'A', prompt: '旧稿' } },
  { id: 'b', type: 'text', position: { x: 400, y: 0 }, data: { type: 'text', label: 'B', prompt: '原样' } },
], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });

test('Go-backed Agent edit recalculates against a newer unrelated canvas save', async () => {
  let snapshot = initial();
  let version = 1;
  let saves = 0;
  const store = {
    read: async () => ({ snapshot, version }),
    deleted: async () => [],
    save: async (_projectId, _requestId, baseVersion, next) => {
      saves++;
      if (saves === 1) {
        snapshot = { ...snapshot, nodes: snapshot.nodes.map(node => node.id === 'b' ? { ...node, data: { ...node.data, prompt: '人工新稿' } } : node) };
        version++;
      }
      if (baseVersion !== version) throw new CanvasStoreError(409, 'version_conflict');
      snapshot = next;
      version++;
      return { version };
    },
  };
  const result = await new GoCanvasEditor(store).apply('p', 'task:call', [{ kind: 'update', id: 'a', data: { prompt: '助手新稿' } }]);
  assert.equal(result.version, 3);
  assert.equal(saves, 2);
  assert.equal(snapshot.nodes[0].data.prompt, '助手新稿');
  assert.equal(snapshot.nodes[1].data.prompt, '人工新稿');
});

test('Go-backed Agent edit retries the identical request after a lost response', async () => {
  let snapshot = initial();
  let version = 1;
  let writes = 0;
  let request;
  const store = {
    read: async () => ({ snapshot, version }),
    deleted: async () => [],
    save: async (_projectId, requestId, baseVersion, next) => {
      if (!request) {
        request = { requestId, baseVersion, next };
        snapshot = next; version++; writes++;
        throw new Error('socket closed after commit');
      }
      assert.equal(requestId, request.requestId);
      assert.equal(baseVersion, request.baseVersion);
      assert.deepEqual(next, request.next);
      return { version };
    },
  };
  const result = await new GoCanvasEditor(store).apply('p', 'task:call', [{ kind: 'update', id: 'a', data: { prompt: '助手新稿' } }]);
  assert.equal(result.version, 2);
  assert.equal(writes, 1);
});

test('Go-backed Agent edit does not rebase a reused request identity', async () => {
  let reads = 0;
  const store = {
    read: async () => { reads++; return { snapshot: initial(), version: 1 }; },
    deleted: async () => [],
    save: async () => { throw new CanvasStoreError(409, 'request_conflict'); },
  };
  await assert.rejects(new GoCanvasEditor(store).apply('p', 'task:call', [{ kind: 'update', id: 'a', data: { prompt: '新稿' } }]), /request_conflict/);
  assert.equal(reads, 1);
});

test('Go-backed Agent edit refuses a previously deleted node identity', async () => {
  let saved = false;
  const store = {
    read: async () => ({ snapshot: initial(), version: 1 }),
    deleted: async () => ['reused'],
    save: async () => { saved = true; return { version: 2 }; },
  };
  await assert.rejects(new GoCanvasEditor(store).apply('p', 'task:call', [{ kind: 'create', node: {
    id: 'reused', type: 'text', position: { x: 800, y: 0 }, data: { type: 'text', label: '错误' },
  } }]), /Node identity was deleted/);
  assert.equal(saved, false);
});

test('Go canvas HTTP adapter carries owner credential and preserves API error codes', async () => {
  const calls = [];
  const client = new GoCanvasHTTP('http://api.test/', () => 'owner-token', async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/canvas')) return Response.json({ error: 'version_conflict' }, { status: 409 });
    if (url.endsWith('/deleted-nodes/check')) return Response.json({ deleted: ['old'] });
    return Response.json({ snapshot: initial(), version: 7 });
  });
  assert.equal((await client.read('p')).version, 7);
  assert.deepEqual(await client.deleted('p', ['old']), ['old']);
  await assert.rejects(client.save('p', 'r', 7, initial()), error => error instanceof CanvasStoreError && error.code === 'version_conflict');
  assert.ok(calls.every(call => call.init.headers.Authorization === 'Bearer owner-token'));
  assert.equal(calls[2].init.method, 'PUT');
});

test('run canvas adapter scopes every request to the run token and recovers a saved call', async () => {
  const calls = [];
  const operations = [{ kind: 'move', id: 'a', position: { x: 1, y: 2 } }];
  const client = new GoRunCanvasHTTP('http://api.test/', 'p', 'run-token', async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/receipt/agent%3Acall')) return Response.json({ version: 3, label: '助手编辑', skipped: ['missing'], operations, removedNodes: [] });
    if (url.endsWith('/deleted-nodes/check')) return Response.json({ deleted: ['old'] });
    if (url.endsWith('/canvas') && init.method === 'PUT') return Response.json({ version: 3 });
    return Response.json({ snapshot: initial(), version: 2 });
  });
  assert.equal((await client.read('p')).version, 2);
  assert.deepEqual(await client.deleted('p', ['old']), ['old']);
  assert.deepEqual(await client.receipt('p', 'agent:call'), { version: 3, label: '助手编辑', skipped: ['missing'], operations, removedNodes: [] });
  assert.deepEqual(await client.save('p', 'agent:call', 2, initial(), operations, []), { version: 3 });
  assert.ok(calls.every(call => call.init.headers.Authorization === 'Bearer run-token'));
  assert.ok(calls.every(call => !call.url.includes('/projects/')));
  assert.equal(JSON.parse(calls[3].init.body).callId, 'agent:call');
  await assert.rejects(client.read('wrong'), /Run project mismatch/);
  assert.equal(calls.length, 4);
});

test('a prior run receipt only replays matching operations', async () => {
  const saved = { version: 3, label: '助手编辑', skipped: [], operations: [{ kind: 'disconnect', id: 'edge-1' }], removedNodes: [] };
  const store = { receipt: async () => saved, read: async () => { throw new Error('should not read'); } };
  await assert.rejects(new GoCanvasEditor(store).apply('p', 'call', [{ kind: 'disconnect', id: 'edge-2' }]), /request_conflict/);
});
