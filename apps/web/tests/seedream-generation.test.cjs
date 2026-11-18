require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateImage } = require('../lib/generation/image-adapters.ts');
const { seedreamImageConfig } = require('../lib/generation/seedream.ts');
const snapshot = (id = 'doubao-seedream-5-0-pro-260628') => { const config = seedreamImageConfig(); return { model: config.models.find(model => model.id === id), connection: config.connections[0] }; };
process.env.ARK_API_KEY = 'test-ark-key';
const input = { prompt: '雨夜街景', width: 2816, height: 1584 };

test('image function maps Seedream defaults to the official single-image endpoint at the paid boundary', async () => {
  process.env.ARK_API_KEY = 'test-ark-key';
  let authorized = false;
  const result = await generateImage(snapshot(), input, {
    beforeSubmit: () => { authorized = true; },
    fetch: async (url, init) => {
      assert.equal(authorized, true);
      assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
      assert.equal(init.headers.Authorization, 'Bearer test-ark-key');
      assert.deepEqual(JSON.parse(init.body), { model: 'doubao-seedream-5-0-pro-260628', prompt: '雨夜街景', size: '2816x1584',
        response_format: 'url', output_format: 'png', watermark: false, background: 'opaque', optimize_prompt_options: { mode: 'standard' } });
      return Response.json({ data: [{ url: 'https://result.test/image.png' }] });
    },
  });
  assert.deepEqual(result, ['https://result.test/image.png']);
});

test('Seedream 5.5 is listed with its official model ID and native transparency capabilities', async () => {
  const config = seedreamImageConfig();
  assert.deepEqual(config.models.map(model => [model.id, model.name]), [
    ['doubao-seedream-5-5-261028', 'Seedream 5.5'],
    ['doubao-seedream-5-0-pro-260628', 'Seedream 5.0 Pro'],
  ]);
  const model = config.models[0];
  assert.equal(model.capabilities.image.maxImages, 10);
  assert.deepEqual(model.capabilities.image.options.promptOptimizations, ['standard']);
  assert.equal(model.capabilities.image.options.transparentBackgroundPolicy, 'native');
  let body;
  const result = await generateImage(snapshot(model.id), { ...input, imageOptions: { background: 'transparent' } }, {
    beforeSubmit() {},
    fetch: async (_url, init) => { body = JSON.parse(init.body); return Response.json({ data: [{ url: 'https://result.test/native-alpha.png' }] }); },
  });
  assert.equal(body.model, 'doubao-seedream-5-5-261028');
  assert.equal(body.background, 'transparent');
  assert.deepEqual(result, ['https://result.test/native-alpha.png']);
  await assert.rejects(generateImage(snapshot(model.id), { ...input, imageOptions: { promptOptimization: 'fast' } }, {
    beforeSubmit() { assert.fail('unsupported options must fail before submission'); }, fetch: async () => assert.fail(),
  }), /不支持/);
});

test('image function preserves ordered references and advanced settings, validating transparency before submitting', async () => {
  const sharp = require('sharp');
  process.env.OSS_BUCKET_NAME = 'test'; process.env.OSS_REGION = 'oss-test';
  const origin = 'https://test.oss-test.aliyuncs.com';
  const transparent = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  let submissions = 0;
  const fetcher = async (url, init) => {
    if (url.startsWith(origin)) return new Response(transparent, { headers: { 'Content-Type': 'image/png' } });
    submissions++;
    const body = JSON.parse(init.body);
    assert.deepEqual(body.image, [`${origin}/second.png`, `${origin}/first.png`]);
    assert.equal(body.watermark, true); assert.equal(body.output_format, 'jpeg');
    assert.equal(body.optimize_prompt_options.mode, 'fast');
    return Response.json({ data: [{ url: 'https://result.test/image.jpeg' }] });
  };
  await generateImage(snapshot(), { ...input, references: ['second', 'first'].map(name => ({ kind: 'image', url: `${origin}/${name}.png` })),
    imageOptions: { outputFormat: 'jpeg', watermark: true, promptOptimization: 'fast' } }, { beforeSubmit() {}, fetch: fetcher });
  assert.equal(submissions, 1);
  let authorized = false;
  await assert.rejects(generateImage(snapshot(), { ...input, imageOptions: { background: 'transparent' } }, {
    beforeSubmit() { authorized = true; }, fetch: fetcher,
  }), /透明/);
  assert.equal(authorized, false);
  const result = await generateImage(snapshot(), { ...input, references: [{ kind: 'image', url: `${origin}/alpha.png` }], imageOptions: { background: 'transparent' } }, {
    beforeSubmit() { authorized = true; }, fetch: async (url, init) => {
      if (url.startsWith(origin)) return new Response(transparent);
      assert.equal(JSON.parse(init.body).background, 'transparent');
      return Response.json({ data: [{ url: 'https://result.test/alpha.png' }] });
    },
  });
  assert.equal(authorized, true); assert.equal(result[0], 'https://result.test/alpha.png');
});

