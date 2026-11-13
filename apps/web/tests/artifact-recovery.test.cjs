require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { GenerationService } = require('../lib/generation/service.ts');
const { GenerationWorker } = require('../lib/generation/worker.ts');
const { defaultConfig } = require('../lib/generation/config.ts');
const { generationHttp } = require('../lib/generation/http.ts');

const request = (requestId = 'original') => ({ requestId, modelId: 'runninghub-krea2',
  canvasId: 'canvas', nodeId: 'node', input: { prompt: 'garden', width: 1920, height: 1080 } });
function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'artifacts-'));
  const filename = path.join(dir, 'tasks.db');
  const db = new Database(filename);
  const config = structuredClone(defaultConfig);
  config.connections[0].baseUrl = 'https://platform.test';
  process.env.RUNNINGHUB_API_KEY = 'secret-test-key';
  const service = new GenerationService(db, config);
  t.after(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, db, config, filename, dir };
}

test('saving can be retried on the original task without another generation and preserves successful artifacts', async t => {
  const { service } = setup(t);
  let submits = 0; let fail = true; const saved = [];
  const worker = new GenerationWorker(service, {
    fetch: async url => {
      if (url.endsWith('/create')) { submits++; return Response.json({ code: 0, data: { taskId: '123' } }); }
      return Response.json({ code: 0, data: [0, 1].map(i => ({ nodeId: '103', fileUrl: `https://platform.test/${i}.png` })) });
    },
    save: async (url, id, index) => {
      saved.push(index);
      if (index === 1 && fail) throw Error('OSS failed secret-token');
      return `https://oss.test/${id}/${index}.png`;
    },
  });
  const task = service.create(request());
  await worker.tick(); await worker.tick();
  assert.equal(service.get(task.id).status, 'succeeded');
  assert.equal(service.get(task.id).saveStatus, 'failed');
  assert.deepEqual(service.get(task.id).artifacts, [`https://oss.test/${task.id}/0.png`]);
  fail = false;
  const pending = service.retrySave(task.id);
  assert.equal(pending.saveStatus, 'pending');
  assert.equal(pending.artifacts.length, 1);
  await worker.tick();
  assert.equal(service.get(task.id).saveStatus, 'saved');
  assert.deepEqual(saved, [0, 1, 1]);
  assert.equal(service.get(task.id).artifacts.length, 2);
  assert.equal(submits, 1);
  assert.ok(!JSON.stringify(service.get(task.id)).includes('secret-token'));
});

test('an uploaded object is recovered after its response is lost, even if the platform URL has expired', async t => {
  const { service } = setup(t);
  const { createGenerationImageSaver } = require('../lib/generation/storage.ts');
  const objects = new Map(); let uploads = 0; let downloads = 0; let submits = 0;
  const save = createGenerationImageSaver({
    fetch: async () => { downloads++; return new Response('image', { headers: { 'content-type': 'image/png' } }); },
    publicUrl: key => 'https://oss.test/' + key,
    client: {
      head: async key => { if (!objects.has(key)) throw { status: 404 }; return {}; },
      put: async (key, content) => { uploads++; objects.set(key, content); throw Error('upload response lost'); },
    },
  });
  const worker = new GenerationWorker(service, { save, fetch: async url => {
    if (url.endsWith('/create')) { submits++; return Response.json({ code: 0, data: { taskId: '123' } }); }
    return Response.json({ code: 0, data: [{ nodeId: '103', fileUrl: 'https://platform.test/temporary.png?secret=token' }] });
  } });
  const task = service.create(request());
  await worker.tick(); await worker.tick();
  assert.equal(service.get(task.id).saveStatus, 'failed');
  service.retrySave(task.id); await worker.tick();
  assert.equal(service.get(task.id).saveStatus, 'saved');
  assert.deepEqual(service.get(task.id).artifacts, [`https://oss.test/images/generation/${task.id}/0.png`]);
  assert.equal(uploads, 1); assert.equal(downloads, 1); assert.equal(submits, 1);
});

