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
