require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { GenerationService } = require('../lib/generation/service.ts');
const { defaultConfig } = require('../lib/generation/config.ts');

function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'generation-'));
  const db = new Database(path.join(dir, 'test.db'));
  const config = structuredClone(defaultConfig);
  config.connections[0].baseUrl = 'https://platform.test';
  process.env.RUNNINGHUB_API_KEY = 'secret-test-key';
  const service = new GenerationService(db, config);
  t.after(() => { db.close(); rmSync(dir, { recursive: true }); });
  return { service, db, config };
}
const request = (requestId = 'request-1') => ({ requestId, modelId: 'runninghub-krea2', input: { prompt: 'a garden', width: 1920, height: 1080 }, canvasId: 'canvas-1', nodeId: 'node-1' });

test('public task interface persists a queued task and exposes no platform credentials', (t) => {
  const { service } = setup(t);
  const task = service.create(request());
  assert.equal(task.status, 'queued');
  assert.equal(service.get(task.id).id, task.id);
  assert.deepEqual(task.input, { prompt: 'a garden', width: 1920, height: 1080 });
  assert.equal(service.models()[0].configured, true);
  assert.ok(!JSON.stringify([task, service.models()]).includes('secret-test-key'));
});

test('worker submits typed workflow inputs once, queries and saves an image through the public task interface', async (t) => {
  const { service } = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  const submitted = [];
  const worker = new GenerationWorker(service, {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.apiKey, 'secret-test-key');
      assert.equal(init.headers.Authorization, 'Bearer secret-test-key');
      if (url.endsWith('/create')) {
        submitted.push(body);
        return new Response('{"code":0,"data":{"taskId":2109340746494357505,"taskStatus":"QUEUED"}}');
      }
      assert.equal(body.taskId, '2109340746494357505');
      return Response.json({ code: 0, data: [{ nodeId: '103', fileType: 'png', fileUrl: 'https://platform.test/result.png' }] });
    },
    save: async (url) => { assert.equal(url, 'https://platform.test/result.png'); return 'https://oss.test/result.png'; },
  });
  const task = service.create(request());
  await worker.tick();
  assert.equal(service.get(task.id).status, 'running');
  await worker.tick();
  const result = service.get(task.id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.saveStatus, 'saved');
  assert.deepEqual(result.artifacts, ['https://oss.test/result.png']);
  assert.equal(submitted.length, 1);
  const body = submitted[0];
  assert.equal(body.workflowId, '2109340746494357505');
  const graph = JSON.parse(body.workflow);
  assert.equal(graph['102'].inputs.prompt, 'a garden');
  assert.equal(graph['10'].inputs.custom_width, 1920);
  assert.equal(graph['10'].inputs.custom_height, 1080);
  assert.equal(graph['10'].inputs.use_custom_resolution, true);
  assert.equal(typeof graph['97'].inputs.seed, 'number');
  assert.equal(graph['97'].inputs.steps, 8);
  assert.deepEqual(graph['3'].inputs.text, ['102', 0]);
  assert.ok(!JSON.stringify(result).includes('secret-test-key'));
});

test('invalid inputs never submit; request IDs are idempotent while explicit regeneration is independent', async (t) => {
  const { service } = setup(t);
  for (const input of [ { width: 65 }, { height: 9000 }, { width: '1920' }, { prompt: '' },
    { referenceImages: ['https://image.test/a.png'] }, { seed: 10 }, { count: 2 }, { promptOptimize: true } ]) {
    assert.throws(() => service.create({ ...request(), input: { ...request().input, ...input } }));
  }
  const [a, b] = await Promise.all([Promise.resolve().then(() => service.create(request())), Promise.resolve().then(() => service.create(request()))]);
  assert.equal(a.id, b.id);
  assert.throws(() => service.create({ ...request(), input: { ...request().input, prompt: 'different' } }), /不同输入/);
  assert.notEqual(service.create(request('regenerate')).id, a.id);
});

test('concurrent workers keep one connection serial and retain configuration and seed snapshots', async (t) => {
  const { service, config, db } = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  let submissions = [];
  const io = { fetch: async (url, init) => {
    if (url.endsWith('/create')) { submissions.push(JSON.parse(init.body)); return Response.json({ code: 0, data: { taskId: String(submissions.length) } }); }
    return Response.json({ code: 804 });
  }, save: async () => assert.fail() };
  const a = service.create(request());
  service.create(request('next'));
  config.models[0].version = '2';
  config.models[0].mapping.prompt = { nodeId: '3', fieldName: 'text' };
  const w1 = new GenerationWorker(service, io);
  const otherDb = new Database(db.name);
  t.after(() => otherDb.close());
  const w2 = new GenerationWorker(new GenerationService(otherDb, config), io);
  await Promise.all([w1.tick(), w2.tick()]);
  await Promise.all([w1.tick(), w2.tick()]);
  assert.equal(submissions.length, 1);
  assert.equal(service.get(a.id).modelVersion, '1');
  assert.equal(JSON.parse(submissions[0].workflow)['102'].inputs.prompt, 'a garden');
});

