import { test, expect } from '@playwright/test';

test('Agent edits update an open parameter console, undo across reload, and finish while closed', async ({ page, request, context }) => {
  const id = crypto.randomUUID();
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: '助手实时同步', nodes: [{ id: 'image', type: 'textToImage', position: { x: 200, y: 80 }, style: { width: 320, height: 240 },
      data: { type: 'textToImage', label: 'Image', model: 'runninghub-krea2', usesGenerationTasks: true, generationWidth: 1920, generationHeight: 1080 } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } });
  await page.goto(`/canvas?project=${id}`);
  await page.locator('.react-flow__node').click();
  await expect(page.getByRole('combobox', { name: '生图模型' })).toContainText('Krea2');
  await page.getByRole('button', { name: '图像设置', exact: true }).click();
  await expect(page.getByLabel('生成宽度')).toHaveValue('1920');
  // Send through the public task API while keeping the console open.
  await request.post(`/api/agent/${id}`, { data: { action: 'send', requestId: crypto.randomUUID(), modelId: 'browser-fixture', text: '测试画布编辑', references: [{ nodeId: 'image', name: '图像' }] } });
  await expect(page.getByLabel('生成宽度')).toHaveValue('1024');
  await expect(page.getByLabel('生成高度')).toHaveValue('1024');
  await page.getByRole('button', { name: '图像设置', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.reload();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/api/workflow/${id}`)).json()).data.nodes[0].data.generationWidth).toBe(1024);
  await request.post(`/api/agent/${id}`, { data: { action: 'send', requestId: crypto.randomUUID(), modelId: 'browser-fixture', text: '测试新建节点 在后台完成' } });
  await page.close();
  await expect.poll(async () => (await (await request.get(`/api/workflow/${id}`)).json()).data.nodes.length).toBe(3);
  const reopened = await context.newPage();
  await reopened.goto(`/canvas?project=${id}`);
  await expect(reopened.locator('.react-flow__node')).toHaveCount(3);
  const saved = (await (await request.get(`/api/workflow/${id}`)).json()).data;
  expect(saved.nodes[0].position).toEqual({ x: 200, y: 80 });
  const [a, b] = saved.nodes.slice(1);
  expect(Math.abs(a.position.x - b.position.x) >= 320 || Math.abs(a.position.y - b.position.y) >= 240).toBeTruthy();
  await request.post(`/api/agent/${id}`, { data: { action: 'send', requestId: crypto.randomUUID(), modelId: 'browser-fixture', text: '测试局部整理' } });
  await expect.poll(async () => (await (await request.get(`/api/agent/${id}`)).json()).tasks.at(-1).status).toBe('completed');
  expect((await (await request.get(`/api/workflow/${id}`)).json()).data.nodes[0].position).toEqual({ x: 200, y: 80 });
  await expect(reopened.getByTestId('canvas-save-status')).toHaveText('已同步');
  // Keep the development app shell reachable while the persistence network is unavailable.
  await reopened.route('**/api/workflow/**', route => route.abort());
  await reopened.reload();
  await expect(reopened.locator('.react-flow__node')).toHaveCount(3);
  await reopened.unroute('**/api/workflow/**');
});
