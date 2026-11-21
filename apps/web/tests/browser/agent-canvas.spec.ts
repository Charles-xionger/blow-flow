import { test, expect, type APIRequestContext } from '@playwright/test';

async function seedImageCanvas(request: APIRequestContext) {
  const id = crypto.randomUUID();
  const response = await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: '助手实时同步', nodes: [{ id: 'image', type: 'textToImage', position: { x: 200, y: 80 }, style: { width: 320, height: 240 },
      data: { type: 'textToImage', label: 'Image', model: 'runninghub-krea2', usesGenerationTasks: true, generationWidth: 1920, generationHeight: 1080 } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } });
  await expect(response, 'seed canvas').toBeOK();
  return id;
}

async function sendAgent(request: APIRequestContext, id: string, text: string, references: { nodeId: string; name: string }[] = []) {
  const response = await request.post(`/api/agent/${id}`, { data: { action: 'send', requestId: crypto.randomUUID(), modelId: 'browser-fixture', text, references } });
  await expect(response, 'submit assistant task').toBeOK();
  const task = await response.json() as { id: string };
  return task.id;
}

async function readCanvas(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/workflow/${id}`);
  await expect(response, 'read saved canvas').toBeOK();
  return (await response.json()).data;
}

async function waitForAgentTask(request: APIRequestContext, projectId: string, taskId: string) {
  await expect.poll(async () => {
    const response = await request.get(`/api/agent/${projectId}`);
    await expect(response, 'read assistant tasks').toBeOK();
    const { tasks } = await response.json() as { tasks: { id: string; status: string }[] };
    return tasks.find(task => task.id === taskId)?.status;
  }, { message: 'assistant task completes' }).toBe('completed');
}

test('Agent edits update an open parameter console and undo and redo survive reload', async ({ page, request }) => {
  // A cold Next.js build consumes part of this test's budget before the assistant can run.
  test.setTimeout(75_000);
  const id = await seedImageCanvas(request);
  await page.goto(`/canvas?project=${id}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.react-flow__node').click();
  await expect(page.getByRole('combobox', { name: '生图模型' })).toContainText('Krea2');
  await page.getByRole('button', { name: '图像设置', exact: true }).click();
  await expect(page.getByLabel('生成宽度')).toHaveValue('1920');
  // Send through the public task API while keeping the console open.
  const taskId = await sendAgent(request, id, '测试画布编辑', [{ nodeId: 'image', name: '图像' }]);
  await waitForAgentTask(request, id, taskId);
  await expect(page.getByLabel('生成宽度')).toHaveValue('1024');
  await expect(page.getByLabel('生成高度')).toHaveValue('1024');
  await page.getByRole('button', { name: '图像设置', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  const savedSize = async () => {
    const { generationWidth, generationHeight } = (await readCanvas(request, id)).nodes[0].data;
    return [generationWidth, generationHeight];
  };
  await expect.poll(savedSize, { message: 'undo is saved before reload' }).toEqual([1920, 1080]);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(savedSize).toEqual([1024, 1024]);
});

test('Agent finishes while the canvas is closed and the result survives an offline reload', async ({ page, request, context }) => {
  const id = await seedImageCanvas(request);
  await page.goto(`/canvas?project=${id}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  const createTaskId = await sendAgent(request, id, '测试新建节点 在后台完成');
  await page.close();
  await waitForAgentTask(request, id, createTaskId);
  const reopened = await context.newPage();
  await reopened.goto(`/canvas?project=${id}`, { waitUntil: 'domcontentloaded' });
  await expect(reopened.locator('.react-flow__node')).toHaveCount(3);
  const saved = await readCanvas(request, id);
  expect(saved.nodes[0].position).toEqual({ x: 200, y: 80 });
  const [a, b] = saved.nodes.slice(1);
  expect(Math.abs(a.position.x - b.position.x) >= 320 || Math.abs(a.position.y - b.position.y) >= 240).toBeTruthy();
  const layoutTaskId = await sendAgent(request, id, '测试局部整理');
  await waitForAgentTask(request, id, layoutTaskId);
  expect((await readCanvas(request, id)).nodes[0].position).toEqual({ x: 200, y: 80 });
  await expect(reopened.getByTestId('canvas-save-status')).toHaveText('已同步');
  // Keep the development app shell reachable while the persistence network is unavailable.
  await reopened.route('**/api/workflow/**', route => route.abort());
  await reopened.reload({ waitUntil: 'domcontentloaded' });
  await expect(reopened.locator('.react-flow__node')).toHaveCount(3);
  await reopened.unroute('**/api/workflow/**');
});

test('an idle canvas keeps one change stream without repeated snapshot reads', async ({ page, request }) => {
  const id = crypto.randomUUID();
  await expect(await request.post('/api/workspace', { data: { action: 'create-project', id, folderId: null } })).toBeOK();
  const reads: string[] = [];
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === `/api/workflow/${id}`) reads.push(request.url());
  });
  await page.goto(`/canvas?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.waitForTimeout(2000);
  reads.length = 0;
  await page.waitForTimeout(3500);
  expect(reads).toHaveLength(0);
  // Reconnecting must receive the latest version even if the assistant panel is closed.
  const taskId = await sendAgent(request, id, '测试新建节点 在后台完成');
  await waitForAgentTask(request, id, taskId);
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
});