test('a lost submit response retains the connection slot and never resubmits', async (t) => {
  const { service } = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  let submits = 0;
  const worker = new GenerationWorker(service, { fetch: async () => { submits++; throw Error('response lost'); }, save: async () => assert.fail() });
  const a = service.create(request());
  const b = service.create(request('next'));
  await worker.tick();
  await worker.tick();
  assert.equal(service.get(a.id).status, 'uncertain');
  assert.equal(service.get(b.id).status, 'queued');
  assert.equal(submits, 1);
});

test('platform queue and timeout retain occupancy', async (t) => {
  const { service, config } = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  let now = Date.now(); let queries = 0; const code = 813;
  const worker = new GenerationWorker(service, { now: () => now, fetch: async (url) => {
    if (url.endsWith('/create')) return Response.json({ code: 0, data: { taskId: '123' } });
    queries++;
    return Response.json({ code });
  }, save: async () => assert.fail() });
  const a = service.create(request());
  await worker.tick(); await worker.tick();
  assert.equal(service.get(a.id).status, 'running');
  now += config.connections[0].queryTimeoutMs + 1;
  const b = service.create(request('next'));
  await worker.tick();
  assert.equal(service.get(a.id).status, 'timed_out');
  assert.equal(service.get(b.id).status, 'queued');
  assert.equal(queries, 1);
});

test('saving fails independently after success without another paid submission', async (t) => {
  const { service } = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  let submits = 0;
  const worker = new GenerationWorker(service, { fetch: async (url) => {
    if (url.endsWith('/create')) { submits++; return Response.json({ code: 0, data: { taskId: '123' } }); }
    return Response.json({ code: 0, data: [{ nodeId: '103', fileUrl: 'https://test/image.png' }] });
  }, save: async () => { throw Error('OSS unavailable'); } });
  const a = service.create(request());
  await worker.tick(); await worker.tick(); await worker.tick();
  assert.equal(service.get(a.id).status, 'succeeded');
  assert.equal(service.get(a.id).saveStatus, 'failed');
  assert.equal(submits, 1);
});

test('HTTP task creation and retrieval run against a real database and HTTP platform/OSS substitutes', async (t) => {
  const { service, config } = setup(t);
  const { createServer } = require('node:http');
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  const { generationHttp } = require('../lib/generation/http.ts');
  let submits = 0; let uploads = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.url === '/task/openapi/create') { submits++; res.end(JSON.stringify({ code: 0, data: { taskId: '2109340746494357505' } })); }
    else if (req.url === '/task/openapi/outputs') res.end(JSON.stringify({ code: 0, data: [{ nodeId: '103', fileUrl: `${base}/image.png` }] }));
    else if (req.url === '/image.png') res.end('image-content');
    else if (req.url === '/oss') { uploads++; assert.equal(Buffer.concat(chunks).toString(), 'image-content'); res.end('ok'); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.connections[0].baseUrl = base;
  const worker = new GenerationWorker(service, { fetch, save: async url => {
    const data = await fetch(url).then(r => r.arrayBuffer());
    await fetch(`${base}/oss`, { method: 'PUT', body: data });
    return `${base}/saved.png`;
  } });
  const post = () => generationHttp(new Request(`${base}/api/generation/tasks`, { method: 'POST', body: JSON.stringify(request()) }), service, 'tasks');
  const [one, two] = await Promise.all([post(), post()]);
  assert.equal(one.status, 201);
  const task = await one.json();
  assert.equal((await two.json()).id, task.id);
  assert.equal(submits, 0);
  await worker.tick(); await worker.tick();
  const result = await generationHttp(new Request(`${base}/api/generation/tasks/${task.id}`), service, 'tasks', task.id).then(r => r.json());
  assert.equal(result.saveStatus, 'saved');
  assert.equal(submits, 1); assert.equal(uploads, 1);
  assert.deepEqual(result.artifacts, [`${base}/saved.png`]);
});

