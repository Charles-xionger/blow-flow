require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { GenerationService } = require('../lib/generation/service.ts');
const { GenerationWorker } = require('../lib/generation/worker.ts');
const { defaultConfig } = require('../lib/generation/config.ts');
const { generationEvents } = require('../lib/generation/events.ts');

function setup(t) {
  const db = new Database(':memory:');
  const config = structuredClone(defaultConfig);
  config.connections[0].baseUrl = 'https://platform.test';
  process.env.RUNNINGHUB_API_KEY = 'secret-test-key';
  const service = new GenerationService(db, config);
  t.after(() => db.close());
  return { db, config, service };
}
const request = (id) => ({ requestId: id, modelId: 'runninghub-krea2', input: { prompt: 'a garden', width: 1920, height: 1080 }, canvasId: 'canvas', nodeId: id });
const subscribe = (service, ids, signal) => generationEvents(new Request('http://local/api/generation/events', {
  method: 'POST', body: JSON.stringify({ taskIds: ids }), signal,
}), service);
async function read(reader) {
  const { value, done } = await reader.read();
  assert.equal(done, false);
  const text = new TextDecoder().decode(value);
  return { event: text.match(/event: (.*)/)[1], data: JSON.parse(text.match(/data: (.*)/)[1]) };
}

test('SSE synchronizes multiple tasks then delivers confirmed OSS images without platform secrets', async t => {
  const { service } = setup(t);
  const a = service.create(request('a'));
  const b = service.create(request('b'));
  const abort = new AbortController();
  const response = await subscribe(service, [a.id, b.id], abort.signal);
  t.after(() => abort.abort());
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const snapshot = await read(reader);
  assert.equal(snapshot.event, 'snapshot');
  assert.deepEqual(snapshot.data.map(t => t.id).sort(), [a.id, b.id].sort());
  const worker = new GenerationWorker(service, {
    fetch: async url => Response.json(url.endsWith('/create') ? { code: 0, data: { taskId: '123' } } :
      { code: 0, data: [{ nodeId: '103', fileUrl: 'https://platform.test/private.png' }] }),
    save: async () => 'https://oss.test/final.png',
  });
  await worker.tick();
  await worker.tick();
  const event = await read(reader);
  assert.equal(event.event, 'tasks');
  assert.equal(event.data[0].status, 'succeeded');
  assert.deepEqual(event.data[0].artifacts, ['https://oss.test/final.png']);
  assert.ok(event.data[0].revision > a.revision);
  assert.doesNotMatch(JSON.stringify(event), /secret-test-key|private.png|platform_id/);
  abort.abort();
  assert.equal((await reader.read()).done, true);
});