function setup(t) {
  process.env.ARK_API_KEY = 'test-ark-key';
  const Database = require('better-sqlite3');
  const { GenerationService } = require('../lib/generation/service.ts');
  const db = new Database(':memory:');
  t.after(() => db.close());
  return new GenerationService(db, seedreamImageConfig());
}
const request = (id = 'one', changes = {}) => ({ requestId: id, canvasId: 'canvas', nodeId: 'node',
  modelId: 'doubao-seedream-5-0-pro-260628', input: { ...input, ...changes } });

test('Seedream tasks persist options and retry saving original artifacts without regenerating', async t => {
  const service = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  let submissions = 0; let saved = false;
  const worker = new GenerationWorker(service, {
    fetch: async () => assert.fail('must not use RunningHub transport'),
    imageFetch: async () => { submissions++; return Response.json({ data: [{ url: 'https://result.test/image.png' }] }); },
    save: async url => { assert.equal(url, 'https://result.test/image.png'); if (!saved) throw Error('storage unavailable'); return 'https://oss.test/final.png'; },
  });
  t.after(() => worker.close());
  const task = service.create(request('one', { imageOptions: { watermark: true, promptOptimization: 'fast' } }));
  assert.equal(task.input.imageOptions.watermark, true);
  await worker.tick();
  assert.equal(service.get(task.id).status, 'succeeded'); assert.equal(service.get(task.id).saveStatus, 'failed');
  saved = true; service.retrySave(task.id); await worker.tick();
  assert.equal(service.get(task.id).saveStatus, 'saved'); assert.equal(submissions, 1);
  assert.throws(() => service.create(request('bad', { width: 512, height: 512 })), /尺寸/);
  assert.throws(() => service.create(request('bad-options', { imageOptions: { seed: 42 } })), /高级设置/);
  assert.throws(() => service.create(request('bad-alpha', { imageOptions: { background: 'transparent' } })), /透明/);
});

test('definitive rejections release slots; ambiguous responses stay uncertain and never auto-resubmit', async t => {
  const service = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  for (const [id, response, expected] of [
    ['denied', () => Response.json({ error: { message: 'test-ark-key' } }, { status: 401 }), 'failed'],
    ['limited', () => new Response('', { status: 429 }), 'failed'],
    ['lost', () => { throw Error('socket lost'); }, 'uncertain'],
    ['server', () => new Response('', { status: 500 }), 'uncertain'],
    ['malformed', () => Response.json({ data: [{ url: 'javascript:bad' }] }), 'uncertain'],
  ]) {
    let calls = 0;
    const worker = new GenerationWorker(service, { fetch: async () => assert.fail(), imageFetch: async () => { calls++; return response(); }, save: async () => assert.fail() });
    const task = service.create(request(id));
    await worker.tick(); await worker.tick();
    assert.equal(service.get(task.id).status, expected, id);
    assert.equal(calls, 1); assert.ok(!JSON.stringify(service.get(task.id)).includes('test-ark-key'));
    worker.close();
  }
});

