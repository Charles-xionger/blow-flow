import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import sharp from 'sharp';

async function openCanvas(page: Page, request: APIRequestContext, data: Record<string, unknown> = {}, zoom = 1) {
  const id = crypto.randomUUID();
  const response = await request.put(`/api/workflow/${id}`, { data: {
    id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'Krea2 面板验收', nodes: [{ id: 'image-node', type: data.type ?? 'textToImage',
      position: { x: 400, y: 100 }, style: { width: 320, height: 240 }, data: { type: 'textToImage', label: 'Text to Image',
        model: 'runninghub-krea2', usesGenerationTasks: true, ...data } }],
      edges: [], viewport: { x: -200, y: 0, zoom } },
  } });
  expect(response.ok()).toBeTruthy();
  await page.goto(`/?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.locator('.react-flow__node').click();
  return { id, read: async () => (await (await request.get(`/api/workflow/${id}`)).json()).data.nodes[0].data };
}

const panelOf = (page: Page) => page.getByRole('region', { name: '节点控制台' });

test('image models share attached panel sizing and spacing at every canvas zoom', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.addInitScript(() => localStorage.setItem('canvas-theme', 'dark'));
  for (const zoom of [1, 1.75]) {
    const geometries: { width: number; gap: number }[] = [];
    for (const data of [
      { model: 'runninghub-krea2', usesGenerationTasks: true },
      { model: 'BananaPro', usesGenerationTasks: false },
      { model: 'BananaPro', usesGenerationTasks: false, type: 'imageToImage' },
    ]) {
      await openCanvas(page, request, data, zoom);
      const node = page.locator('.react-flow__node');
      const panel = panelOf(page);
      await expect(panel).toBeVisible();
      const nodeBox = await node.boundingBox();
      const previewBox = await page.getByTestId('image-preview').boundingBox();
      expect(nodeBox!.width / zoom).toBeCloseTo(320, 0);
      expect(nodeBox!.height / zoom).toBeCloseTo(240, 0);
      expect(nodeBox!.height).toBeCloseTo(previewBox!.height, 0);
      expect(nodeBox!.width).toBeCloseTo(previewBox!.width, 0);
      const panelBox = await panel.boundingBox();
      expect(panelBox!.width / zoom).toBeCloseTo(440, 0);
      expect(panelBox!.y - nodeBox!.y - nodeBox!.height).toBeCloseTo(12 * zoom, 0);
      if (zoom === 1.75) await page.screenshot({ path: testInfo.outputPath(`${data.type ?? data.model}-attached.png`), animations: 'disabled' });
      geometries.push({ width: panelBox!.width, gap: panelBox!.y - nodeBox!.y - nodeBox!.height });
    }
    for (const geometry of geometries) {
      expect(geometry.width).toBeCloseTo(geometries[0].width, 0);
      expect(geometry.gap).toBeCloseTo(geometries[0].gap, 0);
    }
  }
});

for (const type of ['textToImage', 'imageToImage']) {
  test(`${type} uses the shared size controls without changing its API parameter values`, async ({ page, request }) => {
    let submitted: { aspectRatio: string; resolution: string } | undefined;
    await page.route('**/api/generate/image', async route => {
      submitted = route.request().postDataJSON();
      await route.fulfill({ status: 400, json: { success: false, error: '测试已捕获参数' } });
    });
    const { read } = await openCanvas(page, request, { type, model: 'BananaPro', usesGenerationTasks: false, prompt: '一朵花' });
    const previewBefore = await page.getByTestId('image-preview').boundingBox();
    const settings = page.getByRole('button', { name: '图像设置' });
    await settings.click();
    const dialog = page.getByRole('dialog', { name: '图像设置' });
    await expect(dialog.getByRole('button', { name: '自定义', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: '2K', exact: true }).click();
    await dialog.getByRole('button', { name: '16:9', exact: true }).click();
    const resolution = type === 'textToImage' ? '2k' : '2048x2048';
    await expect.poll(async () => (await read()).resolution).toBe(resolution);
    await expect.poll(async () => (await read()).aspectRatio).toBe('16:9');
    expect(await page.getByTestId('image-preview').boundingBox()).toEqual(previewBefore);
    await page.keyboard.press('Escape');
    await expect(settings).toContainText('2K · 16:9');
    if (type === 'textToImage') {
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await expect.poll(() => submitted?.resolution).toBe('2k');
      expect(submitted?.aspectRatio).toBe('16:9');
    }
  });
}

for (const data of [
  { type: 'textToImage', model: 'runninghub-krea2', usesGenerationTasks: true },
  { type: 'textToImage', model: 'BananaPro', usesGenerationTasks: false },
  { type: 'imageToImage', model: 'BananaPro', usesGenerationTasks: false },
]) {
  test(`${data.model} ${data.type} changing image dimensions keeps the node and controls stable`, async ({ page, request }) => {
    await page.setViewportSize({ width: 760, height: 540 });
    const { id } = await openCanvas(page, request, data);
    const node = page.locator('.react-flow__node');
    const panel = panelOf(page);
    const output = node.locator('[data-handleid="output"]');
    const read = async () => (await (await request.get(`/api/workflow/${id}`)).json()).data;
    await page.getByRole('button', { name: '图像设置' }).click();
    const before = await node.boundingBox();
    const panelBefore = await panel.boundingBox();
    const outputBefore = await output.boundingBox();
    const original = await read();
    const dialog = page.getByRole('dialog', { name: '图像设置' });
    for (const preset of ['1K', '2K']) {
      await dialog.getByRole('button', { name: preset, exact: true }).click();
      for (const ratio of ['16:9', '9:16', '1:1']) {
        await dialog.getByRole('button', { name: ratio, exact: true }).click();
        await expect(dialog.getByRole('button', { name: ratio, exact: true })).toHaveAttribute('aria-pressed', 'true');
        expect(await node.boundingBox()).toEqual(before);
        expect(await panel.boundingBox()).toEqual(panelBefore);
        expect(await output.boundingBox()).toEqual(outputBefore);
      }
    }
    await expect.poll(async () => {
      const saved = (await read()).nodes[0].data;
      return data.usesGenerationTasks ? saved.generationHeight === 2048 : saved.aspectRatio === '1:1';
    }).toBe(true);
    expect((await read()).nodes[0].position).toEqual(original.nodes[0].position);
    expect((await read()).viewport).toEqual(original.viewport);
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
    await node.click();
    expect(await node.boundingBox()).toEqual(before);
    expect(await panel.boundingBox()).toEqual(panelBefore);
  });
}

test('Krea2 size presets persist actual dimensions without resizing or adding labels to the node', async ({ page, request }, testInfo) => {
  const { read } = await openCanvas(page, request);
  const settings = page.getByRole('button', { name: '图像设置' });
  await expect(settings).toContainText('自定义 · 16:9');
  await expect(page.getByText('1920 × 1080 px', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/输入提示词开始创作|选中节点开始创作|仅文生图 · 不支持参考图/)).toHaveCount(0);
  const previewBefore = await page.getByTestId('image-preview').boundingBox();
  await settings.click();
  const dialog = page.getByRole('dialog', { name: '图像设置' });
  await dialog.getByRole('button', { name: '2K', exact: true }).click();
  await expect.poll(async () => [(await read()).generationWidth, (await read()).generationHeight]).toEqual([3640, 2048]);
  await dialog.getByRole('button', { name: '9:16', exact: true }).click();
  await expect.poll(async () => [(await read()).generationWidth, (await read()).generationHeight]).toEqual([2048, 3640]);
  expect(await page.getByTestId('image-preview').boundingBox()).toEqual(previewBefore);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(settings).toBeFocused();
  await page.reload();
  await page.locator('.react-flow__node').click();
  await expect(settings).toContainText('2K · 9:16');
  await expect(page.getByText('2048 × 3640 px', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '亮色', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('krea2-node.png'), animations: 'disabled' });
  await settings.click();
  await page.screenshot({ path: testInfo.outputPath('krea2-panel.png'), animations: 'disabled' });
});

test('the floating panel and size settings stay usable in a narrow viewport', async ({ page, request }) => {
  await page.setViewportSize({ width: 760, height: 540 });
  const { read } = await openCanvas(page, request);
  const panel = panelOf(page);
  await expect.poll(async () => { const box = await panel.boundingBox(); return box!.x + box!.width; }).toBeLessThanOrEqual(744);
  await expect.poll(async () => { const box = await panel.boundingBox(); return box!.y + box!.height; }).toBeLessThanOrEqual(524);
  await page.getByRole('button', { name: '图像设置' }).click();
  const dialog = page.getByRole('dialog', { name: '图像设置' });
  await dialog.getByRole('button', { name: '2K', exact: true }).click();
  await expect.poll(async () => { const box = await dialog.boundingBox(); return box!.y + box!.height; }).toBeLessThanOrEqual(524);
  await dialog.getByRole('button', { name: '21:9', exact: true }).click();
  await expect.poll(async () => [(await read()).generationWidth, (await read()).generationHeight]).toEqual([4776, 2048]);
});

test('landscape and portrait results fit inside the stable image node without cropping', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const data of [
    { type: 'textToImage', model: 'runninghub-krea2', usesGenerationTasks: true, width: 900, height: 1600 },
    { type: 'textToImage', model: 'BananaPro', usesGenerationTasks: false, width: 1600, height: 900 },
    { type: 'imageToImage', model: 'BananaPro', usesGenerationTasks: false, width: 900, height: 1600 },
  ]) {
    const { width, height, ...model } = data;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#718bb8"/><rect x="20" y="20" width="${width - 40}" height="${height - 40}" fill="none" stroke="#ffd28a" stroke-width="20"/><circle cx="${width / 2}" cy="${height / 2}" r="200" fill="#ffd28a"/></svg>`;
    const imageSrc = `data:image/png;base64,${(await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64')}`;
    await openCanvas(page, request, { ...model, imageSrc });
    const surface = page.getByTestId('image-preview');
    const image = surface.getByRole('img', { name: 'Generated' });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => ({ width: element.naturalWidth, height: element.naturalHeight })))
      .toEqual(width > height ? { width: 1024, height: 576 } : { width: 576, height: 1024 });
    await expect(image).toHaveCSS('object-fit', 'contain');
    const before = await surface.boundingBox();
    expect(before).toMatchObject({ width: 320, height: 240 });
    await page.getByRole('button', { name: '图像设置' }).click();
    const dialog = page.getByRole('dialog', { name: '图像设置' });
    await dialog.getByRole('button', { name: '2K', exact: true }).click();
    await dialog.getByRole('button', { name: '9:16', exact: true }).click();
    await page.keyboard.press('Escape');
    expect(await surface.boundingBox()).toEqual(before);
    await expect(image).toHaveAttribute('src', /^blob:/);
    await page.mouse.move(1100, 800);
    await page.screenshot({ path: testInfo.outputPath(`${model.model}-${model.type}-contained.png`), animations: 'disabled' });
  }
});