test('expired results and download timeouts stay generation-successful with safe, actionable save errors', async t => {
  const { createGenerationImageSaver } = require('../lib/generation/storage.ts');
  for (const failure of ['expired', 'timeout']) {
    const { service } = setup(t);
    let submits = 0; let downloads = 0;
    const worker = new GenerationWorker(service, {
      fetch: async url => {
        if (url.endsWith('/create')) { submits++; return Response.json({ code: 0, data: { taskId: '123' } }); }
        return Response.json({ code: 0, data: [{ nodeId: '103', fileUrl: 'https://platform.test/image?token=private' }] });
      },
      save: createGenerationImageSaver({
        fetch: async (_url, init) => {
          assert.ok(init.signal instanceof AbortSignal);
          downloads++;
          if (failure === 'timeout') throw new DOMException('private signature', 'TimeoutError');
          return new Response('', { status: 410 });
        },
        publicUrl: key => 'https://oss.test/' + key,
        client: { head: async () => { throw { status: 404 }; }, put: async () => assert.fail() },
      }),
    });
    const task = service.create(request());
    await worker.tick(); await worker.tick(); await worker.tick();
    const result = service.get(task.id);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.saveStatus, 'failed');
    assert.match(result.error, /生成成功.*结果保存失败/);
    assert.match(result.error, failure === 'timeout' ? /下载超时/ : /过期或无法取回/);
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.equal(submits, 1); assert.equal(downloads, 1);
  }
});

test('HTTP save retries reject unfinished tasks and repeated clicks cannot steal a transfer from another worker', async t => {
  const { service, config, filename } = setup(t);
  const otherDb = new Database(filename); t.after(() => otherDb.close());
  const other = new GenerationService(otherDb, config);
  let attempts = 0; let release; let submits = 0;
  const io = {
    fetch: async url => {
      if (url.endsWith('/create')) { submits++; return Response.json({ code: 0, data: { taskId: String(submits) } }); }
      return Response.json({ code: 0, data: [{ nodeId: '103', fileUrl: 'https://platform.test/image' }] });
    },
    save: async () => {
      attempts++;
      if (attempts === 1) throw Error('first download failed');
      return new Promise(resolve => release = () => resolve('https://oss.test/image.png'));
    },
  };
  const task = service.create(request());
  const retry = () => generationHttp(new Request('http://test/tasks/' + task.id + '/save', { method: 'POST' }), service, 'save', task.id);
  assert.equal((await retry()).status, 409);
  const one = new GenerationWorker(service, io);
  const two = new GenerationWorker(other, io);
  await one.tick(); await one.tick();
  assert.equal(service.get(task.id).saveStatus, 'failed');
  const results = await Promise.all([retry(), retry()]);
  assert.ok(results.every(r => r.status === 200));
  const transferring = one.tick();
  assert.equal(service.get(task.id).saveStatus, 'saving');
  await retry(); await two.tick();
  assert.equal(attempts, 2);
  // Generation occupancy was already released, even while the saver is busy.
  const next = service.create(request('next'));
  await two.tick();
  assert.equal(service.get(next.id).status, 'running');
  release(); await transferring;
  assert.equal(service.get(task.id).saveStatus, 'saved');
  await retry();
  assert.equal(service.get(task.id).saveStatus, 'saved');
  assert.equal(attempts, 2); assert.equal(submits, 2);
});

