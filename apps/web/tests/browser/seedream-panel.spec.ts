import { test, expect } from '@playwright/test';

test('Seedream exposes official size presets and persists advanced options in both image entry points', async ({ page, request }) => {
  await page.route('**/api/generation/models', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: (await response.json()).map((model: Record<string, unknown>) => ({ ...model, configured: true })) });
  });
  for (const type of ['textToImage', 'imageToImage']) {
    const id = crypto.randomUUID();
    const response = await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
      snapshot: { name: 'Seedream 参数', nodes: [{ id: 'image', type, position: { x: 400, y: 80 }, style: { width: 320, height: 240 },
        data: { type, label: 'Seedream', model: 'doubao-seedream-5-0-pro-260628', usesGenerationTasks: true, prompt: '雨夜街景' } }], edges: [], viewport: { x: -200, y: 0, zoom: 1 } } } });
    expect(response.ok()).toBeTruthy();
    await page.goto(`/?project=${id}`);
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
    await page.locator('.react-flow__node').click();
    await expect(page.getByRole('combobox', { name: '生图模型' }).locator('option[value="doubao-seedream-5-5-261028"]')).toHaveText('Seedream 5.5');
    if (type === 'imageToImage') await expect(page.getByRole('combobox', { name: '生图模型' }).locator('option[value="runninghub-krea2"]')).toHaveCount(0);
    await page.getByRole('button', { name: '图像设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '图像设置' });
    await dialog.getByRole('button', { name: '1.5K', exact: true }).click();
    await dialog.getByRole('button', { name: '16:9', exact: true }).click();
    await dialog.getByText('高级设置', { exact: true }).click();
    await dialog.getByLabel('图片格式').selectOption('jpeg');
    await dialog.getByLabel('提示词优化').selectOption('fast');
    await dialog.getByLabel('可见水印').check();
    await expect(dialog.getByLabel('透明背景')).toBeDisabled();
    await page.keyboard.press('Escape');
    const read = async () => (await (await request.get(`/api/workflow/${id}`)).json()).data.nodes[0].data;
    await expect.poll(async () => (await read()).imageOptions).toMatchObject({ outputFormat: 'jpeg', promptOptimization: 'fast', watermark: true });
    await expect.poll(async () => [(await read()).generationWidth, (await read()).generationHeight, (await read()).generationSizePreset, (await read()).aspectRatio]).toEqual([2048,1152,'1.5k','16:9']);
    await page.reload(); await page.locator('.react-flow__node').click();
    await expect(page.getByRole('button', { name: '图像设置', exact: true })).toContainText('1.5K · 16:9');
  }
});

test('switching Seedream versions resets incompatible options and 5.5 offers native transparency', async ({ page, request }) => {
  await page.route('**/api/generation/models', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: (await response.json()).map((model: Record<string, unknown>) => ({ ...model, configured: true })) });
  });
  const id = crypto.randomUUID();
  const response = await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'Seedream 版本切换', nodes: [{ id: 'image', type: 'textToImage', position: { x: 400, y: 80 },
      data: { type: 'textToImage', label: 'Seedream', model: 'doubao-seedream-5-0-pro-260628', usesGenerationTasks: true,
        prompt: '透明玻璃花瓶', imageOptions: { outputFormat: 'png', watermark: false, promptOptimization: 'fast', background: 'opaque' } } }],
      edges: [], viewport: { x: -200, y: 0, zoom: 1 } } } });
  expect(response.ok()).toBeTruthy();
  await page.goto(`/?project=${id}`);
  await page.locator('.react-flow__node').click();
  await page.getByRole('combobox', { name: '生图模型' }).selectOption('doubao-seedream-5-5-261028');
  await page.getByRole('button', { name: '图像设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '图像设置' });
  await dialog.getByText('高级设置', { exact: true }).click();
  await expect(dialog.getByLabel('提示词优化').locator('option')).toHaveCount(1);
  await expect(dialog.getByLabel('提示词优化')).toHaveValue('standard');
  await expect(dialog.getByLabel('透明背景')).toBeEnabled();
  await dialog.getByLabel('透明背景').check();
  await expect(dialog.getByText('可原生生成透明背景，输出格式为 PNG。')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: '生图模型' }).selectOption('doubao-seedream-5-0-pro-260628');
  await page.getByRole('button', { name: '图像设置', exact: true }).click();
  const advanced = dialog.getByText('高级设置', { exact: true });
  if (await advanced.getAttribute('aria-expanded') !== 'true') await advanced.click();
  await expect(dialog.getByLabel('提示词优化')).toHaveValue('standard');
  await expect(dialog.getByLabel('透明背景')).not.toBeChecked();
  await expect(dialog.getByLabel('透明背景')).toBeDisabled();
});

