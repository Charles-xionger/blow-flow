import { test, expect } from '@playwright/test';
import sharp from 'sharp';

const original = async () => 'data:image/png;base64,' + (await sharp({ create: { width: 3000, height: 1500, channels: 4, background: '#a04b8d80' } }).png().toBuffer()).toString('base64');

test('old project displays bounded previews while full viewing and persisted material retain the original', async ({ page, request }) => {
  const src = await original();
  const id = crypto.randomUUID();
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: {
    name: 'preview integration', nodes: [{ id: 'original', type: 'originalImage', position: { x: 400, y: 180 }, data: { type: 'originalImage', label: '原图', imageSrc: src } }],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  } } });
  await page.goto(`/?project=${id}`);
  const node = page.locator('.react-flow__node[data-id="original"]');
  const image = node.getByAltText('Uploaded image');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])).toEqual([1024, 512]);
  await node.click();
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const full = page.locator('body > div.fixed img');
  await expect(full).toHaveAttribute('src', src);
  await expect.poll(() => full.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(3000);
  await page.keyboard.press('Escape');
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + 90, box.y + 90); await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 130, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await (await request.get(`/api/workflow/${id}`)).json()).data.nodes[0].position.x).toBeGreaterThan(400);
  expect((await (await request.get(`/api/workflow/${id}`)).json()).data.nodes[0].data.imageSrc).toBe(src);
});

test('failed preview keeps geometry, offers retry, and requests original only on explicit viewing', async ({ page, request }) => {
  const src = 'https://unreadable-preview.test/original.png';
  const id = crypto.randomUUID(); let originalRequests = 0; let attempts = 0;
  const bytes = await sharp({ create: { width: 40, height: 20, channels: 4, background: 'red' } }).webp().toBuffer();
  await page.route(src, route => { originalRequests++; return route.fulfill({ body: bytes, contentType: 'image/webp' }); });
  await page.route('**/api/canvas-preview?**', route => {
    attempts++;
    return attempts === 1 ? route.fulfill({ status: 422, body: '{}' }) : route.fulfill({ contentType: 'image/webp', body: bytes });
  });
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: {
    name: 'preview failure', nodes: [{ id: 'original', type: 'originalImage', position: { x: 400, y: 180 }, data: { type: 'originalImage', label: '原图', imageSrc: src } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  } } });
  await page.goto(`/?project=${id}`);
  const node = page.locator('.react-flow__node[data-id="original"]');
  await expect(node.getByText('预览不可用')).toBeVisible();
  const size = await node.boundingBox();
  expect(originalRequests).toBe(0);
  await node.getByRole('button', { name: '查看原图 Uploaded image' }).click();
  await expect.poll(() => originalRequests).toBe(1);
  await page.keyboard.press('Escape');
  await node.getByRole('button', { name: '重试预览 Uploaded image' }).click();
  await expect(node.getByAltText('Uploaded image')).toBeVisible();
  expect(await node.boundingBox()).toEqual(size);
});

test('replacing an original never presents its previous preview while the replacement is loading', async ({ page, request }) => {
  const id = crypto.randomUUID();
  const first = 'https://preview-fixture.test/first.png';
  const second = 'https://preview-fixture.test/second.png';
  const bytes = await sharp({ create: { width: 40, height: 20, channels: 4, background: 'red' } }).webp().toBuffer();
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/canvas-preview?**', async route => {
    if (new URL(route.request().url()).searchParams.get('src') === second) await pending;
    await route.fulfill({ contentType: 'image/webp', body: bytes });
  });
  await page.route('**/api/upload/image', route => route.fulfill({ json: { success: true, data: { url: second } } }));
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: {
    name: 'preview replacement', nodes: [{ id: 'original', type: 'originalImage', position: { x: 400, y: 180 }, data: { type: 'originalImage', label: '原图', imageSrc: first } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  } } });
  await page.goto(`/?project=${id}`);
  const node = page.locator('.react-flow__node[data-id="original"]');
  await expect.poll(() => node.getByAltText('Uploaded image').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(40);
  await node.click();
  await node.locator('input[type=file]').setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: bytes });
  await expect(node.getByAltText('Uploaded image')).toHaveAttribute('src', new RegExp(encodeURIComponent(second)));
  await expect(node.getByText('预览加载中…')).toBeVisible();
  expect(await node.getByAltText('Uploaded image').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(0);
  release();
  await expect.poll(() => node.getByAltText('Uploaded image').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(40);
});

test('first preview click on a generated image stays open while the uncached original loads', async ({ page, request }) => {
  const id = crypto.randomUUID();
  const src = 'https://preview-fixture.test/cold-generated.png';
  const bytes = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: 'tan' } }).png().toBuffer();
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(src, async route => { await pending; await route.fulfill({ contentType: 'image/png', body: bytes }); });
  await page.route('**/api/canvas-preview?**', route => route.fulfill({ contentType: 'image/png', body: bytes }));
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: {
    name: 'cold generated preview', nodes: [{ id: 'generated', type: 'textToImage', position: { x: 400, y: 180 }, data: { type: 'textToImage', label: '图片', model: 'BananaPro', imageSrc: src } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  } } });
  await page.goto(`/canvas?project=${id}`);
  await page.locator('.react-flow__node[data-id="generated"]').click();
  await page.getByRole('button', { name: '预览', exact: true }).click();
  try {
    await expect(page.getByRole('status').filter({ hasText: '正在加载原图' })).toBeVisible();
  } finally { release(); }
  const full = page.locator('body > div.fixed img');
  await expect.poll(() => full.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(2048);
  await expect(full).toBeVisible();
  const bounds = (await full.boundingBox())!;
  expect(bounds.width).toBeGreaterThan(100);
  expect(bounds.height).toBeGreaterThan(100);
  await page.keyboard.press('Escape');
  await expect(full).toHaveCount(0);
});