test('query network retries are finite', async (t) => {
  const { service, config } = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  let now = Date.now(); let queries = 0;
  const worker = new GenerationWorker(service, { now: () => now, fetch: async url => {
    if (url.endsWith('/create')) return Response.json({ code: 0, data: { taskId: '100' } });
    queries++; return new Response('', { status: 503 });
  }, save: async () => assert.fail() });
  const a = service.create(request()); await worker.tick();
  for (let i = 0; i < 5; i++) { now += config.connections[0].pollIntervalMs; await worker.tick(); }
  assert.equal(queries, 3); assert.equal(service.get(a.id).status, 'uncertain');
});

test('a crashed submitter is fenced from resubmission and a new worker resumes an identified task', async (t) => {
  const { service, config } = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  let now = Date.now(); let submits = 0; let resolveSubmit;
  const io = { now: () => now, fetch: async url => {
    if (url.endsWith('/create')) { submits++; return new Promise(resolve => { resolveSubmit = resolve; }); }
    return Response.json({ code: 804 });
  }, save: async () => assert.fail() };
  const a = service.create(request());
  const inFlight = new GenerationWorker(service, io).tick();
  now += config.connections[0].requestTimeoutMs + 30_001;
  await new GenerationWorker(service, io).tick();
  assert.equal(service.get(a.id).status, 'uncertain');
  assert.equal(submits, 1);
  resolveSubmit(Response.json({ code: 0, data: { taskId: '900' } }));
  await inFlight;
  // If the original submitter is still alive, its definitive response can resolve uncertainty.
  assert.equal(service.get(a.id).status, 'running');
  await new GenerationWorker(service, io).tick();
  assert.equal(submits, 1);
});

test('configured concurrency permits two independent generations with new seeds and no prompt cache', async (t) => {
  const { service, config } = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  config.connections[0].concurrency = 2;
  const submitted = [];
  const worker = new GenerationWorker(service, { fetch: async (url, init) => {
    if (url.endsWith('/create')) { submitted.push(JSON.parse(init.body)); return Response.json({ code: 0, data: { taskId: String(submitted.length) } }); }
    return Response.json({ code: 804 });
  }, save: async () => assert.fail() });
  service.create(request()); service.create(request('new-generation'));
  await worker.tick(); await worker.tick(); await worker.tick();
  assert.equal(submitted.length, 2);
  const [a, b] = submitted.map(s => JSON.parse(s.workflow)['97'].inputs.seed);
  assert.notEqual(a, b);
  assert.ok(Number.isSafeInteger(a) && Number.isSafeInteger(b));
});

test('a deterministic query error stops polling without releasing the connection', async (t) => {
  const { service } = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  let calls = 0;
  const worker = new GenerationWorker(service, { fetch: async url => {
    calls++;
    return Response.json(url.endsWith('/create') ? { code: 0, data: { taskId: '100' } } : { code: 401, msg: 'secret-test-key' });
  }, save: async () => assert.fail() });
  const a = service.create(request()); const b = service.create(request('next'));
  await worker.tick(); await worker.tick(); await worker.tick();
  assert.equal(service.get(a.id).status, 'uncertain');
  assert.equal(service.get(b.id).status, 'queued');
  assert.equal(calls, 2);
  assert.ok(!JSON.stringify(service.get(a.id)).includes('secret-test-key'));
});

test('unconfigured models remain visible and reject creation; unsafe admin configuration is rejected', (t) => {
  const { service, config, db } = setup(t);
  config.connections[0].baseUrl = '';
  assert.equal(service.models()[0].configured, false);
  assert.throws(() => service.create(request()), /未配置/);
  const bad = structuredClone(config);
  bad.connections[0].apiKey = 'inline-secret';
  assert.throws(() => new GenerationService(db, bad), /configuration/);
});

test('ambiguous JSON submission errors retain occupancy while a definitive rejection releases it', async (t) => {
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  for (const code of [500, 9999, 416]) {
    const { service } = setup(t);
    let submits = 0;
    const worker = new GenerationWorker(service, { fetch: async () => { submits++; return Response.json({ code }); }, save: async () => assert.fail() });
    const a = service.create(request()); const b = service.create(request('next'));
    await worker.tick(); await worker.tick();
    assert.equal(service.get(a.id).status, code === 416 ? 'failed' : 'uncertain');
    assert.equal(service.get(b.id).status, code === 416 ? 'failed' : 'queued');
    assert.equal(submits, code === 416 ? 2 : 1);
  }
});