test('reference upload, ordering and prompt numbering reach the frozen generation request', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.route('**/api/generation/models', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: (await response.json()).map((model: Record<string, unknown>) => ({ ...model, configured: true })) });
  });
  const origin = 'https://browser-fixture.oss-test.aliyuncs.com';
  await page.route('**/api/upload/reference', route => route.fulfill({ json: { kind: 'image', url: `${origin}/uploaded.png`, hasAlpha: true } }));
  await page.route(`${origin}/**`, route => route.fulfill({ status: 404 }));
  let submitted: { input: { prompt: string; references: { url: string }[]; imageOptions: Record<string, unknown> } } | undefined;
  await page.route('**/api/generation/tasks', route => {
    if (route.request().method() !== 'POST') return route.continue();
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: '已捕获生成请求' } });
  });
  const id = crypto.randomUUID();
  const response = await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'Seedream 参考图', nodes: [
      { id: 'source', type: 'originalImage', position: { x: -500, y: 0 }, data: { type: 'originalImage', label: '来源', imageSrc: `${origin}/connected.png` } },
      { id: 'image', type: 'imageToImage', position: { x: 400, y: 80 }, style: { width: 320, height: 240 },
        data: { type: 'imageToImage', label: 'Seedream', model: 'doubao-seedream-5-0-pro-260628', usesGenerationTasks: true, prompt: [{ text: '合成' }, { ref: 'source' }] } },
    ], edges: [{ id: 'source-image', source: 'source', target: 'image' }], viewport: { x: -200, y: 0, zoom: 1 } } } });
  expect(response.ok()).toBeTruthy();
  await page.goto(`/?project=${id}`);
  await page.locator('[data-id="image"]').click();
  await page.getByLabel('上传参考图片', { exact: true }).setInputFiles({ name: 'alpha.png', mimeType: 'image/png', buffer: Buffer.from('fake-upload') });
  await expect(page.getByRole('button', { name: '上移图片2' })).toBeEnabled();
  await page.getByRole('button', { name: '上移图片2' }).click();
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => submitted?.input.references.map(ref => ref.url)).toEqual([`${origin}/uploaded.png`, `${origin}/connected.png`]);
  expect(submitted?.input.prompt).toBe('合成图片2');
  expect(submitted?.input.imageOptions).toMatchObject({ outputFormat: 'png', watermark: false });
  await page.getByRole('button', { name: '移除图片2' }).click();
  await page.getByRole('button', { name: '图像设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '图像设置' });
  await dialog.getByText('高级设置', { exact: true }).click();
  await expect(dialog.getByLabel('透明背景')).toBeEnabled();
  await dialog.getByLabel('透明背景').check();
  await page.screenshot({ path: testInfo.outputPath('seedream-advanced.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '移除图片1' }).click();
  await page.getByRole('button', { name: '图像设置', exact: true }).click();
  await expect(dialog.getByLabel('透明背景')).toBeEnabled();
  await dialog.getByLabel('透明背景').uncheck();
  await expect(dialog.getByLabel('透明背景')).toBeDisabled();
});
