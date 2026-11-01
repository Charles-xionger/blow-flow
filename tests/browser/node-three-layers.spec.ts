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