test('transient JSON platform errors use the bounded query retry policy', async (t) => {
  const { service, config } = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  let now = Date.now(); let queries = 0;
  const worker = new GenerationWorker(service, { now: () => now, fetch: async url => {
    if (url.endsWith('/create')) return Response.json({ code: 0, data: { taskId: '100' } });
    queries++; return Response.json({ code: 500, msg: 'UNKNOWN_ERROR' });
  }, save: async () => assert.fail() });
  const a = service.create(request()); await worker.tick(); await worker.tick();
  assert.equal(service.get(a.id).status, 'running');
  for (let i = 0; i < 4; i++) { now += config.connections[0].pollIntervalMs; await worker.tick(); }
  assert.equal(queries, 3); assert.equal(service.get(a.id).status, 'uncertain');
});

test('continue querying renews the deadline on the original task and releases occupancy only at a definite outcome', async t => {
  const { service, config } = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  let now = Date.now(); let submits = 0; let finished = false;
  const worker = new GenerationWorker(service, { now: () => now, fetch: async url => {
    if (url.endsWith('/create')) { submits++; return Response.json({ code: 0, data: { taskId: '123' } }); }
    return Response.json({ code: finished ? 805 : 804 });
  }, save: async () => assert.fail() });
  const a = service.create(request()); const b = service.create(request('second'));
  await worker.tick(); now += config.connections[0].queryTimeoutMs + 1;
  await worker.tick(); assert.equal(service.get(a.id).status, 'timed_out');
  const resumed = service.resume(a.id, now);
  assert.equal(resumed.deadline, now + config.connections[0].queryTimeoutMs);
  assert.equal(resumed.id, a.id);
  await worker.tick(); assert.equal(submits, 1);
  finished = true; now += config.connections[0].pollIntervalMs;
  await worker.tick(); await worker.tick();
  assert.equal(service.get(a.id).status, 'failed');
  assert.equal(service.get(b.id).status, 'running'); assert.equal(submits, 2);
});

test('deletion cancels queued generations atomically, prevents late creation, and preserves already claimed tasks', async t => {
  const { service } = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  let release; let submits = 0;
  const worker = new GenerationWorker(service, { fetch: async url => {
    if (url.endsWith('/create')) { submits++; return new Promise(resolve => release = resolve); }
    return Response.json({ code: 805 });
  }, save: async () => assert.fail() });
  const a = service.create(request()); const b = service.create(request('queued'));
  const flight = worker.tick();
  service.deleteNode('canvas-1', 'node-1');
  assert.equal(service.get(a.id).status, 'submitting');
  assert.equal(service.get(b.id).status, 'cancelled');
  assert.throws(() => service.create(request('late')), /删除/);
  release(Response.json({ code: 0, data: { taskId: '123' } })); await flight;
  await worker.tick(); assert.equal(service.get(a.id).status, 'failed');
  assert.equal(submits, 1);
});

