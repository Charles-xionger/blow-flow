require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { GenerationService } = require('../lib/generation/service.ts');
const { GenerationWorker } = require('../lib/generation/worker.ts');
const { defaultConfig } = require('../lib/generation/config.ts');
const { submission } = require('../lib/generation/runninghub.ts');
const { videoDimensions, videoFrameCount, referenceLabels } = require('../lib/generation/video.ts');
const origin = 'https://h3-test.oss-cn-hangzhou.aliyuncs.com';
function setup(t) {
  process.env.OSS_BUCKET_NAME = 'h3-test'; process.env.OSS_REGION = 'oss-cn-hangzhou';
  process.env.RUNNINGHUB_API_KEY = 'test-secret';
  const db = new Database(':memory:'); t.after(() => db.close());
  const config = structuredClone(defaultConfig); config.connections[0].baseUrl = 'https://platform.test';
  const service = new GenerationService(db, config);
  return { db, config, service };
}
const ref = (kind, index = 0, useAudio = true) => ({ kind, url: `${origin}/${kind}${index}.${{ image: 'png', video: 'mp4', audio: 'wav' }[kind]}`,
  ...(kind === 'video' ? { useAudio } : {}) });
const request = (references = [], requestId = 'request-1') => ({ requestId, modelId: 'runninghub-h3', canvasId: 'canvas', nodeId: 'video',
  input: { prompt: '参考 <Picture 1> 和 <Video 1>，使用 <Audio 1>', width: 1280, height: 736, duration: 7, references } });
function mockIO() {
  const submits = [], uploads = [];
  return { submits, uploads,
    inspectReference: async () => ({ hasAudio: true }),
    fetch: async (url, init) => {
      assert.equal(init.redirect, 'error');
      if (url.startsWith(origin)) return new Response('mock-media');
      assert.equal(init.headers.Authorization, 'Bearer test-secret');
      if (url.endsWith('/upload')) {
        assert.equal(init.body.get('fileType'), 'input'); assert.equal(init.body.get('apiKey'), 'test-secret');
        const file = init.body.get('file'); assert.equal(await file.text(), 'mock-media'); uploads.push(file.name);
        return Response.json({ code: 0, data: { fileName: 'api/' + file.name } });
      }
      const body = JSON.parse(init.body);
      if (url.endsWith('/create')) { submits.push(body); return Response.json({ code: 0, data: { taskId: '1234567890123456789' } }); }
      return Response.json({ code: 0, data: [{ nodeId: '148', fileType: 'png', fileUrl: 'https://platform.test/preview.png' },
        { nodeId: '148', fileType: 'mp4', fileUrl: 'https://platform.test/movie.mp4' }] });
    },
    save: async (_url, task, index, type) => { assert.equal(type, 'video'); return `${origin}/videos/generation/${task}/${index}.mp4`; },
  };
}

test('all H3 reference slots upload and execute exactly once, with stable media order and video recovery', async t => {
  const { service, db } = setup(t);
  const references = [...Array.from({ length: 9 }, (_, i) => ref('image', i)), ref('video', 0), ref('video', 1, false), ref('video', 2),
    ...Array.from({ length: 3 }, (_, i) => ref('audio', i))];
  const original = service.create(request(references));
  assert.equal(service.create(request(references)).id, original.id);
  const io = mockIO(); const worker = new GenerationWorker(service, io); t.after(() => worker.close());
  await worker.tick();
  assert.equal(service.get(original.id).status, 'running');
  assert.equal(io.uploads.length, 15); assert.equal(io.submits.length, 1);
  const graph = JSON.parse(io.submits[0].workflow);
  assert.equal(graph['136'].inputs.width, 1280); assert.equal(graph['136'].inputs.height, 736);
  assert.equal(graph['227'].inputs.value, 7); assert.equal(graph['238'].inputs.value, request().input.prompt);
  assert.equal(graph['148'].inputs.frame_rate, 24); assert.deepEqual(graph['148'].inputs.audio, ['121', 0]);
  for (let i = 0; i < 9; i++) {
    const source = graph['136'].inputs[`ref_images.ref_image_${i}`][0];
    assert.equal(graph[source].inputs.image, `api/image${i}.png`);
  }
  for (let i = 0; i < 3; i++) {
    const source = graph['136'].inputs[`ref_videos.ref_video_${i}`][0];
    assert.equal(graph[source].inputs.video, `api/video${i}.mp4`);
    assert.equal(graph[source].inputs.force_rate, 24); assert.equal(graph[source].inputs.frame_load_cap, 175);
    assert.equal(graph[source].class_type, 'VHS_LoadVideo');
    assert.equal(graph[graph['136'].inputs[`ref_audios.ref_audio_${i}`][0]].inputs.audio, `api/audio${i}.wav`);
  }
  assert.equal(graph['136'].inputs['ref_video_audios.ref_video_audio_1'], undefined);
  assert.equal(graph['136'].inputs['ref_video_audios.ref_video_audio_2'][1], 2);
  for (const n of Object.values(graph)) for (const value of Object.values(n.inputs)) {
    if (Array.isArray(value)) assert.ok(graph[value[0]], `dangling graph input ${value}`);
  }
  assert.ok(!JSON.stringify(graph).includes('pasted/')); assert.ok(!JSON.stringify(graph).includes('"None"'));
  assert.equal(typeof JSON.parse(db.prepare('SELECT input FROM generation_tasks').get().input).seed, 'number');
  worker.close();
  const restarted = new GenerationWorker(service, io); t.after(() => restarted.close());
  await restarted.tick();
  const result = service.get(original.id);
  assert.equal(result.outputType, 'video'); assert.equal(result.saveStatus, 'saved');
  assert.equal(result.artifacts.length, 1);
  assert.match(result.artifacts[0], /\.mp4$/); assert.equal(io.submits.length, 1);
  assert.ok(!JSON.stringify(result).includes('test-secret'));
});

