// Run after: NEXT_PUBLIC_CANVAS_PERF_EXPERIMENT=1 NEXT_TEST_DIST=.next-canvas-perf pnpm build
// CANVAS_PERF_PROJECT must name an exported, read-only project snapshot. All writes go to a temporary DB.
const { chromium } = require('@playwright/test');
const { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, createWriteStream } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');
const { performance } = require('node:perf_hooks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = 'http://127.0.0.1:3218';
const output = resolve(process.env.CANVAS_PERF_OUTPUT || '.scratch/canvas-drag-performance/measurements');
mkdirSync(output, { recursive: true });
const source = JSON.parse(readFileSync(process.env.CANVAS_PERF_PROJECT, 'utf8'));
const original = source.nodes.find(n => n.type === 'originalImage' && n.data.imageSrc);
if (!original) throw Error('Snapshot needs an original image connected to H3');
const dir = mkdtempSync(join(tmpdir(), 'canvas-performance-'));
const results = [];
let server;
let browser;

async function start() {
  const log = createWriteStream(join(output, 'server.log'), { flags: 'a' });
  const mode = process.env.CANVAS_PERF_MODE === 'dev' ? 'dev' : 'start';
  server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), mode, '--hostname', '127.0.0.1', '--port', '3218'], {
    env: { ...process.env, DATABASE_PATH: join(dir, 'canvas.db'), NEXT_TEST_DIST: '.next-canvas-perf', NEXT_PUBLIC_CANVAS_PERF_EXPERIMENT: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(log); server.stderr.pipe(log);
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw Error('Performance server exited; see server.log');
    try { if ((await fetch(base + '/api/generation/models')).ok) return; } catch {}
    await sleep(500);
  }
  throw Error('Performance server did not start');
}
async function stop() {
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); const force = setTimeout(() => server.kill('SIGKILL'), 2000); await exited; clearTimeout(force); }
}
function snapshot() {
  const result = structuredClone(source);
  result.name = 'Isolated canvas performance';
  // Keep the real graph, materials and viewport; remove all resumable generation identity.
  for (const node of result.nodes) {
    node.selected = false;
    for (const key of Object.keys(node.data)) if (/generation|pending|taskId/i.test(key)) delete node.data[key];
    node.data.isLoading = false;
  }
  return result;
}
async function traceStart(cdp) {
  await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', categories: 'devtools.timeline,blink.user_timing,cc,viz,benchmark,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame' });
}
async function traceEnd(cdp, filename) {
  const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  const { stream } = await complete;
  let raw = '';
  for (;;) { const chunk = await cdp.send('IO.read', { handle: stream }); raw += chunk.data; if (chunk.eof) break; }
  await cdp.send('IO.close', { handle: stream });
  writeFileSync(join(output, filename + '.json.gz'), gzipSync(raw));
  const events = JSON.parse(raw).traceEvents;
  const start = events.find(e => e.name === 'canvas:drag-start')?.ts ?? 0;
  const end = events.find(e => e.name === 'canvas:drag-end')?.ts ?? Infinity;
  const interaction = events.filter(e => e.ts >= start && e.ts <= end);
  const thread = events.find(e => e.name === 'thread_name' && e.args?.name === 'CrRendererMain' && events.some(m => m.name === 'canvas:drag-start' && m.pid === e.pid));
  const tasks = interaction.filter(e => e.name === 'RunTask' && e.pid === thread?.pid && e.tid === thread?.tid && e.dur > 50_000).map(e => e.dur / 1000);
  const sum = pattern => interaction.filter(e => pattern.test(e.name) && e.dur).reduce((sum, e) => sum + e.dur / 1000, 0);
  const frames = interaction.filter(e => e.name === 'Display::FrameDisplayed');
  const frameTimes = [...new Set(frames.map(e => e.ts))].sort((a,b) => a-b);
  const gaps = frameTimes.slice(1).map((t,i) => (t-frameTimes[i])/1000);
  return { durationMs: (end-start)/1000, longTasksMs: tasks, decodeMs: sum(/^Decode Image$/), commitWaitMs: sum(/^LayerTreeHost::WaitForCommitCompletion$/),
    presentedFrames: frameTimes.length, presentedGapMaxMs: gaps.length ? Math.max(...gaps) : null,
    frameEvidence: frames.length ? [...new Set(frames.map(e => e.name))] : 'No presentation events exposed; do not infer FPS from rAF',
    videoContentRenders: interaction.filter(e => e.name === 'canvas:video-content-render').length,
  };
}
async function drag(page) {
  const node = page.locator(`.react-flow__node[data-id="${original.id}"]`);
  const box = await node.boundingBox();
  if (!box || box.x < 0 || box.y < 0) throw Error('Original is outside the fixed viewport');
  const x = box.x + 100, y = box.y + 100;
  await page.mouse.move(x,y);
  await page.evaluate(() => performance.mark('canvas:drag-start'));
  await page.mouse.down();
  const begin = performance.now();
  for (let i = 1; i <= 120; i++) {
    const angle = 2 * Math.PI * i / 120;
    await page.mouse.move(x + 100 * Math.sin(angle), y + 50 * (1 - Math.cos(angle)));
    await sleep(Math.max(0, begin + i * 33 - performance.now()));
  }
  await page.mouse.up();
  await page.evaluate(() => performance.mark('canvas:drag-end'));
}
async function main() {
  browser = await chromium.launch({ headless: false, channel: 'chromium', args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const configurations = [{ name: 'baseline', preview: 0, subscriptions: 0 }, { name: 'preview', preview: 1, subscriptions: 0 },
    { name: 'subscriptions', preview: 0, subscriptions: 1 }, { name: 'combined', preview: 1, subscriptions: 1 }]
    .filter(c => !process.env.CANVAS_PERF_CONFIG || c.name === process.env.CANVAS_PERF_CONFIG);
  for (const config of configurations) for (let repeat = 1; repeat <= Number(process.env.CANVAS_PERF_REPEATS || 3); repeat++) for (const selected of [false, true]) {
    await start(); // A fresh process owns the cold server cache for each independent run.
    const context = await browser.newContext({ viewport: { width: 1728, height: 1117 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.canvasPreviewLoads = [];
      document.addEventListener('load', event => {
        if (event.target instanceof HTMLImageElement && event.target.closest('[data-canvas-preview]')) {
          window.canvasPreviewLoads.push(performance.now());
          performance.mark('canvas:preview-loaded');
        }
      }, true);
    });
    // Never issue paid generation or resume a real task from the snapshot.
    await page.route('**/api/generation/tasks**', route => route.fulfill({ status: 400, json: { error: 'Performance fixture: generation disabled' } }));
    await page.route('**/api/generate/**', route => route.abort());
    await page.route('**/api/generation/events**', route => route.fulfill({ contentType: 'text/event-stream', body: 'event: snapshot\ndata: []\n\n' }));
    const id = crypto.randomUUID();
    const saved = await context.request.put(base + `/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: snapshot() } });
    if (!saved.ok()) throw Error('Cannot save isolated fixture: ' + await saved.text());
    const cdp = await context.newCDPSession(page);
    await traceStart(cdp);
    const began = performance.now();
    let previewWaitMs;
    let serverTiming;
    let serverCache;
    page.on('response', response => { if (response.url().includes('/api/canvas-preview')) void response.finished().then(() => { previewWaitMs ??= performance.now() - began; serverTiming ??= response.headers()['server-timing']; serverCache ??= response.headers()['x-canvas-preview-cache']; }); });
    await page.goto(base + `/canvas?project=${id}&preview=${config.preview}&subscriptions=${config.subscriptions}`);
    const node = page.locator(`.react-flow__node[data-id="${original.id}"]`);
    await node.waitFor();
    await page.getByTestId('canvas-save-status').filter({ hasText: '已同步' }).waitFor();
    if (!page.url().includes(`preview=${config.preview}`)) throw Error('Experiment flags lost during navigation');
    if (selected) await node.click({ position: { x: 100, y: 100 } });
    await drag(page);
    const label = `${config.name}-${repeat}-${selected ? 'selected' : 'unselected'}`;
    const cold = await traceEnd(cdp, label + '-cold');
    const coldResult = { config: config.name, repeat, selected, cache: 'cold', ...cold };
    results.push(coldResult);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-canvas-preview] img')].length > 0 && [...document.querySelectorAll('[data-canvas-preview] img')].every(img => img.complete && img.naturalWidth > 0));
    Object.assign(coldResult, { previewWaitMs, serverTiming, serverCache,
      imageLoadedAfterNavigationMs: await page.evaluate(() => window.canvasPreviewLoads[0]) });
    await page.mouse.click(80,950);
    if (selected) await node.click({ position: { x: 100, y: 100 } });
    await page.evaluate(() => performance.clearMarks());
    await traceStart(cdp);
    await drag(page);
    results.push({ config: config.name, repeat, selected, cache: 'warm', ...await traceEnd(cdp, label + '-warm') });
    console.log(JSON.stringify(results.slice(-2)));
    writeFileSync(join(output, 'results.json'), JSON.stringify({ mode: process.env.CANVAS_PERF_MODE || 'production', browser: browser.version(), viewport: { width: 1728, height: 1117 }, deviceScaleFactor: 1, results }, null, 2));
    await context.close(); await stop();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await stop(); rmSync(dir, { recursive: true, force: true }); });
