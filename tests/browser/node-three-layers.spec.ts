import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

async function openCanvas(page: Page, request: APIRequestContext, data: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  expect((await request.put(`/api/workflow/${id}`, { data: {
    id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: '节点三层验收', nodes: [
      { id: 'image', type: 'textToImage', position: { x: 420, y: 180 }, data: {
        type: 'textToImage', label: '文生图', model: 'BananaPro', prompt: '一朵花', ...data } },
      { id: 'text', type: 'text', position: { x: 30, y: 180 }, data: { type: 'text', label: '文本', prompt: '花园' } },
    ], edges: [{ id: 'input', source: 'text', target: 'image', sourceHandle: 'output', targetHandle: 'input' }],
    viewport: { x: 0, y: 0, zoom: 1 } },
  } })).ok()).toBeTruthy();
  await page.goto(`/?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  return page.locator('.react-flow__node[data-id="image"]');
}

test('节点工具栏和节点控制台只在单选且未拖动时显示，连接点和连线保持稳定', async ({ page, request }) => {
  const node = await openCanvas(page, request);
  const toolbar = page.getByRole('toolbar', { name: '节点工具栏' });
  const panel = page.getByRole('region', { name: '节点控制台' });
  await expect(toolbar).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  const before = await node.boundingBox();
  const handle = node.locator('[data-handleid="input"]');
  const handleBefore = await handle.boundingBox();
  const edge = page.locator('.react-flow__edge-path');
  const edgeBefore = await edge.getAttribute('d');
  await node.click();
  await expect(toolbar).toBeVisible();
  await expect(panel).toBeVisible();
  expect(await node.boundingBox()).toEqual(before);
  expect(await handle.boundingBox()).toEqual(handleBefore);
  expect(await edge.getAttribute('d')).toBe(edgeBefore);
  for (const name of ['预览', '下载', '保存为角色']) await expect(toolbar.getByRole('button', { name, exact: true })).toBeDisabled();
  await page.locator('.react-flow__node[data-id="text"]').click({ modifiers: ['Shift'] });
  await expect(toolbar).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  await page.mouse.click(950, 650);
  await node.click();
  await expect(panel).toBeVisible();
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 120, { steps: 5 });
  await expect(toolbar).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  await page.mouse.up();
  await expect(toolbar).toBeVisible();
  await expect(panel).toBeVisible();
  await page.mouse.click(950, 650);
  await expect(toolbar).toHaveCount(0);
  await expect(panel).toHaveCount(0);
});

const result = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#718bb8"/></svg>').toString('base64')}`;

test('节点工具栏提供预览、下载和保存为角色，图片上不再有悬浮按钮', async ({ page, request }) => {
  const node = await openCanvas(page, request, { imageSrc: result });
  await node.getByRole('img', { name: 'Generated' }).hover();
  for (const name of ['预览', '下载', '保存为角色']) await expect(page.getByTestId('image-preview').getByTitle(name)).toHaveCount(0);
  await node.click();
  const toolbar = page.getByRole('toolbar', { name: '节点工具栏' });
  await toolbar.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.locator('body > div.fixed img[alt="Generated"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('body > div.fixed img[alt="Generated"]')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await toolbar.getByRole('button', { name: '下载', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^image-\d+\.png$/);
  await toolbar.getByRole('button', { name: '保存为角色', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '保存为角色' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '保存为角色' })).toHaveCount(0);
  await expect(toolbar).toBeVisible();
});

test('在节点控制台内点击、拖选和滚动不会移动节点或画布', async ({ page, request }) => {
  const node = await openCanvas(page, request, { error: '一段可以选中的错误信息' });
  await node.click();
  const panel = page.getByRole('region', { name: '节点控制台' });
  const position = await node.boundingBox();
  const transform = () => page.locator('.react-flow__viewport').getAttribute('style');
  const viewport = await transform();
  const message = panel.getByRole('alert');
  const box = (await message.boundingBox())!;
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 240, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()?.toString())).toContain('错误信息');
  await page.mouse.wheel(0, 300);
  await panel.getByRole('textbox').click();
  expect(await node.boundingBox()).toEqual(position);
  expect(await transform()).toBe(viewport);
  await expect(panel).toBeVisible();
});

test('配置和运行按钮在同一行，只显示当前模型支持的配置', async ({ page, request }) => {
  const node = await openCanvas(page, request);
  await node.click();
  const panel = page.getByRole('region', { name: '节点控制台' });
  const middle = async (name: string, role: 'button' | 'combobox' = 'button') => {
    const box = (await panel.getByRole(role, { name, exact: true }).boundingBox())!;
    return box.y + box.height / 2;
  };
  const run = await middle('生成');
  expect(await middle('生图模型', 'combobox')).toBeCloseTo(run, 0);
  expect(await middle('图像设置')).toBeCloseTo(run, 0);
  await expect(panel.getByRole('button', { name: '提示词优化' })).toBeVisible();
  await panel.getByRole('combobox', { name: '生图模型' }).selectOption('runninghub-krea2');
  await expect(panel.getByRole('button', { name: '提示词优化' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '图像设置' })).toContainText('16:9');
});

test('节点控制台保留运行状态、错误、任务恢复和重试保存，生成中节点展示区显示进度', async ({ page, request }) => {
  const node = await openCanvas(page, request, { error: '生成失败', generationStatus: '排队中', generationTaskId: 'missing-task',
    generationBlocked: true, generationCanRetrySave: true, isLoading: true });
  await page.route('**/api/generation/tasks/missing-task', route => route.abort());
  await expect(page.getByTestId('image-preview').getByText('生成中...').or(page.getByTestId('image-preview').locator('.animate-spin'))).not.toHaveCount(0);
  await node.click();
  const panel = page.getByRole('region', { name: '节点控制台' });
  await expect(panel.getByRole('button', { name: '继续查询原任务' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '重试保存（不重新生成）' })).toBeVisible();
  await expect(panel.getByRole('status')).not.toBeEmpty();
  await expect(panel.getByRole('alert')).not.toBeEmpty();
});