test('single image and text-only requests remove every unused sample and optional branch', t => {
  const { config } = setup(t); const snapshot = { model: config.models[1], connection: config.connections[0] };
  for (const references of [[], [ref('image')]]) {
    const graph = JSON.parse(submission(snapshot, { ...request(references).input, seed: 42 }, references.map(r => ({ ...r, fileName: 'api/chosen.png' }))).workflow);
    assert.equal(Object.keys(graph['136'].inputs).filter(key => key.startsWith('ref_images.')).length, references.length);
    assert.ok(!Object.keys(graph['136'].inputs).some(key => key.startsWith('ref_videos.') || key.startsWith('ref_audios.')));
    assert.ok(!Object.values(graph).some(n => ['LoadAudio', 'VHS_LoadVideo'].includes(n.class_type)));
    assert.ok(!JSON.stringify(graph).includes('pasted/'));
    assert.equal(graph['127'].inputs.unet_name, snapshot.model.workflow['127'].inputs.unet_name);
  }
});

test('invalid H3 counts, duration, unsafe URLs and dimensions are rejected before queueing', t => {
  const { service, db } = setup(t);
  const badInputs = [ { references: Array.from({ length: 10 }, (_, i) => ref('image', i)) },
    { references: Array.from({ length: 4 }, (_, i) => ref('video', i)) },
    { references: Array.from({ length: 4 }, (_, i) => ref('audio', i)) },
    { references: [{ ...ref('image'), url: 'http://127.0.0.1/secret.png' }] },
    { references: [{ ...ref('image'), useAudio: true }] }, { duration: 16 }, { duration: 4 }, { duration: 5.5 },
    { width: 1281 }, { height: 720 }, { duration: undefined } ];
  for (const input of badInputs) assert.throws(() => service.create({ ...request(), input: { ...request().input, ...input } }));
  assert.equal(db.prepare('SELECT count(*) as count FROM generation_tasks').get().count, 0);
});

test('preparation failure releases the queue without a paid request; empty video audio is explicit', async t => {
  const { service } = setup(t); const io = mockIO(); io.inspectReference = async () => ({ hasAudio: false });
  const worker = new GenerationWorker(service, io); t.after(() => worker.close());
  const failed = service.create(request([ref('video')]));
  const next = service.create(request([], 'next'));
  await worker.tick();
  assert.equal(service.get(failed.id).status, 'failed'); assert.match(service.get(failed.id).error, /没有音轨.*尚未提交/);
  assert.equal(io.submits.length, 0);
  await worker.tick(); assert.equal(service.get(next.id).status, 'running'); assert.equal(io.submits.length, 1);
});

test('expired preparation may restart but stale owners cannot submit, while lost create responses never retry', async t => {
  const { service, db } = setup(t); let now = Date.now(); const io = mockIO();
  const task = service.create(request([ref('image')]));
  let release; let first = true;
  const held = { ...io, now: () => now, fetch: async (url, init) => {
    if (first && url.startsWith(origin)) { first = false; await new Promise(resolve => release = resolve); }
    return io.fetch(url, init);
  } };
  const one = new GenerationWorker(service, held); const two = new GenerationWorker(service, { ...io, now: () => now });
  t.after(() => { one.close(); two.close(); });
  const inFlight = one.tick();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  now += 300_000; await two.tick(); release(); await inFlight;
  assert.equal(io.submits.length, 1); assert.equal(service.get(task.id).status, 'running');
  db.prepare("UPDATE generation_tasks SET status='failed' WHERE id=?").run(task.id);
  const lost = service.create(request([], 'lost'));
  let createCount = 0;
  const uncertain = new GenerationWorker(service, { ...io, fetch: async url => { assert.ok(url.endsWith('/create')); createCount++; throw Error('lost response'); } });
  t.after(() => uncertain.close());
  await uncertain.tick(); await uncertain.tick();
  assert.equal(service.get(lost.id).status, 'uncertain'); assert.equal(createCount, 1);
  assert.equal(db.prepare('SELECT submission_started FROM generation_tasks WHERE id=?').get(lost.id).submission_started, 1);
});

