require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createPreviewCache } = require('../lib/canvas-preview/server.ts');
const picture = async (width, height, background = '#ff000080') => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
const source = bytes => 'data:image/png;base64,' + bytes.toString('base64');

test('canvas previews constrain both axes, preserve transparency and never enlarge small originals', async () => {
  const cache = createPreviewCache();
  for (const [width, height, expected] of [[2400, 1200, [1024, 512]], [1200, 2400, [512, 1024]], [20, 4000, [5, 1024]], [32, 16, [32, 16]]]) {
    const preview = await cache.get(source(await picture(width, height)));
    const metadata = await sharp(preview.bytes).metadata();
    assert.deepEqual([metadata.width, metadata.height], expected);
    assert.equal(metadata.hasAlpha, true);
    assert.equal(metadata.format, 'webp');
  }
});

test('previews use the oriented static first frame, reject corrupt or unreadable sources without original fallback', async () => {
  const cache = createPreviewCache();
  const rotated = await sharp(await picture(2000, 1000)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const orientation = await sharp((await cache.get(source(rotated))).bytes).metadata();
  assert.deepEqual([orientation.width, orientation.height], [512, 1024]);
  const frames = Buffer.concat([Buffer.alloc(4 * 4 * 3, 0), Buffer.alloc(4 * 4 * 3, 255)]);
  const gif = await sharp(frames, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  const preview = await cache.get('data:image/gif;base64,' + gif.toString('base64'));
  const metadata = await sharp(preview.bytes).metadata();
  assert.equal(metadata.pages ?? 1, 1);
  assert.equal(metadata.height, 4);
  assert.ok((await sharp(preview.bytes).stats()).channels.every(c => c.mean < 5));
  for (const url of ['https://example.com/a.png', 'http://127.0.0.1/a', 'file:///etc/passwd', '/a.png', 'blob:abc', source(Buffer.from('broken'))])
    await assert.rejects(cache.get(url));
});

test('remote preview requests coalesce, revalidate replacements, and rebuild after eviction or clearing', async () => {
  process.env.OSS_BUCKET_NAME = 'preview-test'; process.env.OSS_REGION = 'oss-cn-test';
  const url = 'https://preview-test.oss-cn-test.aliyuncs.com/image.png';
  let bytes = await picture(1200, 600); let version = 'one'; let calls = 0;
  const requests = [];
  const cache = createPreviewCache({ fetch: async (_url, init) => {
    calls++; requests.push(init);
    await new Promise(resolve => setTimeout(resolve, 10));
    if (init.headers['If-None-Match'] === version) return new Response(null, { status: 304 });
    return new Response(bytes, { headers: { etag: version } });
  } });
  const results = await Promise.all(Array.from({ length: 12 }, () => cache.get(url)));
  assert.equal(calls, 1);
  assert.ok(results.every(result => result === results[0]));
  assert.equal((await cache.get(url)).etag, results[0].etag);
  assert.equal(requests[1].headers['If-None-Match'], 'one');
  bytes = await picture(600, 1200); version = 'two';
  const changed = await cache.get(url);
  assert.notEqual(changed.etag, results[0].etag);
  assert.equal((await sharp(changed.bytes).metadata()).height, 1024);
  cache.clear();
  assert.equal((await cache.get(url)).etag, changed.etag);
  assert.deepEqual(requests.at(-1).headers, {});
  assert.ok(requests.every(r => r.redirect === 'error'));
  const evicting = createPreviewCache({ cacheBytes: 1 });
  assert.deepEqual((await evicting.get(source(bytes))).bytes, (await evicting.get(source(bytes))).bytes);
  for (const bad of [url + '?x=1', url + '#x', url.replace('https:', 'http:'), url.replace('preview-test.', 'other.'), url.replace('image.png', '')])
    await assert.rejects(cache.get(bad));
});

test('different originals have bounded concurrency, failures retry, and oversized streams stop early', async () => {
  process.env.OSS_BUCKET_NAME = 'preview-test'; process.env.OSS_REGION = 'oss-cn-test';
  let active = 0; let peak = 0; let fail = true;
  const bytes = await picture(32, 32);
  const cache = createPreviewCache({ fetch: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    if (fail) return new Response(null, { status: 500 });
    return new Response(bytes);
  } });
  const url = 'https://preview-test.oss-cn-test.aliyuncs.com/';
  await assert.rejects(cache.get(url + 'retry'));
  fail = false;
  await Promise.all(Array.from({ length: 8 }, (_, i) => cache.get(url + i)));
  assert.equal(peak, 2);
  await cache.get(url + 'retry');
  const large = createPreviewCache({ fetch: async () => new Response(bytes, { headers: { 'content-length': String(31 * 1024 * 1024) } }) });
  await assert.rejects(large.get(url + 'large'));
});

test('saturated preview queues reject extra work and become available again; evicted entries drop validators', async () => {
  process.env.OSS_BUCKET_NAME = 'preview-test'; process.env.OSS_REGION = 'oss-cn-test';
  const { previewLimits } = require('../lib/canvas-preview/server.ts');
  const bytes = await picture(32, 32);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = createPreviewCache({ fetch: async () => { await gate; return new Response(bytes); } });
  const origin = 'https://preview-test.oss-cn-test.aliyuncs.com/';
  const jobs = Array.from({ length: previewLimits.pending }, (_, i) => cache.get(origin + i));
  await assert.rejects(cache.get(origin + 'overflow'), /繁忙/);
  release(); await Promise.all(jobs);
  await cache.get(origin + 'overflow');
  const headers = [];
  const evicting = createPreviewCache({ cacheBytes: 1, fetch: async (_url, init) => {
    headers.push(init.headers); return new Response(bytes, { headers: { etag: 'v1' } });
  } });
  await evicting.get(origin + 'one'); await evicting.get(origin + 'one');
  assert.deepEqual(headers, [{}, {}]);
});