test('custom size input preserves old pixels, commits on blur, and submits the displayed dimensions', async ({ page, request }) => {
  await page.route('**/api/generation/models', async route => {
    const response = await route.fetch();
    const models = await response.json();
    await route.fulfill({ json: models.map((model: Record<string, unknown>) => ({ ...model, configured: true })) });
  });
  let submitted: { input: { width: number; height: number; prompt: string } } | undefined;
  await page.route('**/api/generation/tasks', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { error: '测试已捕获提交参数' } });
  });
  const { read } = await openCanvas(page, request, { generationWidth: 1000, generationHeight: 1080, prompt: '一朵花' });
  const settings = page.getByRole('button', { name: '图像设置' });
  await expect(settings).toContainText('自定义 · 25:27');
  await settings.click();
  const dialog = page.getByRole('dialog', { name: '图像设置' });
  const width = dialog.getByRole('spinbutton', { name: '生成宽度' });
  const height = dialog.getByRole('spinbutton', { name: '生成高度' });
  await expect(width).toHaveValue('1000');
  await expect(height).toHaveValue('1080');
  await width.fill('1001');
  await width.press('Enter');
  await expect(width).toHaveValue('1000');
  await expect(dialog.getByRole('status')).toContainText('宽已调整为 1000 px');
  await height.fill('');
  await height.press('Tab');
  await expect(height).toHaveValue('1080');
  await width.fill('1007');
  await dialog.getByRole('button', { name: '关闭图像设置' }).click();
  await expect.poll(async () => (await read()).generationWidth).toBe(1008);
  await settings.click();
  await height.fill('1201');
  // Clicking outside must commit the focused input before the generation click reads it.
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => submitted?.input).toEqual({ width: 1008, height: 1200, prompt: '一朵花' });
  await settings.click();
  await expect.poll(async () => [(await read()).generationWidth, (await read()).generationHeight]).toEqual([1008, 1200]);
});
