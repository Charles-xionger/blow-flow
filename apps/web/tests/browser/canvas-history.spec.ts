import { test, expect } from '@playwright/test';

test('text focus hands off once; undo/redo and drag survive refresh', async ({ page, request }) => {
  const id = crypto.randomUUID();
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'History test', nodes: [{ id: 'text', type: 'text', position: { x: 350, y: 120 },
      data: { type: 'text', label: 'Text', prompt: [{ text: 'before' }] } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } });
  await page.goto(`/canvas?project=${id}`);
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  const redo = page.getByRole('button', { name: '重做', exact: true });
  await expect(undo).toBeDisabled();
  const stage = page.getByTestId('text-content');
  await stage.click();
  const editor = page.getByRole('textbox', { name: '提示词' });
  await editor.click();
  await editor.press('ControlOrMeta+End');
  await editor.pressSequentially(' edited');
  await editor.press('ControlOrMeta+z');
  await page.locator('.react-flow__pane').click({ position: { x: 900, y: 600 } });
  await expect(stage).toHaveText('before');
  await expect(undo).toBeDisabled();
  await stage.click();
  await editor.click();
  await editor.press('ControlOrMeta+End');
  await editor.pressSequentially(' saved');
  await page.locator('.react-flow__pane').click({ position: { x: 900, y: 600 } });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(stage).toHaveText('before');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.reload();
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(stage).toHaveText('before saved');
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 90, { steps: 12 });
  await page.mouse.up();
  await undo.click();
  await expect.poll(async () => Math.round((await stage.boundingBox())!.x)).toBe(Math.round(box.x));
  await expect(stage).toHaveText('before saved');
});

for (const type of ['text', 'group']) test(`${type} resize is one undo step and restores persisted display dimensions`, async ({ page, request }) => {
  const id = crypto.randomUUID();
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'Resize test', nodes: [{ id: 'text', type, style: { width: 320, height: 240 }, position: { x: 350, y: 120 },
      data: { type, label: 'Text' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } });
  await page.goto(`/canvas?project=${id}`);
  const stage = page.locator('.react-flow__node');
  await stage.click();
  const before = (await stage.boundingBox())!;
  const handle = page.locator('.react-flow__resize-control.handle.bottom.right');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 60, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await stage.boundingBox())!.width).toBeGreaterThan(before.width + 50);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => Math.round((await stage.boundingBox())!.width)).toBe(Math.round(before.width));
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.reload();
  await expect.poll(async () => (await stage.boundingBox())!.width).toBeGreaterThan(before.width + 50);
});

test('title and generation parameters undo with keyboard, without reviving an old title draft', async ({ page, request }) => {
  const id = crypto.randomUUID();
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'Parameters', nodes: [{ id: 'video', type: 'textToVideo', position: { x: 350, y: 120 },
      data: { type: 'textToVideo', label: 'Video', customTitle: 'Original title', model: 'Sora 2', aspectRatio: '16:9', duration: '5s' } }],
      edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } });
  await page.goto(`/canvas?project=${id}`);
  await page.getByText('Original title', { exact: true }).dblclick();
  const title = page.locator('.react-flow__node input[type="text"]');
  await title.fill('New title');
  await title.press('Enter');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByText('Original title', { exact: true })).toBeVisible();
  await page.getByText('Original title', { exact: true }).dblclick();
  await expect(title).toHaveValue('Original title');
  await title.press('Escape');
  await page.locator('.react-flow__node').click({ position: { x: 100, y: 100 } });
  const ratio = page.getByLabel('节点控制台').locator('select').last();
  await ratio.selectOption('9:16');
  await page.locator('.react-flow__pane').click({ position: { x: 900, y: 650 } });
  await page.keyboard.press('ControlOrMeta+z');
  await page.locator('.react-flow__node').click({ position: { x: 100, y: 100 } });
  await expect(ratio).toHaveValue('16:9');
  await page.locator('.react-flow__pane').click({ position: { x: 900, y: 650 } });
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await page.locator('.react-flow__node').click({ position: { x: 100, y: 100 } });
  await expect(ratio).toHaveValue('9:16');
});

