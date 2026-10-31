require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const { GenerationService } = require('../lib/generation/service.ts');
const { GenerationWorker } = require('../lib/generation/worker.ts');
const { defaultConfig } = require('../lib/generation/config.ts');

async function setup(t) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const sockets = [];
  server.on('connection', socket => sockets.push(socket));
  const db = new Database(':memory:');
  const config = structuredClone(defaultConfig);
  config.connections[0].baseUrl = 'http://127.0.0.1';
  process.env.RUNNINGHUB_API_KEY = 'test-key';
  const service = new GenerationService(db, config);
  let now = Date.now(), finished = false, submitCount = 0, queryCount = 0, saveCount = 0;
  const io = {
    now: () => now,
    fetch: async (url, init) => {
      if (url.endsWith('/create')) { submitCount++; return Response.json({ code: 0, data: { taskId: '123' } }); }
      queryCount++;
      assert.equal(JSON.parse(init.body).taskId, '123');
      return Response.json(finished ? { code: 0, data: [{ nodeId: '103', fileUrl: 'https://platform.test/image.png' }] } :
        { code: 804, data: { netWssUrl: `ws://127.0.0.1:${server.address().port}/?token=secret` } });
    },
    save: async () => { saveCount++; return 'https://oss.test/image.png'; },
  };
  const workers = [];
  const worker = () => { const w = new GenerationWorker(service, io); workers.push(w); return w; };
  t.after(async () => {
    for (const w of workers) w.close?.();
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const task = service.create({ requestId: 'a', modelId: 'runninghub-krea2', input: { prompt: 'garden', width: 1920, height: 1080 }, canvasId: 'c', nodeId: 'n' });
  return { service, task, worker, sockets, advance: ms => { now += ms; }, finish: () => { finished = true; }, counts: () => ({ submitCount, queryCount, saveCount }) };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  assert.fail('Expected WebSocket activity did not arrive');
}

test('RunningHub completion notification queries and saves the original task before its polling deadline', async t => {
  const f = await setup(t);
  const worker = f.worker();
  await worker.tick(); await worker.tick();
  await until(() => f.sockets.length === 1);
  assert.equal(f.service.get(f.task.id).status, 'running');
  f.finish();
  f.sockets[0].send(JSON.stringify({ type: 'execution_success', data: { prompt_id: '123' } }));
  await delay(30);
  await worker.tick();
  assert.equal(f.service.get(f.task.id).saveStatus, 'saved');
  assert.deepEqual(f.service.get(f.task.id).artifacts, ['https://oss.test/image.png']);
  assert.deepEqual(f.counts(), { submitCount: 1, queryCount: 2, saveCount: 1 });
});

test('missing completion events fall back to HTTP and a restarted worker never resubmits', async t => {
  const f = await setup(t);
  let worker = f.worker();
  await worker.tick(); await worker.tick();
  await until(() => f.sockets.length === 1);
  f.advance(5000); await worker.tick();
  const before = f.counts().queryCount;
  f.advance(29_000); assert.equal(await worker.tick(), false);
  assert.equal(f.counts().queryCount, before);
  worker.close();
  worker = f.worker();
  f.finish(); f.advance(1000); await worker.tick();
  assert.equal(f.service.get(f.task.id).saveStatus, 'saved');
  assert.equal(f.counts().submitCount, 1);
});

test('socket failure wakes HTTP recovery and duplicate completion hints save only once', async t => {
  const f = await setup(t);
  const worker = f.worker();
  await worker.tick(); await worker.tick();
  await until(() => f.sockets.length === 1);
  f.sockets[0].terminate(); await delay(30);
  await worker.tick();
  await until(() => f.sockets.length === 2);
  f.finish();
  const message = JSON.stringify({ type: 'execution_success', data: {} });
  f.sockets[1].send(message); f.sockets[1].send(message);
  await delay(30); await worker.tick(); await worker.tick();
  assert.equal(f.service.get(f.task.id).saveStatus, 'saved');
  assert.equal(f.counts().submitCount, 1);
  assert.equal(f.counts().saveCount, 1);
});

test('failed WebSocket handshakes retain the HTTP polling interval rather than busy-looping', async t => {
  const { createServer } = require('node:http');
  const server = createServer((req, res) => { res.writeHead(403); res.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const db = new Database(':memory:'); t.after(() => db.close());
  const config = structuredClone(defaultConfig); config.connections[0].baseUrl = 'http://127.0.0.1';
  process.env.RUNNINGHUB_API_KEY = 'test-key';
  let now = Date.now(), queries = 0;
  const service = new GenerationService(db, config);
  service.create({ requestId: 'bad-socket', modelId: 'runninghub-krea2', input: { prompt: 'garden', width: 512, height: 512 }, canvasId: 'c', nodeId: 'n' });
  const worker = new GenerationWorker(service, {
    now: () => now,
    fetch: async url => {
      if (url.endsWith('/create')) return Response.json({ code: 0, data: { taskId: '123' } });
      queries++;
      return Response.json({ code: 804, data: { netWssUrl: `ws://127.0.0.1:${server.address().port}` } });
    }, save: async () => '',
  });
  t.after(() => worker.close());
  await worker.tick(); await worker.tick(); await delay(30);
  assert.equal(await worker.tick(), false);
  assert.equal(queries, 1);
  now += 5000; await worker.tick();
  assert.equal(queries, 2);
});