test('the production runner fills five independent Seedream slots and starts the sixth after one finishes', async t => {
  const service = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  const { runGenerationWorker } = require('../lib/generation/runner.ts');
  const controller = new AbortController();
  const pending = [];
  const worker = new GenerationWorker(service, { fetch: async () => assert.fail(), imageFetch: () => new Promise(resolve => pending.push(resolve)), save: async () => 'https://oss.test/final.png' });
  const tasks = Array.from({ length: 6 }, (_, i) => service.create(request(`parallel-${i}`)));
  const run = runGenerationWorker(worker, { parallelism: 6, signal: controller.signal, idleMs: 5, onError: error => { throw error; } });
  try {
    assert.equal(pending.length, 5);
    assert.equal(service.get(tasks[5].id).status, 'queued');
    pending[0](Response.json({ data: [{ url: 'https://result.test/one.png' }] }));
    const deadline = Date.now() + 1000;
    while (pending.length < 6 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(pending.length, 6);
  } finally {
    controller.abort();
    for (const resolve of pending) resolve(Response.json({ data: [{ url: 'https://result.test/final.png' }] }));
    await run; worker.close();
  }
  assert.equal(tasks.filter(task => service.get(task.id).saveStatus === 'saved').length, 6);
});

test('JPEG selection is preserved in the saved artifact name and MIME type', async t => {
  const service = setup(t);
  const { GenerationWorker } = require('../lib/generation/worker.ts');
  const { createGenerationImageSaver } = require('../lib/generation/storage.ts');
  const save = createGenerationImageSaver({ fetch: async () => new Response('jpeg-bytes', { headers: { 'content-type': 'image/jpeg' } }),
    publicUrl: key => `https://oss.test/${key}`, client: {
      head: async () => { throw { status: 404 }; },
      put: async (key, _bytes, options) => { assert.match(key, /\.jpeg$/); assert.equal(options.headers['Content-Type'], 'image/jpeg'); },
    } });
  const worker = new GenerationWorker(service, { fetch: async () => assert.fail(), imageFetch: async () => Response.json({ data: [{ url: 'https://result.test/image' }] }), save });
  t.after(() => worker.close());
  const task = service.create(request('jpeg-output', { imageOptions: { outputFormat: 'jpeg' } }));
  await worker.tick();
  assert.equal(service.get(task.id).saveStatus, 'saved');
  assert.match(service.get(task.id).artifacts[0], /\.jpeg$/);
});

test('same-protocol image models use their configured capabilities and semantic Gemini configuration ignores key order', t => {
  const Database = require('better-sqlite3');
  const { GenerationService } = require('../lib/generation/service.ts');
  const config = structuredClone(seedreamImageConfig());
  const model = config.models[0];
  model.id = 'another-ark-image'; model.providerModel = 'another-ark-model';
  model.capabilities.image.maxImages = 2;
  model.capabilities.image.sizes = ['1K'];
  model.capabilities.image.presets = model.capabilities.image.presets.filter(p => p.size === '1K');
  model.capabilities.dimensions.defaultWidth = 1024; model.capabilities.dimensions.defaultHeight = 1024;
  const db = new Database(':memory:'); t.after(() => db.close());
  const service = new GenerationService(db, config);
  assert.equal(service.models()[0].capabilities.image.maxImages, 2);
  assert.equal(service.create({ ...request('alternate'), modelId: model.id, input: { prompt: 'cat', width: 1024, height: 1024 } }).status, 'queued');
  const { geminiImageConfig } = require('../lib/generation/gemini-image');
  const gemini = geminiImageConfig();
  const cap = gemini.models[0].capabilities;
  gemini.models[0].capabilities = { image: cap.image, dimensions: Object.fromEntries(Object.entries(cap.dimensions).reverse()), referenceImages: cap.referenceImages, prompt: cap.prompt };
  assert.doesNotThrow(() => new GenerationService(db, gemini));
});
