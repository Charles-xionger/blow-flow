import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

async function openGraph(page: Page, request: APIRequestContext, creative = false) {
  const id = crypto.randomUUID();
  const nodes = creative ? [{ id: 'source', type: 'creativeDesc', position: { x: 200, y: 150 }, data: { type: 'creativeDesc', label: '创意描述', prompt: '一个故事' } }] : [
    { id: 'source', type: 'text', position: { x: 150, y: 150 }, data: { type: 'text', label: '文本', customTitle: '故事', prompt: '故事内容' } },
    { id: 'target', type: 'text', position: { x: 700, y: 300 }, data: { type: 'text', label: '文本', prompt: [{ ref: 'source' }] } },
  ];
  expect((await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: {
    name: '连接操作', nodes, edges: creative ? [] : [{ id: 'link', source: 'source', target: 'target', sourceHandle: 'output', targetHandle: 'input' }], viewport: { x: 0, y: 0, zoom: 1 },
  } } })).ok()).toBeTruthy();
  await page.goto(`/canvas?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  return id;
}

test('selected connections can be deleted with Delete, undone and disconnected from the context menu', async ({ page, request }) => {
  await openGraph(page, request);
  const edge = page.locator('.react-flow__edge');
  await edge.click();
  await page.keyboard.press('Delete');
  await expect(edge).toHaveCount(0);
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.locator('.react-flow__node[data-id="target"]').getByTestId('text-content')).toHaveText('@故事');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(edge).toHaveCount(1);
  await page.locator('.react-flow__node[data-id="source"]').click();
  await edge.click({ button: 'right' });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await page.getByRole('button', { name: '断开连线', exact: true }).click();
  await expect(edge).toHaveCount(0);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.reload();
  await expect(edge).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(edge).toHaveCount(1);
  await edge.click();await page.keyboard.press('Backspace');await expect(edge).toHaveCount(0);
});

test('script generation creates independent sibling text outputs through the real background worker', async ({ page, request }) => {
  const id = await openGraph(page, request, true);
  const source = page.locator('.react-flow__node[data-id="source"]');
  await source.click();
  await page.getByRole('dialog').getByRole('button', { name: '创作设置', exact: true }).click();
  await page.getByRole('button', { name: '自由创作', exact: true }).click();
  for (let count = 1; count <= 2; count++) {
    await page.getByRole('button', { name: '生成文本', exact: true }).click();
    await expect(page.locator('.react-flow__node-text')).toHaveCount(count);
    await expect(page.locator('.react-flow__node-text').last().getByTestId('text-content')).toContainText('勇士出发，平安归来。');
  }
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const graph = (await (await request.get('/api/workflow/' + id)).json()).data;
  expect(graph.edges).toHaveLength(2);
  expect(graph.edges.every((edge: { source: string }) => edge.source === 'source')).toBeTruthy();
  await page.reload();
  await expect(page.locator('.react-flow__node-text')).toHaveCount(2);
});

test('canvas add menu offers a basic editable text node', async ({ page }) => {
  await page.goto('/canvas');
  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 400, y: 200 } });
  await expect(page.getByRole('button', { name: '文本', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '文本', exact: true }).click();
  const node = page.locator('.react-flow__node-text');
  await expect(node).toHaveCount(1);
  await node.click();
  await page.getByRole('textbox', { name: '提示词' }).fill('基础文本');
  await expect(node.getByTestId('text-content')).toHaveText('基础文本');
  await page.getByRole('button', { name: '添加节点', exact: true }).click();
  await page.getByRole('button', { name: '文本 编写剧本、提示词或笔记', exact: true }).click();
  await expect(node).toHaveCount(2);
});