test('killed executors recover queued, ambiguous submission, identified and saving tasks from the reopened database', async t => {
  const { fork } = require('node:child_process');
  const { once } = require('node:events');
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  for (const phase of ['queued', 'submitting', 'running', 'saving']) {
    const dir = mkdtempSync(path.join(tmpdir(), 'recovery-'));
    const filename = path.join(dir, 'tasks.db');
    const config = structuredClone(defaultConfig);
    config.connections[0].baseUrl = 'https://platform.test';
    process.env.RUNNINGHUB_API_KEY = 'secret-test-key';
    let db = new Database(filename);
    const task = new GenerationService(db, config).create(request());
    db.close();
    const now = Date.now();
    const child = fork(path.join(__dirname, 'helpers/recovery-worker.cjs'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const message = once(child, 'message');
    child.send({ filename, config, phase, now });
    await message;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    db = new Database(filename);
    const service = new GenerationService(db, config);
    let submits = 0; let queries = 0; let saves = 0;
    const worker = new GenerationWorker(service, {
      now: () => now + 250_000,
      fetch: async (url, init) => {
        if (url.endsWith('/create')) { submits++; return Response.json({ code: 0, data: { taskId: '987654321' } }); }
        queries++; assert.equal(JSON.parse(init.body).taskId, '987654321');
        return Response.json({ code: 805 });
      }, save: async () => { saves++; return 'https://oss.test/recovered.png'; },
    });
    await worker.tick();
    assert.equal(service.get(task.id).status, { queued: 'running', submitting: 'uncertain', running: 'failed', saving: 'succeeded' }[phase]);
    assert.equal(submits, phase === 'queued' ? 1 : 0);
    assert.equal(queries, phase === 'running' ? 1 : 0);
    assert.equal(saves, phase === 'saving' ? 1 : 0);
    if (phase === 'saving') assert.equal(service.get(task.id).saveStatus, 'saved');
    db.close(); rmSync(dir, { recursive: true });
  }
});

test('canvas recovery reuses a persisted request after a lost response, and old results cannot overwrite a newer generation or deleted node', async () => {
  const { generationRecovery } = require('../lib/generation/recovery.ts');
  const values = new Map();
  const storage = { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  let node = {}; let resolveOld; let calls = [];
  const task = (r, id) => ({ ...r, id, status: 'succeeded', saveStatus: 'saved', artifacts: [id + '.png'], error: null });
  const port = { read: () => node, update: v => Object.assign(node, v) };
  const io = { create: async r => { calls.push(r); throw Error('lost response'); },
    get: async id => new Promise(resolve => resolveOld = () => resolve(task(request(), id))), resume: async () => assert.fail() };
  await generationRecovery('node-1', port, storage, io).start(request());
  assert.equal(node.pendingGeneration.requestId, 'request-1');
  node = {}; // Reload even an older saved canvas: journal restores its association.
  io.create = async r => { calls.push(r); return task(r, r.requestId); };
  const recovery = generationRecovery('node-1', port, storage, io);
  await recovery.recover();
  assert.equal(node.generationTaskId, 'request-1');
  assert.deepEqual(calls[0], calls[1]);
  const oldPoll = recovery.poll('request-1');
  await recovery.start(request('new'));
  resolveOld(); await oldPoll;
  assert.equal(node.imageSrc, 'new.png');
  const latePoll = recovery.poll('new'); node = undefined;
  resolveOld(); await latePoll;
  assert.equal(node, undefined);
});

test('recovery never submits when durable storage fails and never updates a switched-away canvas', async () => {
  const { generationRecovery } = require('../lib/generation/recovery.ts');
  let node = {}; let submits = 0; let resolveCreate;
  const values = new Map();
  const storage = { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  const view = { read: () => node, update: v => Object.assign(node, v) };
  const io = { create: async r => { submits++; return new Promise(resolve => resolveCreate = () => resolve({
    ...r, id: 'original', status: 'running', artifacts: [], error: null,
  })); }, get: async () => assert.fail(), resume: async () => assert.fail() };
  await generationRecovery('node-1', view, { ...storage, setItem: () => { throw Error('quota'); } }, io).start(request());
  assert.equal(submits, 0); assert.match(node.error, /尚未提交/);
  const inFlight = generationRecovery('node-1', view, storage, io).start(request());
  node = undefined; resolveCreate(); await inFlight;
  assert.equal(node, undefined);
  node = {};
  await generationRecovery('node-1', view, storage, io).recover();
  assert.equal(node.generationTaskId, 'original'); assert.equal(submits, 1);
});

test('task HTTP supports continuing the original task and deleting a node without cancelling an accepted submission', async t => {
  const { service } = setup(t);
  const { generationHttp } = require('../lib/generation/http.ts');
  const a = service.create(request());
  const res = await generationHttp(new Request('http://test/tasks', {
    method: 'DELETE', body: JSON.stringify({ canvasId: 'canvas-1', nodeId: 'node-1' }),
  }), service, 'tasks');
  assert.equal(res.status, 200);
  assert.equal(service.get(a.id).status, 'cancelled');
  const again = await generationHttp(new Request('http://test/tasks/' + a.id, { method: 'POST' }), service, 'tasks', a.id);
  assert.equal((await again.json()).status, 'cancelled');
});

test('a newer legacy-model generation detaches task recovery even when reopening an older saved canvas', async () => {
  const { generationRecovery } = require('../lib/generation/recovery.ts');
  const values = new Map();
  const storage = { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  let node = {};
  const view = { read: () => node, update: v => Object.assign(node, v) };
  const io = { create: async r => ({ ...r, id: 'krea', status: 'succeeded', saveStatus: 'saved', artifacts: ['old.png'] }),
    get: async () => assert.fail('detached task must not be queried'), resume: async () => assert.fail() };
  const recovery = generationRecovery('node-1', view, storage, io);
  await recovery.start(request());
  await recovery.detach();
  node.imageSrc = 'legacy.png';
  node = { ...node, generationTaskId: 'krea' }; // Older saved association.
  await generationRecovery('node-1', view, storage, io).recover();
  assert.equal(node.generationTaskId, undefined);
  assert.equal(node.imageSrc, 'legacy.png');
});