test('keyboard bulk deletion restores references in one step after refresh', async ({ page, request }) => {
  const id = crypto.randomUUID();
  const nodes = [
    { id: 'source', type: 'text', position: { x: 100, y: 100 }, data: { type: 'text', label: 'Source', customTitle: 'Source', prompt: 'hello' } },
    { id: 'extra', type: 'text', position: { x: 100, y: 430 }, data: { type: 'text', label: 'Extra' } },
    { id: 'target', type: 'textToImage', position: { x: 550, y: 100 }, data: { type: 'textToImage', label: 'Target', prompt: [{ ref: 'source' }] } },
  ];
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'Batch deletion', nodes, edges: [{ id: 'edge', source: 'source', target: 'target' }], viewport: { x: 0, y: 0, zoom: 1 } } } });
  await page.goto(`/canvas?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.locator('[data-id="source"]').click({ position: { x: 15, y: 15 } });
  await page.locator('[data-id="extra"]').click({ modifiers: ['Shift'], position: { x: 15, y: 15 } });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const read = async () => (await (await request.get(`/api/workflow/${id}`)).json()).data;
  expect((await read()).nodes[0].data.prompt).toEqual([{ text: '@Source' }]);
  await page.reload();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect((await read()).nodes.find((node: { id: string }) => node.id === 'target').data.prompt).toEqual([{ ref: 'source' }]);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
});

test('import replays saved identities after reload without reopening the file', async ({ page, request }) => {
  await page.goto('/canvas');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await (await chooser).setFiles({ name: 'batch.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    projectName: 'Imported batch', nodes: [
      { id: 'original', type: 'text', position: { x: 350, y: 120 }, data: { type: 'text', label: 'Text', prompt: 'imported' } },
    ], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  })) });
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const id = new URL(page.url()).searchParams.get('project');
  expect(id).toBeTruthy();
  const read = async () => (await (await request.get(`/api/workflow/${id}`)).json()).data;
  const savedId = (await read()).nodes[0].id;
  expect(savedId).not.toBe('original');
  await page.reload();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.reload();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect((await read()).nodes[0].id).toBe(savedId);
});

test('uploaded media replacement survives undo, redo and reload without uploading again', async ({ page, request }) => {
  const id = crypto.randomUUID();
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'Media history', nodes: [{ id: 'original', type: 'originalImage', position: { x: 350, y: 120 },
      data: { type: 'originalImage', label: 'Original', imageSrc: 'https://oss.test/before.png' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } });
  await page.route('**/api/canvas-preview?**', route => route.fulfill({ path: 'tests/fixtures/h3/reference.png', contentType: 'image/png' }));
  let uploads = 0;
  await page.route('**/api/upload/image', route => { uploads++; return route.fulfill({ json: { success: true, data: { url: 'https://oss.test/after.png' } } }); });
  await page.goto(`/canvas?project=${id}`);
  const node = page.locator('.react-flow__node[data-id="original"]');
  await node.click();
  await node.locator('input[type=file]').setInputFiles('tests/fixtures/h3/reference.png');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  const read = async () => (await (await request.get(`/api/workflow/${id}`)).json()).data.nodes[0].data.imageSrc;
  await expect.poll(async () => {
    const saved = (await (await request.get(`/api/workflow/${id}`)).json()).data;
    return { image: saved.nodes[0].data.imageSrc, redo: saved.history?.redo.length };
  }).toEqual({ image: 'https://oss.test/before.png', redo: 1 });
  await page.reload();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(read).toBe('https://oss.test/after.png');
  expect(uploads).toBe(1);
  await page.route('**/api/canvas-preview?**', route => route.fulfill({ status: 422 }));
  await page.route('https://oss.test/after.png', route => route.abort());
  await page.reload();
  await page.getByRole('button', { name: '查看原图 Uploaded image', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '原始素材已丢失或无法访问' })).toBeVisible();
  expect(await read()).toBe('https://oss.test/after.png');
});

test('undoing queued-task deletion restores existing media and task status without submitting generation', async ({ page, request }) => {
  const id = crypto.randomUUID();
  let status = 'queued';
  let submissions = 0;
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'Task history', nodes: [{ id: 'image', type: 'textToImage', position: { x: 350, y: 120 },
      data: { type: 'textToImage', label: 'Image', model: 'runninghub-krea2', usesGenerationTasks: true,
        prompt: 'garden', imageSrc: 'https://oss.test/previous.png', generationTaskId: 'queued-history-task' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } });
  await page.route('**/api/canvas-preview?**', route => route.fulfill({ path: 'tests/fixtures/h3/reference.png', contentType: 'image/png' }));
  const taskSnapshot = () => ({
    id: 'queued-history-task', requestId: 'queued-history-request', canvasId: id, nodeId: 'image', modelId: 'runninghub-krea2', modelVersion: '1',
    input: { prompt: 'garden', width: 1920, height: 1080 }, status, saveStatus: 'pending', artifacts: [], revision: status === 'queued' ? 0 : 1,
    createdAt: 1, updatedAt: 2, deadline: null, error: null,
  });
  await page.route('**/api/generation/tasks/queued-history-task', route => route.fulfill({ json: taskSnapshot() }));
  await page.route('**/api/generation/events', route => route.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify([taskSnapshot()])}\n\n` }));
  await page.route('**/api/generation/tasks', route => {
    if (route.request().method() === 'POST') submissions++;
    if (route.request().method() === 'DELETE') status = 'cancelled';
    return route.fulfill({ json: { deleted: true } });
  });
  await page.goto(`/canvas?project=${id}`);
  const node = page.locator('.react-flow__node[data-id="image"]');
  await node.click({ position: { x: 15, y: 15 } });
  await page.keyboard.press('Backspace');
  await expect(node).toHaveCount(0);
  await expect.poll(() => status).toBe('cancelled');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await node.click({ position: { x: 15, y: 15 } });
  await expect(page.getByRole('region', { name: '节点控制台' })).toContainText('已取消');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.reload();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(node).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(node).toHaveCount(1);
  expect(submissions).toBe(0);
  await expect.poll(async () => (await (await request.get(`/api/workflow/${id}`)).json()).data.nodes[0]?.data.imageSrc).toBe('https://oss.test/previous.png');
});