test('a separate worker process publishes a saved result through shared SQLite within one second', async t => {
  const { mkdtempSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const path = require('node:path');
  const { fork } = require('node:child_process');
  const dir = mkdtempSync(path.join(tmpdir(), 'sse-worker-'));
  const filename = path.join(dir, 'tasks.db');
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  const config = structuredClone(defaultConfig);
  config.connections[0].baseUrl = 'https://platform.test';
  process.env.RUNNINGHUB_API_KEY = 'test-key';
  const service = new GenerationService(db, config);
  const task = service.create(request('cross-process'));
  const abort = new AbortController();
  const response = await subscribe(service, [task.id], abort.signal);
  const reader = response.body.getReader();
  await read(reader);
  const child = fork(path.join(__dirname, 'helpers/generation-notification-worker.cjs'), { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => { abort.abort(); child.kill(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  child.send({ filename, config });
  let final;
  do { final = (await read(reader)).data.find(task => task.saveStatus === 'saved'); } while (!final);
  const latency = Date.now() - final.updatedAt;
  t.diagnostic(`Persisted OSS result reached SSE in ${latency}ms`);
  assert.ok(latency < 1000, `Notification took ${latency}ms`);
  assert.deepEqual(final.artifacts, ['https://oss.test/result.png']);
  abort.abort();
  const reconnect = new AbortController();
  const reopened = await subscribe(service, [task.id], reconnect.signal);
  const latest = await read(reopened.body.getReader());
  assert.equal(latest.event, 'snapshot');
  assert.equal(latest.data[0].saveStatus, 'saved');
  reconnect.abort();
});

test('shared subscriptions only publish public changes and stop checking after disconnect', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { service } = setup(t);
  const a = service.create(request('shared'));
  const aborts = [new AbortController(), new AbortController()];
  const readers = [];
  for (const abort of aborts) {
    const response = await subscribe(service, [a.id], abort.signal);
    const reader = response.body.getReader(); readers.push(reader);
    await read(reader);
  }
  t.after(() => aborts.forEach(a => a.abort()));
  const worker = new GenerationWorker(service, { fetch: async url => Response.json(url.endsWith('/create') ?
    { code: 0, data: { taskId: '123' } } : { code: 804 }), save: async () => '' });
  await worker.tick();
  t.mock.timers.tick(500);
  for (const reader of readers) assert.equal((await read(reader)).data[0].status, 'running');
  let published = false;
  const next = read(readers[0]).then(event => { published = true; return event; });
  await worker.tick(); // Only the next query time / lease and updated_at change.
  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.equal(published, false);
  t.mock.timers.tick(9000);
  assert.equal((await next).event, 'heartbeat');
  aborts.forEach(a => a.abort());
  t.mock.timers.tick(60_000);
  assert.equal((await readers[0].read()).done, true);
});

test('a consumer can cancel an SSE body without leaking or rejecting cleanup', async t => {
  const { service } = setup(t);
  const task = service.create(request('cancel-stream'));
  const response = await subscribe(service, [task.id]);
  const reader = response.body.getReader();
  await read(reader);
  await assert.doesNotReject(reader.cancel());
});

test('canvas displays original-task resume and save retry through HTTP and shared SSE together', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { service, config } = setup(t);
  config.connections[0].queryTimeoutMs = 1000;
  const { generationHttp } = require('../lib/generation/http.ts');
  const { GenerationNotifications } = require('../lib/generation/notifications.ts');
  const { generationRecovery } = require('../lib/generation/recovery.ts');
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const task = service.create(request('resume-and-save'));
  let view = { generationTaskId: task.id }, submits = 0, saves = 0;
  const call = async (method, resource, id) => {
    const response = await generationHttp(new Request('http://local/tasks/' + id, { method }), service, resource, id);
    assert.equal(response.status, 200);
    return response.json();
  };
  const recovery = generationRecovery(task.nodeId, { read: () => view, update: patch => { view = { ...view, ...patch }; } },
    { getItem: () => null }, {
      get: id => call('GET', 'tasks', id), resume: id => call('POST', 'tasks', id), retrySave: id => call('POST', 'save', id),
    });
  const notifications = new GenerationNotifications({
    get: id => call('GET', 'tasks', id),
    stream: async (ids, signal, message) => {
      const response = await subscribe(service, ids, signal);
      const reader = response.body.getReader();
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) return;
        const text = new TextDecoder().decode(chunk.value);
        message(text.match(/event: (.*)/)[1], JSON.parse(text.match(/data: (.*)/)[1]));
      }
    },
  });
  t.after(() => notifications.close());
  const worker = new GenerationWorker(service, {
    fetch: async url => {
      if (url.endsWith('/create')) { submits++; return Response.json({ code: 0, data: { taskId: '123' } }); }
      return Response.json({ code: 0, data: [{ nodeId: '103', fileUrl: 'https://platform.test/image.png' }] });
    },
    save: async () => { if (++saves === 1) throw new Error('OSS unavailable'); return 'https://oss.test/recovered.png'; },
  });
  await worker.tick();
  notifications.subscribe(task.id, recovery.apply); await flush();
  assert.equal(view.generationStatus, '平台处理中');
  t.mock.timers.tick(1000); await worker.tick();
  t.mock.timers.tick(500); await flush();
  assert.equal(view.generationStatus, '等待超时');
  assert.equal(view.generationBlocked, true);
  await recovery.resume(); notifications.refresh(task.id); await flush();
  assert.equal(view.generationBlocked, false);
  assert.equal(view.isLoading, true);
  await worker.tick(); t.mock.timers.tick(500); await flush();
  assert.equal(view.generationCanRetrySave, true);
  await recovery.retrySave(); notifications.refresh(task.id); await flush();
  assert.equal(view.generationSaving, true);
  await worker.tick(); t.mock.timers.tick(500); await flush();
  assert.equal(view.imageSrc, 'https://oss.test/recovered.png');
  assert.equal(view.isLoading, false);
  assert.equal(view.generationStatus, '已保存');
  assert.equal(submits, 1);
  notifications.close();
});