test('video OSS recovery uses MP4 and the canvas never writes a video into imageSrc', async t => {
  const { createGenerationImageSaver } = require('../lib/generation/storage.ts');
  const objects = new Map(); let puts = 0;
  const save = createGenerationImageSaver({ fetch: async () => new Response('mp4'), publicUrl: key => origin + '/' + key,
    client: { head: async key => { if (!objects.has(key)) throw { status: 404 }; }, put: async (key, bytes, options) => {
      assert.equal(options.headers['Content-Type'], 'video/mp4'); objects.set(key, bytes); puts++; throw Error('lost acknowledgement');
    } } });
  await assert.rejects(save('https://platform.test/output', 'task', 0, 'video'));
  const url = await save('https://platform.test/expired', 'task', 0, 'video');
  assert.equal(url, origin + '/videos/generation/task/0.mp4'); assert.equal(puts, 1);
  const { service } = setup(t); const initial = service.create(request());
  const finished = { ...initial, status: 'succeeded', saveStatus: 'saved', revision: 3, artifacts: [url] };
  const memory = new Map(); let node = {};
  const storage = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v), removeItem: k => memory.delete(k) };
  const { generationRecovery } = require('../lib/generation/recovery.ts');
  const view = { read: () => node, update: patch => { node = { ...node, ...patch }; } };
  const recovery = generationRecovery('video', view, storage, { create: async () => initial, get: async () => finished });
  await recovery.start(request()); await recovery.poll(initial.id);
  assert.equal(node.videoSrc, url); assert.equal(node.imageSrc, undefined);
  recovery.apply({ ...finished, revision: 2, artifacts: ['old.mp4'] }); assert.equal(node.videoSrc, url);
});

test('H3 dimensions, native duration and audio numbering are visible and deterministic', () => {
  assert.deepEqual(videoDimensions('480p', '16:9'), { width: 864, height: 480 });
  assert.deepEqual(videoDimensions('720p', '16:9'), { width: 1280, height: 736 });
  assert.deepEqual(videoDimensions('1080p', '9:16'), { width: 1088, height: 1920 });
  assert.equal(videoFrameCount(7), 175);
  assert.deepEqual(referenceLabels([ref('audio'), ref('video'), ref('image'), ref('video', 1, false)]),
    ['<Audio 2>', '<Video 1> · <Audio 1>', '<Picture 1>', '<Video 2>']);
});

test('short video references trim paired audio to the same valid H3 frame count', t => {
  const { config } = setup(t); const snapshot = { model: config.models[1], connection: config.connections[0] };
  const uploaded = { ...ref('video'), fileName: 'api/short.mp4', duration: 1 };
  const graph = JSON.parse(submission(snapshot, { ...request([ref('video')]).input, seed: 42 }, [uploaded]).workflow);
  const loader = graph[graph['136'].inputs['ref_videos.ref_video_0'][0]];
  assert.equal(loader.inputs.frame_load_cap, 22);
  assert.deepEqual(graph['136'].inputs['ref_video_audios.ref_video_audio_0'], [graph['136'].inputs['ref_videos.ref_video_0'][0], 2]);
});

test('real reference bytes are probed and limits reject mismatches, redirects and unbounded bodies', async () => {
  const { readFileSync } = require('node:fs');
  const path = require('node:path');
  const { inspectReference, readReferenceBody, validReferenceUrl } = require('../lib/generation/reference-files.ts');
  const video = readFileSync(path.join(__dirname, 'fixtures/h3/reference.mp4'));
  const image = readFileSync(path.join(__dirname, 'fixtures/h3/reference.png'));
  const audio = readFileSync(path.join(__dirname, 'fixtures/h3/reference.wav'));
  assert.equal((await inspectReference(video, 'clip.mp4', 'video')).hasAudio, true);
  assert.equal((await inspectReference(image, 'picture.png', 'image')).hasAudio, false);
  assert.equal((await inspectReference(audio, 'voice.wav', 'audio')).hasAudio, true);
  await assert.rejects(inspectReference(video, 'fake.png', 'image'), /类型不符/);
  await assert.rejects(inspectReference(Buffer.from('broken'), 'broken.mp4', 'video'), /无法解码/);
  await assert.rejects(readReferenceBody(new Response('small', { headers: { 'content-length': String(31 * 1024 * 1024) } })), /30 MB/);
  await assert.rejects(readReferenceBody(new Response(new Uint8Array(31 * 1024 * 1024))), /30 MB/);
  assert.equal(validReferenceUrl('https://h3-test.oss-cn-hangzhou.aliyuncs.com.evil.test/file.png'), false);
  assert.equal(validReferenceUrl(origin + '/file.png?redirect=http://localhost'), false);
});