test('history view paginates dated batches, traces abandoned redo and stays consistent after reopening', async ({ page, request }) => {
  const id = crypto.randomUUID();
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'History view', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } });
  await page.goto(`/canvas?project=${id}`);
  const rename = async (name: string) => {
    await page.getByTitle('修改项目名称').click();
    const input = page.getByPlaceholder('项目名称...');
    await input.fill(name);
    await input.press('Enter');
  };
  await rename('Abandoned name');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await rename('Current name');
  await page.getByRole('button', { name: '操作历史', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '操作历史' });
  await expect(panel.getByText('已撤销 · 重做分支已失效', { exact: true })).toBeVisible();
  const abandoned = panel.getByTestId('history-batch').filter({ hasText: '重做分支已失效' });
  await abandoned.getByRole('button', { name: '查看批次详情' }).click();
  await expect(abandoned.getByText('项目名称：History view → Abandoned name', { exact: true })).toBeVisible();
  await expect(abandoned.locator('time').first()).toHaveAttribute('datetime', /T/);
  await expect(panel.getByRole('button', { name: /重放|恢复此版本/ })).toHaveCount(0);
  await panel.getByRole('button', { name: '关闭历史' }).click();
  for (let i = 0; i < 21; i++) await rename(`Page name ${i}`);
  await expect.poll(async () => (await (await request.get(`/api/workflow/${id}`)).json()).data?.name).toBe('Page name 20');
  await page.reload();
  await page.getByRole('button', { name: '操作历史', exact: true }).click();
  await expect(panel.getByTestId('history-batch')).toHaveCount(20);
  await panel.getByRole('button', { name: '下一页批次' }).click();
  await expect(panel.getByTestId('history-batch')).toHaveCount(3);
  await expect(panel.getByText('已撤销 · 重做分支已失效', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('history-save-status')).toHaveText('已同步');
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
});