test('killed transfer processes recover before upload, after upload before acknowledgement, and after partial success', { timeout: 20_000 }, async t => {
  const { createServer } = require('node:http');
  const { fork } = require('node:child_process');
  const { once } = require('node:events');
  const { artifactHttpIO } = require('./helpers/artifact-http-io.cjs');
  for (const phase of ['before-upload', 'uploaded', 'partial']) {
    const { service, db, config, filename } = setup(t);
    let restarting = false; let submits = 0;
    const objects = new Map(); const puts = []; const downloads = [];
    let paused; const pause = new Promise(resolve => paused = resolve);
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (req.url === '/task/openapi/create') {
        submits++; res.end(JSON.stringify({ code: 0, data: { taskId: '123' } }));
      } else if (req.url === '/task/openapi/outputs') {
        res.end(JSON.stringify({ code: 0, data: [0, 1].map(i => ({ nodeId: '103', fileUrl: base + '/source/' + i })) }));
      } else if (req.url.startsWith('/source/')) {
        const index = Number(req.url.split('/').at(-1)); downloads.push(index);
        if (!restarting && ((phase === 'before-upload' && index === 0) || (phase === 'partial' && index === 1))) {
          paused(); return;
        }
        res.end('image-' + index);
      } else if (req.url.startsWith('/objects/')) {
        if (req.method === 'HEAD') {
          res.statusCode = objects.has(req.url) ? 200 : 404; res.end();
        } else {
          objects.set(req.url, Buffer.concat(chunks).toString()); puts.push(req.url);
          if (!restarting && phase === 'uploaded') { paused(); return; }
          res.end('ok');
        }
      } else { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    t.after(() => { server.closeAllConnections(); server.close(); });
    config.connections[0].baseUrl = base;
    const task = service.create(request());
    db.close();
    const child = fork(path.join(__dirname, 'helpers/artifact-worker.cjs'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    t.after(() => child.kill('SIGKILL'));
    const now = Date.now();
    child.send({ filename, config, base, now });
    await pause;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    restarting = true;
    const reopened = new Database(filename);
    const recovered = new GenerationService(reopened, config);
    const before = recovered.get(task.id);
    assert.equal(before.status, 'succeeded');
    assert.equal(before.saveStatus, 'saving');
    assert.equal(before.artifacts.length, phase === 'partial' ? 1 : 0);
    const worker = new GenerationWorker(recovered, { ...artifactHttpIO(base), now: () => now + 240_001 });
    await worker.tick();
    const after = recovered.get(task.id);
    assert.equal(after.saveStatus, 'saved');
    assert.equal(after.artifacts.length, 2);
    assert.equal(puts.length, 2);
    assert.equal(new Set(puts).size, 2);
    assert.equal(submits, 1);
    if (phase !== 'before-upload') assert.equal(downloads.filter(i => i === 0).length, 1);
    assert.equal(objects.get('/objects/images/generation/' + task.id + '/0.png'), 'image-0');
    reopened.close();
  }
});

test('canvas save retry disables repeated clicks, displays saved output, and ignores a late response after regeneration', async t => {
  const { generationRecovery } = require('../lib/generation/recovery.ts');
  const { service } = setup(t);
  const values = new Map(); let node = {}; let allowSave = false; let retryCalls = 0; let release;
  const storage = { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  const worker = new GenerationWorker(service, {
    fetch: async url => Response.json(url.endsWith('/create') ? { code: 0, data: { taskId: '123' } } :
      { code: 0, data: [{ nodeId: '103', fileUrl: 'https://platform.test/image' }] }),
    save: async () => { if (!allowSave) throw Error('OSS down'); return 'https://oss.test/saved.png'; },
  });
  const io = { create: async r => service.create(r), get: async id => service.get(id), resume: async () => assert.fail(),
    retrySave: async id => { retryCalls++; return new Promise(resolve => release = () => resolve(service.retrySave(id))); } };
  const recovery = generationRecovery('node', { read: () => node, update: v => Object.assign(node, v) }, storage, io);
  await recovery.start(request());
  const id = node.generationTaskId;
  await worker.tick(); await worker.tick(); await recovery.poll(id);
  assert.equal(node.generationCanRetrySave, true);
  const retrying = recovery.retrySave();
  assert.equal(node.generationCanRetrySave, false);
  await recovery.retrySave(); assert.equal(retryCalls, 1);
  release(); await retrying;
  assert.equal(node.generationSaving, true);
  allowSave = true; await worker.tick(); await recovery.poll(id);
  assert.equal(node.generationStatus, '已保存');
  assert.equal(node.imageSrc, 'https://oss.test/saved.png');
  assert.equal(node.generationCanRetrySave, false);
  assert.equal(node.generationSaving, false);

  allowSave = false;
  await recovery.start(request('second')); const second = node.generationTaskId;
  await worker.tick(); await worker.tick(); await recovery.poll(second);
  const late = recovery.retrySave();
  await recovery.start(request('third')); const third = node.generationTaskId;
  release(); await late;
  assert.equal(node.generationTaskId, third);
  assert.equal(node.generationStatus, '本地排队');
});

test('a live transfer keeps its lease throughout the OSS connection and response timeout budget', async t => {
  const { service, filename, config } = setup(t);
  const secondDb = new Database(filename); t.after(() => secondDb.close());
  const secondService = new GenerationService(secondDb, config);
  let now = Date.now(); let transfers = 0; let finish;
  const io = { now: () => now,
    fetch: async url => Response.json(url.endsWith('/create') ? { code: 0, data: { taskId: '123' } } :
      { code: 0, data: [{ nodeId: '103', fileUrl: 'https://platform.test/image' }] }),
    save: async () => {
      transfers++;
      if (transfers > 1) return 'https://oss.test/duplicate.png';
      return new Promise(resolve => finish = () => resolve('https://oss.test/original.png'));
    },
  };
  const worker = new GenerationWorker(service, io);
  const task = service.create(request());
  await worker.tick();
  const saving = worker.tick();
  await new Promise(resolve => setImmediate(resolve));
  // HEAD: 15s connect + 15s response; download: 30s; PUT: 60s connect + 60s response.
  now += 180_000;
  await new GenerationWorker(secondService, io).tick();
  const countBeforeCompletion = transfers;
  finish(); await saving;
  assert.equal(countBeforeCompletion, 1);
  assert.deepEqual(service.get(task.id).artifacts, ['https://oss.test/original.png']);
});
