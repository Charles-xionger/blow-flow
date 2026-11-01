import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

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
      const panel = page.getByTestId('image-generation-panel');
      await expect(panel).toBeVisible();
      const nodeBox = await node.boundingBox();
      const previewBox = await page.getByTestId('image-preview').boundingBox();
      expect(nodeBox!.height).toBeCloseTo(previewBox!.height, 0);
      expect(nodeBox!.width).toBeCloseTo(previewBox!.width, 0);
      const panelBox = await panel.boundingBox();
      expect(panelBox!.width / zoom).toBeCloseTo(400, 0);
      expect(panelBox!.y - nodeBox!.y - nodeBox!.height).toBeCloseTo(16 * zoom, 0);
      if (zoom === 1.75) await page.screenshot({ path: testInfo.outputPath(`${data.type ?? data.model}-attached.png`), animations: 'disabled' });
      geometries.push({ width: panelBox!.width, gap: panelBox!.y - nodeBox!.y - nodeBox!.height });
    }
    expect(geometries[1].width).toBeCloseTo(geometries[0].width, 0);
    expect(geometries[2].width).toBeCloseTo(geometries[0].width, 0);
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
    const settings = page.getByRole('button', { name: '图像设置' });
    await settings.click();
    const dialog = page.getByRole('dialog', { name: '图像设置' });
    await expect(dialog.getByRole('button', { name: '自定义', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: '2K', exact: true }).click();
    await dialog.getByRole('button', { name: '16:9', exact: true }).click();
    const resolution = type === 'textToImage' ? '2k' : '2048x2048';
    await expect.poll(async () => (await read()).resolution).toBe(resolution);
    await expect.poll(async () => (await read()).aspectRatio).toBe('16:9');
    await expect.poll(async () => { const box = await page.getByTestId('image-preview').boundingBox(); return box!.width / box!.height; }).toBeCloseTo(16 / 9, 1);
    await page.keyboard.press('Escape');
    await expect(settings).toContainText('2K · 16:9');
    if (type === 'textToImage') {
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await expect.poll(() => submitted?.resolution).toBe('2k');
      expect(submitted?.aspectRatio).toBe('16:9');
    }
  });
}

test('Krea2 size presets persist actual dimensions and keep the preview proportional', async ({ page, request }, testInfo) => {
  const { read } = await openCanvas(page, request);
  const settings = page.getByRole('button', { name: '图像设置' });
  await expect(settings).toContainText('自定义 · 16:9');
  await expect(page.getByText('1920 × 1080 px', { exact: true })).toBeVisible();
  await settings.click();
  const dialog = page.getByRole('dialog', { name: '图像设置' });
  await dialog.getByRole('button', { name: '2K', exact: true }).click();
  await expect(dialog.getByText('实际生成尺寸：3640 × 2048 px', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '9:16', exact: true }).click();
  await expect.poll(async () => [(await read()).generationWidth, (await read()).generationHeight]).toEqual([2048, 3640]);
  const surface = page.getByTestId('image-preview');
  await expect.poll(async () => { const box = await surface.boundingBox(); return box!.height / box!.width; }).toBeCloseTo(3640 / 2048, 1);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(settings).toBeFocused();
  await page.reload();
  await page.locator('.react-flow__node').click();
  await expect(settings).toContainText('2K · 9:16');
  await expect(page.getByText('2048 × 3640 px', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '亮色', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('krea2-node.png'), animations: 'disabled' });
  await settings.click();
  await page.screenshot({ path: testInfo.outputPath('krea2-panel.png'), animations: 'disabled' });
});

test('the floating panel and size settings stay usable in a narrow viewport', async ({ page, request }) => {
  await page.setViewportSize({ width: 760, height: 540 });
  await openCanvas(page, request);
  const panel = page.getByTestId('image-generation-panel');
  await expect.poll(async () => { const box = await panel.boundingBox(); return box!.x + box!.width; }).toBeLessThanOrEqual(744);
  await expect.poll(async () => { const box = await panel.boundingBox(); return box!.y + box!.height; }).toBeLessThanOrEqual(524);
  await page.getByRole('button', { name: '图像设置' }).click();
  const dialog = page.getByRole('dialog', { name: '图像设置' });
  await dialog.getByRole('button', { name: '2K', exact: true }).click();
  await expect.poll(async () => { const box = await dialog.boundingBox(); return box!.y + box!.height; }).toBeLessThanOrEqual(524);
  await dialog.getByRole('button', { name: '21:9', exact: true }).click();
  await expect(dialog.getByText('实际生成尺寸：4776 × 2048 px', { exact: true })).toBeVisible();
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
  await expect(page.getByText('1008 × 1200 px', { exact: true })).toBeVisible();
});