test('history internal edits paginate and offline records survive a closed page without claiming synced', async ({ page, context, request }) => {
  const id = crypto.randomUUID();
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'Offline history', nodes: [{ id: 'text', type: 'text', position: { x: 350, y: 120 },
      data: { type: 'text', label: 'Text', prompt: [{ text: 'before' }] } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } });
  await context.route(`**/api/workflow/${id}`, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await page.goto(`/canvas?project=${id}`);
  await page.getByTestId('text-content').click();
  const editor = page.getByRole('textbox', { name: '提示词' });
  await editor.click();
  await editor.press('ControlOrMeta+End');
  await editor.pressSequentially(' twenty five internal edits');
  await page.getByRole('button', { name: '操作历史', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '操作历史' });
  await expect(panel.getByTestId('history-save-status')).toHaveText('同步失败/冲突');
  await expect(panel.getByTestId('history-batch')).toHaveCount(1);
  await panel.getByRole('button', { name: '查看批次详情' }).click();
  await panel.getByRole('button', { name: '下一页内部操作' }).click();
  await expect(panel.getByText(/before twenty five internal edits/, { exact: false })).toBeVisible();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`/canvas?project=${id}`);
  await reopened.getByRole('button', { name: '操作历史', exact: true }).click();
  await expect(reopened.getByTestId('history-batch')).toHaveCount(1);
  await expect(reopened.getByTestId('history-save-status')).not.toHaveText('已同步');
  await context.unroute(`**/api/workflow/${id}`);
  await reopened.getByRole('button', { name: '关闭历史' }).click();
  await reopened.getByRole('button', { name: '保存', exact: true }).click();
  await expect(reopened.getByTestId('canvas-save-status')).toHaveText('已同步');
  await reopened.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(reopened.getByTestId('text-content')).toHaveText('before');
  await reopened.getByRole('button', { name: '重做', exact: true }).click();
  await reopened.getByRole('button', { name: '操作历史', exact: true }).click();
  await expect(reopened.getByText('已重做 · 在撤销序列中', { exact: true })).toBeVisible();
});

test('workspace history loads metadata pages without downloading a canvas or historical originals', async ({ page, request }) => {
  const id = crypto.randomUUID();
  // A legacy envelope with a large retained original: the viewer must never request it.
  const records = Array.from({ length: 25 }, (_, i) => ({ id: `old-${i}`, label: `旧批次 ${i}`, patches: [], inverse: [] }));
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: `Paged ${id}`, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, history: {
      schema: 1, checkpoint: { name: `Paged ${id}`, nodes: [], edges: [] }, records, undo: [], redo: [], receipts: [],
      assets: { retained: 'data:image/png;base64,' + 'A'.repeat(100_000) },
      operations: records.map(record => ({ id: record.id, kind: 'edit', patches: [], inverse: [], details: ['标题变更'] })),
    } } } });
  const canvasRequests: string[] = [];
  await page.route(`**/api/workflow/${id}`, route => { canvasRequests.push(route.request().url()); return route.abort(); });
  await page.goto('/workspace');
  await page.getByLabel('搜索项目和文件夹').fill(`Paged ${id}`);
  await page.getByRole('button', { name: `Paged ${id}的更多操作` }).click();
  await page.getByRole('menuitem', { name: '操作历史', exact: true }).click();
  // Wait for the uncached route before testing the history content.
  await expect(page).toHaveURL(url => url.pathname === '/canvas/history' && url.searchParams.get('project') === id, { timeout: 25_000 });
  await expect(page.getByRole('heading', { name: '服务端操作历史' })).toBeVisible();
  await expect(page.getByTestId('remote-history-batch')).toHaveCount(20);
  await page.getByRole('button', { name: '下一页批次' }).click();
  await expect(page.getByTestId('remote-history-batch')).toHaveCount(5);
  await page.getByRole('button', { name: '查看批次 旧批次 0' }).click();
  await page.getByRole('button', { name: '查看受影响内容' }).click();
  await expect(page.getByText('标题变更', { exact: true })).toBeVisible();
  expect(canvasRequests).toEqual([]);
  const response = await request.get(`/api/workflow/${id}/history`);
  const body = await response.text();
  expect(body).not.toMatch(/data:image|patches|checkpoint|assets/);
  expect(body.length).toBeLessThan(10_000);
  expect((await request.get(`/api/workflow/${id}/history?version=0`)).status()).toBe(409);
  expect((await request.get(`/api/workflow/${id}/history?page=-1`)).status()).toBe(400);
  await request.delete(`/api/workflow/${id}`);
  expect((await request.get(`/api/workflow/${id}/history`)).status()).toBe(410);
});