test('importing a canvas preserves connected reference order and video sound choices under new node IDs', () => {
  const { remapReferenceIds } = require('../lib/generation/video.ts');
  assert.deepEqual(remapReferenceIds(['node:video', 'upload', 'node:image'], { 'node:video': false }, new Map([['video', 'new-video'], ['image', 'new-image']])),
    { videoReferenceOrder: ['node:new-video', 'upload', 'node:new-image'], videoReferenceAudio: { 'node:new-video': false } });
});

test('deleting a node while its reference is being prepared cancels before the paid boundary', async t => {
  const { service } = setup(t); const io = mockIO(); let release;
  const task = service.create(request([ref('image')]));
  const worker = new GenerationWorker(service, { ...io, inspectReference: async () => {
    await new Promise(resolve => release = resolve); return { hasAudio: false };
  } });
  t.after(() => worker.close());
  const preparing = worker.tick();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  service.deleteNode('canvas', 'video'); release(); await preparing;
  assert.equal(service.get(task.id).status, 'cancelled'); assert.equal(io.submits.length, 0); assert.equal(io.uploads.length, 0);
});


test('a reference upload exceeding the control API timeout still reaches generation once', async t => {
  const { service } = setup(t);
  const deadlines = new WeakMap();
  t.mock.method(AbortSignal, 'timeout', ms => {
    const signal = new AbortController().signal; deadlines.set(signal, ms); return signal;
  });
  const task = service.create(request([ref('image')]));
  const io = mockIO();
  const worker = new GenerationWorker(service, { ...io, fetch: async (url, init) => {
    if (url.endsWith('/upload') && deadlines.get(init.signal) <= 45_000)
      throw new DOMException('upload exceeded deadline', 'TimeoutError');
    return io.fetch(url, init);
  } });
  t.after(() => worker.close());
  await worker.tick();
  assert.equal(service.get(task.id).status, 'running', service.get(task.id).error);
  assert.equal(io.submits.length, 1);
});

test('another worker cannot reclaim a reference upload that is still within its transfer budget', async t => {
  const { service } = setup(t); let now = Date.now();
  const task = service.create(request([ref('image')]));
  const io = mockIO(); let release;
  const one = new GenerationWorker(service, { ...io, now: () => now, fetch: async (url, init) => {
    if (url.endsWith('/upload')) await new Promise(resolve => release = resolve);
    return io.fetch(url, init);
  } });
  const two = new GenerationWorker(service, { ...io, now: () => now });
  t.after(() => { one.close(); two.close(); });
  const inFlight = one.tick();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  now += 90_000;
  const reclaimed = await two.tick();
  release(); await inFlight;
  assert.equal(reclaimed, false, 'live media upload must retain its lease');
  assert.equal(service.get(task.id).status, 'running');
  assert.equal(io.uploads.length, 1); assert.equal(io.submits.length, 1);
});

test('reference failures identify the stage without storing credentials or signed addresses', async t => {
  for (const [stage, fail, expected] of [
    ['upload', () => { throw new DOMException('test-secret https://private.test?token=hidden', 'TimeoutError'); }, /上传.*超时/],
    ['upload', () => new Response('test-secret', { status: 403 }), /上传.*HTTP 403/],
    ['download', () => { throw new DOMException('test-secret', 'TimeoutError'); }, /下载.*超时/],
  ]) {
    const { service, db } = setup(t); const io = mockIO();
    const task = service.create(request([ref('image')]));
    const worker = new GenerationWorker(service, { ...io, fetch: async (url, init) => {
      if ((stage === 'upload' && url.endsWith('/upload')) || (stage === 'download' && url.startsWith(origin))) return fail();
      return io.fetch(url, init);
    } });
    t.after(() => worker.close());
    await worker.tick();
    assert.match(service.get(task.id).error, expected);
    assert.equal(io.submits.length, 0);
    const diagnostics = db.prepare('SELECT response FROM generation_diagnostics WHERE task_id=?').all(task.id);
    assert.equal(diagnostics.length, 1);
    assert.equal(JSON.parse(diagnostics[0].response).stage, 'reference_' + stage);
    assert.ok(!JSON.stringify(diagnostics).includes('test-secret'));
    assert.ok(!JSON.stringify(diagnostics).includes('private.test'));
    assert.ok(!JSON.stringify(diagnostics).includes('hidden'));
  }
});
