import { readFileSync } from 'node:fs';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

async function openCanvas(page: Page, request: APIRequestContext, data: Record<string, unknown> = {}, upstreamText = '花园') {
  const id = crypto.randomUUID();
  expect((await request.put(`/api/workflow/${id}`, { data: {
    id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: '节点三层验收', nodes: [
      { id: 'image', type: 'textToImage', position: { x: 420, y: 180 }, data: {
        type: 'textToImage', label: '文生图', model: 'BananaPro', prompt: '一朵花', ...data } },
      { id: 'text', type: 'text', position: { x: 30, y: 180 }, data: { type: 'text', label: '文本', prompt: upstreamText } },
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
  await panel.evaluate(element => { (element as HTMLElement & { mark?: boolean }).mark = true; });
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 120, { steps: 5 });
  await expect(toolbar).toBeHidden();
  await expect(panel).toBeHidden();
  await expect(node.getByText('移动中')).toHaveCount(0);
  await page.mouse.up();
  await expect(toolbar).toBeVisible();
  await expect(panel).toBeVisible();
  // Hidden while dragging, never remounted: console state survives the drag.
  expect(await panel.evaluate(element => (element as HTMLElement & { mark?: boolean }).mark)).toBe(true);
  await page.mouse.click(950, 650);
  await expect(toolbar).toHaveCount(0);
  await expect(panel).toHaveCount(0);
});

test('直接拖动未选中的节点：全程不挂载节点工具栏和节点控制台，内容可见', async ({ page, request }) => {
  const node = await openCanvas(page, request);
  await page.evaluate(() => {
    const seen = { mounted: false };
    (window as unknown as { dragProbe: typeof seen }).dragProbe = seen;
    new MutationObserver(() => {
      if (document.querySelector('[role="toolbar"][aria-label="节点工具栏"], [role="region"][aria-label="节点控制台"]')) seen.mounted = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 120, { steps: 5 });
  await expect(node.getByText('移动中')).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const probe = await page.evaluate(() => (window as unknown as { dragProbe: { mounted: boolean } }).dragProbe);
  expect(probe.mounted).toBe(false);
  // A later click opens them as usual.
  await node.click();
  await expect(page.getByRole('region', { name: '节点控制台' })).toBeVisible();
});

const result = `data:image/png;base64,${readFileSync('tests/fixtures/h3/reference.png').toString('base64')}`;

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

const editorOf = (page: Page) => page.getByRole('region', { name: '节点控制台' }).getByRole('textbox', { name: '提示词' });
const savedPrompt = async (request: APIRequestContext, page: Page) => {
  const id = new URL(page.url()).searchParams.get('project');
  const { data } = await (await request.get(`/api/workflow/${id}`)).json();
  return data.nodes.find((node: { id: string }) => node.id === 'image').data.prompt;
};

test('节点控制台打开时连线新增节点引用，不在 React 提交中创建引用标签', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const node = await openCanvas(page, request, { prompt: '一朵花' }, '花园');
  await node.click();
  const layer = page.getByRole('region', { name: '节点控制台' }).getByRole('list', { name: '连接的上游节点' });
  await layer.getByRole('listitem').hover();
  await layer.getByRole('button', { name: /^断开/ }).click();
  const from = (await page.locator('.react-flow__node[data-id="text"] [data-handleid="output"]').boundingBox())!;
  const to = (await node.locator('[data-handleid="input"]').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  // The console stays open, so the new reference arrives as an outside change to a live editor.
  await expect(editorOf(page).locator('[data-node-reference]')).toHaveCount(1);
  expect(errors.filter(text => text.includes('flushSync'))).toEqual([]);
});

test('未选中的节点不挂载编辑器，旧提示词字符串显示为可编辑内容', async ({ page, request }) => {
  const node = await openCanvas(page, request);
  await expect(page.getByRole('textbox', { name: '提示词' })).toHaveCount(0);
  await expect(page.locator('.tiptap')).toHaveCount(0);
  await node.click();
  await expect(editorOf(page)).toHaveText('一朵花');
  await page.mouse.click(950, 650);
  await expect(page.locator('.tiptap')).toHaveCount(0);
});

test('提示词以分段结构保存，重新打开后不变，发送编辑器里的文字', async ({ page, request }) => {
  let sent: { prompt: string } | undefined;
  await page.route('**/api/generate/image', async route => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { success: false, error: '测试已捕获' } });
  });
  const node = await openCanvas(page, request);
  await node.click();
  await editorOf(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('在雨中');
  await page.keyboard.press('Enter');
  await page.keyboard.type('第二行');
  await expect.poll(() => savedPrompt(request, page)).toEqual([{ text: '一朵花在雨中\n第二行' }]);
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => sent?.prompt).toBe('一朵花在雨中\n第二行');
  await page.reload();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await node.click();
  await expect(editorOf(page).locator('p')).toHaveText(['一朵花在雨中', '第二行']);
});

test('中文输入法组合输入不被打断，粘贴只保留纯文本，可以撤销和重做', async ({ page, request }) => {
  const node = await openCanvas(page, request, { prompt: '' });
  await node.click();
  const editor = editorOf(page);
  await editor.click();
  const cdp = await page.context().newCDPSession(page);
  for (const text of ['h', 'hu', 'hua']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await page.waitForTimeout(50);
  }
  await expect(editor).toBeFocused();
  await cdp.send('Input.insertText', { text: '花' });
  await expect(editor).toHaveText('花');
  await expect.poll(() => savedPrompt(request, page)).toEqual([{ text: '花' }]);

  await editor.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '粗体\n下一行');
    clipboardData.setData('text/html', '<b style="color:red">粗体</b><p>下一行</p>');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator('p')).toHaveText(['花粗体', '下一行']);
  await expect(editor.locator('b, [style]')).toHaveCount(0);
  await expect.poll(() => savedPrompt(request, page)).toEqual([{ text: '花粗体\n下一行' }]);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toHaveText('花');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(editor.locator('p')).toHaveText(['花粗体', '下一行']);
});

test('提示词为空或只有空白时不能运行', async ({ page, request }) => {
  const node = await openCanvas(page, request, { prompt: '' });
  await node.click();
  const run = page.getByRole('button', { name: '生成', exact: true });
  await expect(run).toBeDisabled();
  await editorOf(page).click();
  await page.keyboard.type('   ');
  await expect(run).toBeDisabled();
  await page.keyboard.type('花');
  await expect(run).toBeEnabled();
});

test('粘贴内容里没有文字时保留选中的提示词', async ({ page, request }) => {
  const node = await openCanvas(page, request);
  await node.click();
  const editor = editorOf(page);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await editor.evaluate(element => element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })));
  await expect(editor).toHaveText('一朵花');
});

async function openWithUpstream(page: Page, request: APIRequestContext, prompt: unknown, sources = true) {
  const id = crypto.randomUUID();
  const inputs = sources ? [
    { id: 'hero', type: 'character', position: { x: 30, y: 30 }, data: { type: 'character', label: '角色', customTitle: '小明',
      characterData: { name: '小明', id: 'hero-character', description: '描述', tags: [], referenceImages: [result] } } },
    { id: 'garden', type: 'text', position: { x: 30, y: 330 }, data: { type: 'text', label: '文本', customTitle: '场景', prompt: '花园' } },
  ] : [];
  expect((await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: { name: '节点引用', nodes: [
    { id: 'image', type: 'textToImage', position: { x: 520, y: 200 }, data: { type: 'textToImage', label: '文生图', model: 'BananaPro', prompt } },
    ...inputs,
  ], edges: inputs.map(input => ({ id: `link-${input.id}`, source: input.id, target: 'image', sourceHandle: 'output', targetHandle: 'input' })),
  viewport: { x: 0, y: 0, zoom: 1 } } } })).ok()).toBeTruthy();
  await page.goto(`/?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.locator('.react-flow__node[data-id="image"]').click();
  return page.getByRole('region', { name: '节点控制台' });
}

const captureRun = async (page: Page) => {
  const run: { body?: { prompt: string; inputImages?: string[] } } = {};
  await page.route('**/api/generate/image', async route => {
    run.body = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { success: false, error: '测试已捕获' } });
  });
  return run;
};

test('连接层显示上游节点，悬停显示编号和名称；没有上游节点时不显示', async ({ page, request }) => {
  const panel = await openWithUpstream(page, request, '花');
  const layer = panel.getByRole('list', { name: '连接的上游节点' });
  await expect(layer.getByRole('listitem')).toHaveCount(2);
  await expect(layer.getByTitle('图片1 · 小明')).toBeVisible();
  await expect(layer.getByTitle('场景')).toBeVisible();
  const empty = await openWithUpstream(page, request, '花', false);
  await expect(empty.getByRole('list', { name: '连接的上游节点' })).toHaveCount(0);
  await editorOf(page).click();
  await page.keyboard.type('@');
  await expect(page.getByRole('listbox', { name: '引用连接的节点' })).toHaveCount(0);
  await expect(editorOf(page)).toHaveText('花@');
});

test('用方向键和回车、鼠标选择节点引用，手写内容、引用文本和未引用素材都发送', async ({ page, request }) => {
  const run = await captureRun(page);
  const panel = await openWithUpstream(page, request, '');
  const menu = page.getByRole('listbox', { name: '引用连接的节点' });
  await editorOf(page).click();
  await page.keyboard.type('一只@');
  await expect(menu.getByRole('option')).toHaveCount(2);
  await expect(menu.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await page.keyboard.type('里@');
  await menu.getByRole('option', { name: /图片1/ }).click();
  await expect(menu).toHaveCount(0);
  const tags = editorOf(page).locator('[data-node-reference]');
  await expect(tags).toHaveText([/场景$/, '图片1']);
  await expect(tags.nth(1).locator('img')).toHaveCount(1);
  await expect(tags.nth(1)).toHaveAttribute('title', '图片1 · 小明');
  await panel.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => run.body?.prompt).toBe('一只花园里图片1');
  expect(run.body?.inputImages).toEqual([result]);
  // 节点引用保存为引用段，重新打开后仍是标签。
  await expect.poll(() => savedPrompt(request, page)).toEqual([{ text: '一只' }, { ref: 'garden' }, { text: '里' }, { ref: 'hero' }]);
  await page.reload();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.locator('.react-flow__node[data-id="image"]').click();
  await expect(editorOf(page).locator('[data-node-reference]')).toHaveText([/场景$/, '图片1']);
});

test('节点引用是整体标签，删除它不断开连线；未引用的文本不发送，素材仍发送', async ({ page, request }) => {
  const run = await captureRun(page);
  const panel = await openWithUpstream(page, request, [{ text: '花' }, { ref: 'garden' }]);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await editorOf(page).click();
  // 先输入一个字，确保光标已经同步到标签之后。
  await page.keyboard.type('x');
  await expect(editorOf(page)).toContainText('x');
  const copied = await editorOf(page).evaluate(element => {
    getSelection()?.selectAllChildren(element);
    return new Promise<string>(resolve => setTimeout(() => {
      const clipboardData = new DataTransfer();
      element.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
      getSelection()?.collapseToEnd();
      setTimeout(() => resolve(clipboardData.getData('text/plain')), 50);
    }, 50));
  });
  expect(copied).toBe('花@场景x');
  await page.keyboard.press('Backspace');
  await expect(editorOf(page)).not.toContainText('x');
  await page.keyboard.press('Backspace');
  await expect(editorOf(page).locator('[data-node-reference]')).toHaveCount(0);
  await expect(editorOf(page)).toHaveText('花');
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await panel.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => run.body?.prompt).toBe('花');
  expect(run.body?.inputImages).toEqual([result]);
});

test('运行时读取上游文本节点的当前内容', async ({ page, request }) => {
  const run = await captureRun(page);
  await openWithUpstream(page, request, [{ ref: 'garden' }]);
  const garden = page.locator('.react-flow__node[data-id="garden"]');
  await garden.click();
  await editorOf(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('新花园');
  await expect(garden.getByTestId('text-content')).toHaveText('新花园');
  await page.locator('.react-flow__node[data-id="image"]').click();
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => run.body?.prompt).toBe('新花园');
});

test('中文输入法组合输入时不弹出菜单，Escape 只关闭菜单', async ({ page, request }) => {
  const panel = await openWithUpstream(page, request, '');
  const menu = page.getByRole('listbox', { name: '引用连接的节点' });
  await editorOf(page).click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '@', selectionStart: 1, selectionEnd: 1 });
  await page.waitForTimeout(100);
  await expect(menu).toHaveCount(0);
  await cdp.send('Input.imeSetComposition', { text: '@hua', selectionStart: 4, selectionEnd: 4 });
  await page.waitForTimeout(100);
  await expect(menu).toHaveCount(0);
  await cdp.send('Input.insertText', { text: '@花' });
  await expect(editorOf(page)).toHaveText('@花');
  await expect(menu).toHaveCount(0);
  await page.keyboard.type(' @');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(panel).toBeVisible();
  // 这个 @ 已被关闭；删掉后重新输入，菜单再次出现。
  await page.keyboard.press('Backspace');
  await page.keyboard.type('@');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.type('flower@');
  await expect(menu).toBeVisible();
});

test('从连接层的缩略图断开连接后，节点引用变成普通文本，撤销也不恢复；重新打开后不变', async ({ page, request }) => {
  const run = await captureRun(page);
  const panel = await openWithUpstream(page, request, [{ text: '在' }, { ref: 'garden' }, { text: '画' }, { ref: 'hero' }]);
  const layer = panel.getByRole('list', { name: '连接的上游节点' });
  // 断开前先留下一步编辑历史，撤销才有东西可以恢复。
  await editorOf(page).click();
  await page.keyboard.type('x');
  await expect(editorOf(page)).toContainText('x');
  await page.keyboard.press('Backspace');
  await expect(editorOf(page)).not.toContainText('x');
  await layer.getByTitle('场景').hover();
  await layer.getByRole('button', { name: '断开 场景' }).click();
  await expect(layer.getByRole('listitem')).toHaveCount(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(editorOf(page).locator('[data-node-reference]')).toHaveText(['图片1']);
  await expect(editorOf(page)).toHaveText('在@场景画图片1');
  await editorOf(page).click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editorOf(page)).toHaveText('在@场景画图片1');
  await panel.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => run.body?.prompt).toBe('在@场景画图片1');
  await expect.poll(() => savedPrompt(request, page)).toEqual([{ text: '在@场景画' }, { ref: 'hero' }]);
  await page.reload();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.locator('.react-flow__node[data-id="image"]').click();
  await expect(editorOf(page)).toHaveText('在@场景画图片1');
});

test('未选中的目标节点在上游节点被删除时同样转换，选中后看到普通文本', async ({ page, request }) => {
  await openWithUpstream(page, request, [{ text: '在' }, { ref: 'garden' }]);
  await page.mouse.click(950, 650);
  await expect(page.locator('.tiptap')).toHaveCount(0);
  await page.locator('.react-flow__node[data-id="garden"]').click();
  await page.keyboard.press('Backspace');
  await expect(page.locator('.react-flow__node[data-id="garden"]')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await page.locator('.react-flow__node[data-id="image"]').click();
  await expect(editorOf(page)).toHaveText('在@场景');
  await expect(editorOf(page).locator('[data-node-reference]')).toHaveCount(0);
});

test('右键复制节点时不复制连线，副本里的节点引用是普通文本', async ({ page, request }) => {
  await openWithUpstream(page, request, [{ text: '在' }, { ref: 'garden' }]);
  await page.mouse.click(950, 650);
  await page.locator('.react-flow__node[data-id="image"]').click({ button: 'right' });
  await page.getByRole('button', { name: /复制/ }).click();
  const nodes = page.locator('.react-flow__node[data-id]');
  await expect(nodes).toHaveCount(4);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  const id = new URL(page.url()).searchParams.get('project');
  await expect.poll(async () => {
    const { data } = await (await request.get(`/api/workflow/${id}`)).json();
    return data.nodes.filter((node: { data: { type: string } }) => node.data.type === 'textToImage').map((node: { data: { prompt: unknown } }) => node.data.prompt);
  }).toEqual([[{ text: '在' }, { ref: 'garden' }], [{ text: '在@场景' }]]);
});

test('拖线连接文本节点后，编辑器里出现它的节点引用，手写内容和文本都发送', async ({ page, request }) => {
  const run = await captureRun(page);
  await openCanvas(page, request, { prompt: '一朵花' }, '花园');
  // openCanvas 的文本节点已连接；先断开，再拖线重新连接。
  const node = page.locator('.react-flow__node[data-id="image"]');
  await node.click();
  const panel = page.getByRole('region', { name: '节点控制台' });
  const layer = panel.getByRole('list', { name: '连接的上游节点' });
  await layer.getByRole('listitem').hover();
  await layer.getByRole('button', { name: /^断开/ }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  const from = (await page.locator('.react-flow__node[data-id="text"] [data-handleid="output"]').boundingBox())!;
  const to = (await node.locator('[data-handleid="input"]').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await node.click();
  await expect(editorOf(page).locator('[data-node-reference]')).toHaveCount(1);
  await panel.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => run.body?.prompt).toBe('一朵花花园');
});

const swatch = (fill: string) => `data:image/png;base64,${readFileSync(`tests/fixtures/canvas/${fill}.png`).toString('base64')}`;

test('拖动缩略图调整顺序：编号、发送内容和素材顺序一起更新，重新打开后不变，不影响其他节点和画布', async ({ page, request }) => {
  const run = await captureRun(page);
  const [red, blue] = [swatch('red'), swatch('blue')];
  const id = crypto.randomUUID();
  const source = (key: string, y: number, imageSrc: string) => ({ id: key, type: 'character', position: { x: 30, y }, data: { type: 'character', label: '角色', customTitle: key, imageSrc } });
  const link = (from: string, to: string) => ({ id: `${from}-${to}`, source: from, target: to, sourceHandle: 'output', targetHandle: 'input' });
  expect((await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: { name: '排序', nodes: [
    { id: 'image', type: 'textToImage', position: { x: 520, y: 200 }, data: { type: 'textToImage', label: '文生图', model: 'BananaPro', prompt: [{ ref: 'red' }, { text: '和' }, { ref: 'blue' }] } },
    { id: 'other', type: 'textToImage', position: { x: 1000, y: 200 }, data: { type: 'textToImage', label: '文生图', model: 'BananaPro', prompt: [{ ref: 'red' }, { text: '和' }, { ref: 'blue' }] } },
    source('red', 30, red), source('blue', 330, blue),
  ], edges: [link('red', 'other'), link('red', 'image'), link('blue', 'other'), link('blue', 'image')], viewport: { x: 0, y: 0, zoom: 0.75 } } } })).ok()).toBeTruthy();
  await page.goto(`/?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const node = page.locator('.react-flow__node[data-id="image"]');
  await node.click();
  const panel = page.getByRole('region', { name: '节点控制台' });
  const layer = panel.getByRole('list', { name: '连接的上游节点' });
  await expect(editorOf(page).locator('[data-node-reference]')).toHaveText(['图片1', '图片2']);
  const position = await node.boundingBox();
  const viewport = await page.locator('.react-flow__viewport').getAttribute('style');
  const first = (await layer.getByTitle('图片1 · red').boundingBox())!;
  const second = (await layer.getByTitle('图片2 · blue').boundingBox())!;
  // 右键不是拖动。
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await page.mouse.click(5, 700);
  await node.click();
  await expect(layer.getByTitle('图片1 · red')).toBeVisible();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(layer.getByTitle('图片1 · blue')).toBeVisible();
  await expect(layer.getByTitle('图片2 · red')).toBeVisible();
  expect(await node.boundingBox()).toEqual(position);
  expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(viewport);
  const tags = editorOf(page).locator('[data-node-reference]');
  await expect(tags).toHaveText(['图片2', '图片1']);
  await expect(tags.nth(0)).toHaveAttribute('title', '图片2 · red');
  await panel.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => run.body?.prompt).toBe('图片2和图片1');
  expect(run.body?.inputImages).toEqual([blue, red]);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.reload();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await node.click();
  await expect(editorOf(page).locator('[data-node-reference]')).toHaveText(['图片2', '图片1']);
  await page.mouse.click(5, 700);
  await page.locator('.react-flow__node[data-id="other"]').click();
  await expect(editorOf(page).locator('[data-node-reference]')).toHaveText(['图片1', '图片2']);
});

async function openImageToImage(page: Page, request: APIRequestContext, data: Record<string, unknown> = {}, inputs = true) {
  const id = crypto.randomUUID();
  const sources = inputs ? [
    { id: 'first', type: 'originalImage', position: { x: 30, y: 30 }, data: { type: 'originalImage', label: '原图', customTitle: '第一张', imageSrc: swatch('red') } },
    { id: 'hero', type: 'character', position: { x: 30, y: 330 }, data: { type: 'character', label: '角色', customTitle: '小明',
      characterData: { name: '小明', id: 'hero-character', description: '描述', tags: [], referenceImages: [swatch('blue'), swatch('green')] } } },
  ] : [];
  expect((await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: { name: '图生图', nodes: [
    { id: 'image', type: 'imageToImage', position: { x: 520, y: 200 }, data: { type: 'imageToImage', label: '图生图', model: 'BananaPro', prompt: '变成水彩', ...data } },
    ...sources,
  ], edges: sources.map(source => ({ id: `link-${source.id}`, source: source.id, target: 'image', sourceHandle: 'output', targetHandle: 'input' })),
  viewport: { x: 0, y: 0, zoom: 1 } } } })).ok()).toBeTruthy();
  await page.goto(`/?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const node = page.locator('.react-flow__node[data-id="image"]');
  await expect(page.getByRole('region', { name: '节点控制台' })).toHaveCount(0);
  await node.click();
  return { node, panel: page.getByRole('region', { name: '节点控制台' }) };
}

const captureImageToImage = async (page: Page, response: Record<string, unknown> = { success: false, error: '测试已捕获' }) => {
  const runs: { prompt: string; inputImage: string; inputImages: string[]; skipCache: boolean }[] = [];
  await page.route('**/api/generate/image-to-image', async route => {
    runs.push(route.request().postDataJSON());
    await route.fulfill({ json: response });
  });
  return runs;
};

test('图生图：连接的图片和角色显示在连接层，能用 @ 引用，多张图片按连接层顺序发送', async ({ page, request }) => {
  const runs = await captureImageToImage(page);
  const { panel } = await openImageToImage(page, request, { prompt: '' });
  const layer = panel.getByRole('list', { name: '连接的上游节点' });
  await expect(layer.getByRole('listitem')).toHaveCount(2);
  await expect(layer.getByTitle('图片1 · 第一张')).toBeVisible();
  await expect(layer.getByTitle('图片2 · 小明')).toBeVisible();
  await editorOf(page).click();
  await page.keyboard.type('把@');
  const menu = page.getByRole('listbox', { name: '引用连接的节点' });
  await menu.getByRole('option', { name: /小明/ }).click();
  await expect(editorOf(page).locator('[data-node-reference]')).toHaveText(['图片2']);
  await panel.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => runs[0]?.prompt).toBe('把图片2');
  expect(runs[0].inputImage).toBe(swatch('red'));
  expect(runs[0].inputImages).toEqual([swatch('red'), swatch('blue'), swatch('green')]);
  await expect(panel.getByRole('alert')).toHaveText('测试已捕获');
});

test('图生图：拖动连接层调整顺序后，发送的图片顺序随之改变', async ({ page, request }) => {
  const runs = await captureImageToImage(page);
  const { panel } = await openImageToImage(page, request);
  const layer = panel.getByRole('list', { name: '连接的上游节点' });
  const first = (await layer.getByTitle('图片1 · 第一张').boundingBox())!;
  const second = (await layer.getByTitle('图片2 · 小明').boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(layer.getByTitle('图片1 · 小明')).toBeVisible();
  await panel.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => runs[0]?.inputImages).toEqual([swatch('blue'), swatch('green'), swatch('red')]);
});

test('图生图：没有输入图片或提示词为空时不能运行', async ({ page, request }) => {
  const noInput = await openImageToImage(page, request, {}, false);
  await expect(noInput.panel.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
  await expect(noInput.panel.getByText('请连接图片节点（支持多张图片参考）')).toBeVisible();
  const noPrompt = await openImageToImage(page, request, { prompt: '  ' });
  await expect(noPrompt.panel.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
  await expect(noPrompt.panel.getByText('请连接图片节点（支持多张图片参考）')).toHaveCount(0);
  await editorOf(page).click();
  await page.keyboard.type('花');
  await expect(noPrompt.panel.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
});

test('图生图：结果上不再有悬浮按钮，节点工具栏提供操作，可以跳过缓存重新生成', async ({ page, request }) => {
  const runs = await captureImageToImage(page, { success: true, data: result });
  const analyzed: { imageUrl: string; prompt: string }[] = [];
  await page.route('**/api/character/analyze-image', async route => {
    analyzed.push(route.request().postDataJSON());
    await route.fulfill({ json: { success: false, error: '测试已捕获' } });
  });
  const { node, panel } = await openImageToImage(page, request);
  const toolbar = page.getByRole('toolbar', { name: '节点工具栏' });
  for (const name of ['预览', '下载', '保存为角色']) await expect(toolbar.getByRole('button', { name, exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '重新生成（跳过缓存）' })).toHaveCount(0);
  await panel.getByRole('button', { name: '生成', exact: true }).click();
  const image = node.getByRole('img', { name: 'Generated' });
  await expect(image).toBeVisible();
  expect(runs[0].skipCache).toBe(false);
  await image.hover();
  for (const name of ['预览', '下载', '保存为角色']) await expect(page.getByTestId('image-preview').getByTitle(name)).toHaveCount(0);
  await toolbar.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.locator('body > div.fixed img[alt="Generated"]')).toBeVisible();
  await page.keyboard.press('Escape');
  const download = page.waitForEvent('download');
  await toolbar.getByRole('button', { name: '下载', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^image-\d+\.png$/);
  await toolbar.getByRole('button', { name: '保存为角色', exact: true }).click();
  await page.getByRole('dialog', { name: '保存为角色' }).getByRole('button', { name: '保存为角色' }).click();
  await expect.poll(() => analyzed[0]).toEqual({ imageUrl: result, prompt: '变成水彩' });
  await panel.getByRole('button', { name: '重新生成（跳过缓存）' }).click();
  await expect.poll(() => runs[1]?.skipCache).toBe(true);
});

test('图生图：生成中节点展示区显示进度，控制台的按钮不可用', async ({ page, request }) => {
  const { panel } = await openImageToImage(page, request, { isLoading: true });
  await expect(page.getByTestId('image-preview').getByText('生成中...')).toBeVisible();
  await expect(panel.getByRole('button', { name: '生成中' })).toBeDisabled();
});

const videoAsset = 'https://video-fixture.test/result.mp4';
async function openVideoNode(page: Page, request: APIRequestContext, type: 'textToVideo' | 'imageToVideo' | 'startEndToVideo', data: Record<string, unknown> = {}, sources: Record<string, unknown>[] = []) {
  await page.route('https://video-fixture.test/**', route => route.fulfill({ path: 'tests/fixtures/h3/reference.mp4', contentType: 'video/mp4', headers: { 'access-control-allow-origin': '*' } }));
  const id = crypto.randomUUID();
  expect((await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: { name: '视频', nodes: [
    { id: 'video', type, position: { x: 520, y: 120 }, data: { type, label: '视频', model: type === 'textToVideo' ? 'Sora 2' : 'sora-2', prompt: '海浪', ...data } }, ...sources,
  ], edges: sources.map(source => ({ id: `link-${source.id}`, source: source.id, target: 'video', sourceHandle: 'output', targetHandle: 'input' })), viewport: { x: 0, y: 0, zoom: 1 } } } })).ok()).toBeTruthy();
  await page.goto(`/?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const node = page.locator('.react-flow__node[data-id="video"]');
  await expect(page.getByRole('region', { name: '节点控制台' })).toHaveCount(0);
  await expect(page.locator('.tiptap')).toHaveCount(0);
  await node.click();
  return { node, panel: page.getByRole('region', { name: '节点控制台' }), toolbar: page.getByRole('toolbar', { name: '节点工具栏' }) };
}
const captureVideo = async (page: Page, path: string, response: Record<string, unknown> = { success: false, error: '测试已捕获' }) => {
  const runs: Record<string, unknown>[] = [];
  await page.route(`**/api/generate/${path}`, async route => { runs.push(route.request().postDataJSON()); await route.fulfill({ json: response }); });
  return runs;
};
const textSource = { id: 'scene', type: 'text', position: { x: 30, y: 120 }, data: { type: 'text', label: '文本', customTitle: '场景', prompt: '黄昏' } };
const imageSource = (key: string, y: number, fill: string) => ({ id: key, type: 'originalImage', position: { x: 30, y }, data: { type: 'originalImage', label: '原图', customTitle: key, imageSrc: swatch(fill) } });

test('文生视频：三层结构，配置和运行同一行，手写内容和引用的文本都发送，配置值不变', async ({ page, request }) => {
  const runs = await captureVideo(page, 'video');
  const { node, panel } = await openVideoNode(page, request, 'textToVideo', { prompt: [{ text: '海浪' }, { ref: 'scene' }] }, [textSource]);
  await expect(panel.getByRole('list', { name: '连接的上游节点' }).getByTitle('场景')).toBeVisible();
  await expect(editorOf(page).locator('[data-node-reference]')).toHaveCount(1);
  const run = panel.getByRole('button', { name: '生成', exact: true });
  const middle = async (name: string) => { const box = (await panel.getByRole('combobox', { name }).boundingBox())!; return box.y + box.height / 2; };
  const runBox = (await run.boundingBox())!;
  for (const name of ['视频模型', '视频时长', '视频画幅']) expect(await middle(name)).toBeCloseTo(runBox.y + runBox.height / 2, 0);
  await panel.getByRole('combobox', { name: '视频时长' }).selectOption('10s');
  await panel.getByRole('combobox', { name: '视频画幅' }).selectOption('9:16');
  await panel.getByRole('button', { name: '提示词优化' }).click();
  await run.click();
  await expect.poll(() => runs[0]?.prompt).toBe('海浪黄昏');
  expect(runs[0]).toMatchObject({ model: 'Sora 2', duration: '10s', aspectRatio: '9:16', promptOptimize: true });
  await expect(panel.getByRole('alert')).toHaveText('测试已捕获');
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 120, { steps: 5 });
  await expect(panel).toHaveCount(0);
  await page.mouse.up();
});

test('文生视频：提示词为空时不能运行', async ({ page, request }) => {
  const { panel } = await openVideoNode(page, request, 'textToVideo', { prompt: ' ' });
  await expect(panel.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
});

test('视频节点工具栏：没有结果时不可用，有结果时可以预览和下载；展示区保留播放器', async ({ page, request }) => {
  const empty = await openVideoNode(page, request, 'textToVideo');
  for (const name of ['预览', '下载']) await expect(empty.toolbar.getByRole('button', { name, exact: true })).toBeDisabled();
  await expect(empty.toolbar.getByRole('button', { name: '保存为角色' })).toHaveCount(0);
  const { node, toolbar } = await openVideoNode(page, request, 'imageToVideo', { videoSrc: videoAsset });
  await expect(node.locator('video')).toHaveAttribute('controls', '');
  await toolbar.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.locator('body > div.fixed video')).toHaveAttribute('src', videoAsset);
  await page.keyboard.press('Escape');
  await expect(page.locator('body > div.fixed video')).toHaveCount(0);
  await expect(toolbar).toBeVisible();
  const download = page.waitForEvent('download');
  await toolbar.getByRole('button', { name: '下载', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^video-\d+\.mp4$/);
});

test('图生视频：连接层可以引用和排序，发送连接层第一张图和全部配置；没有图或提示词时不能运行', async ({ page, request }) => {
  const runs = await captureVideo(page, 'image-to-video');
  const noImage = await openVideoNode(page, request, 'imageToVideo');
  await expect(noImage.panel.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
  await expect(noImage.panel.getByText('请连接一个图片节点作为输入')).toBeVisible();
  await expect(noImage.panel.getByRole('button', { name: '优化提示词' })).toBeDisabled();
  const { panel } = await openVideoNode(page, request, 'imageToVideo', { prompt: '' }, [imageSource('red', 30, 'red'), imageSource('blue', 330, 'blue')]);
  const layer = panel.getByRole('list', { name: '连接的上游节点' });
  await expect(panel.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
  await editorOf(page).click();
  await page.keyboard.type('让@');
  await page.getByRole('listbox', { name: '引用连接的节点' }).getByRole('option', { name: /blue/ }).click();
  const first = (await layer.getByTitle('图片1 · red').boundingBox())!;
  const second = (await layer.getByTitle('图片2 · blue').boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(layer.getByTitle('图片1 · blue')).toBeVisible();
  for (const [name, value] of [['视频时长', '8'], ['视频分辨率', '1080P'], ['视频画幅', '9:16']]) await panel.getByRole('combobox', { name }).selectOption(value);
  await panel.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => runs[0]?.prompt).toBe('让图片1');
  expect(runs[0]).toMatchObject({ inputImage: swatch('blue'), duration: 8, resolution: '1080P', aspectRatio: '9:16' });
  await expect(panel.getByRole('alert')).toHaveText('测试已捕获');
});

test('图生视频：AI 生成提示词写入编辑器', async ({ page, request }) => {
  const sent: { currentPrompt?: string; context: { inputImage: string } }[] = [];
  await page.route('**/api/generate-prompt', async route => { sent.push(route.request().postDataJSON()); await route.fulfill({ json: { success: true, data: '生成的提示词' } }); });
  const { panel } = await openVideoNode(page, request, 'imageToVideo', { prompt: [{ text: '让' }, { ref: 'red' }] }, [imageSource('red', 30, 'red')]);
  await panel.getByRole('button', { name: '优化提示词' }).click();
  await expect(editorOf(page)).toHaveText('生成的提示词');
  expect(sent[0]).toMatchObject({ currentPrompt: '让图片1', context: { inputImage: swatch('red') } });
});

test('图生视频：任务恢复和重试保存仍在节点控制台', async ({ page, request }) => {
  await page.route('**/api/generation/tasks/missing-task', route => route.abort());
  const { panel } = await openVideoNode(page, request, 'imageToVideo', { generationTaskId: 'missing-task', generationBlocked: true, generationCanRetrySave: true });
  await expect(panel.getByRole('button', { name: '继续查询原任务' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '重试保存（不重新生成）' })).toBeVisible();
});

test('焦点在节点控制台或节点工具栏的按钮上时，Backspace 不删除节点', async ({ page, request }) => {
  const { node, panel } = await openImageToImage(page, request);
  await panel.getByRole('button', { name: '提示词优化' }).focus();
  await page.keyboard.press('Backspace');
  await expect(node).toHaveCount(1);
  await panel.getByRole('list', { name: '连接的上游节点' }).getByRole('button', { name: /^断开/ }).first().focus();
  await page.keyboard.press('Delete');
  await expect(node).toHaveCount(1);
});

test('图生视频：连接多张图片时提示此模型只使用第一张', async ({ page, request }) => {
  const single = await openVideoNode(page, request, 'imageToVideo', {}, [imageSource('red', 30, 'red')]);
  await expect(single.panel.getByText('此模型只使用连接层的第一张图片')).toHaveCount(0);
  const many = await openVideoNode(page, request, 'imageToVideo', {}, [imageSource('red', 30, 'red'), imageSource('blue', 330, 'blue')]);
  await expect(many.panel.getByText('此模型只使用连接层的第一张图片')).toBeVisible();
});

test('首尾帧：标出首帧和尾帧，交换后发送的首尾帧和引用编号一起交换；拖动时控制台隐藏', async ({ page, request }) => {
  const runs = await captureVideo(page, 'start-end-to-video');
  const { node, panel } = await openVideoNode(page, request, 'startEndToVideo', { prompt: [{ text: '从' }, { ref: 'red' }, { text: '到' }, { ref: 'blue' }] },
    [imageSource('red', 30, 'red'), imageSource('blue', 330, 'blue')]);
  await expect(panel.getByLabel('首帧：图片1 · red')).toBeVisible();
  await expect(panel.getByLabel('尾帧：图片2 · blue')).toBeVisible();
  await panel.getByRole('button', { name: '交换首尾帧' }).click();
  await expect(panel.getByLabel('首帧：图片1 · blue')).toBeVisible();
  await expect(panel.getByLabel('尾帧：图片2 · red')).toBeVisible();
  await expect(panel.getByRole('list', { name: '连接的上游节点' }).getByRole('listitem').first()).toHaveAttribute('title', '图片1 · blue');
  await panel.getByRole('combobox', { name: '视频时长' }).selectOption('8');
  await panel.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => runs[0]?.prompt).toBe('从图片2到图片1');
  expect(runs[0]).toMatchObject({ startImage: swatch('blue'), endImage: swatch('red'), duration: 8 });
  await expect(panel.getByRole('alert')).toHaveText('测试已捕获');
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 80, { steps: 5 });
  await expect(panel).toHaveCount(0);
  await page.mouse.up();
});

test('首尾帧：少于两张图片或提示词为空时不能运行，并给出提示', async ({ page, request }) => {
  const single = await openVideoNode(page, request, 'startEndToVideo', {}, [imageSource('red', 30, 'red')]);
  await expect(single.panel.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
  await expect(single.panel.getByText('请连接两个图片节点作为首尾帧（当前 1/2）')).toBeVisible();
  await expect(single.panel.getByRole('button', { name: '交换首尾帧' })).toBeDisabled();
  const empty = await openVideoNode(page, request, 'startEndToVideo', { prompt: ' ' }, [imageSource('red', 30, 'red'), imageSource('blue', 330, 'blue')]);
  await expect(empty.panel.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
  await expect(empty.panel.getByText(/请连接两个图片节点/)).toHaveCount(0);
});

test('首尾帧：尾帧来自有多张参考图的角色时不能交换，避免另一张图片被挤出', async ({ page, request }) => {
  const hero = { id: 'hero', type: 'character', position: { x: 30, y: 330 }, data: { type: 'character', label: '角色', customTitle: '小明',
    characterData: { name: '小明', id: 'hero-character', description: '描述', tags: [], referenceImages: [swatch('blue'), swatch('green')] } } };
  const { panel } = await openVideoNode(page, request, 'startEndToVideo', {}, [imageSource('red', 30, 'red'), hero]);
  await expect(panel.getByLabel('首帧：图片1 · red')).toBeVisible();
  await expect(panel.getByLabel('尾帧：图片2 · 小明')).toBeVisible();
  await expect(panel.getByRole('button', { name: '交换首尾帧' })).toBeDisabled();
});

async function openTextGraph(page: Page, request: APIRequestContext, nodes: Record<string, unknown>[], edges: [string, string][]) {
  const id = crypto.randomUUID();
  expect((await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: { name: '文本节点', nodes,
    edges: edges.map(([source, target]) => ({ id: `link-${source}-${target}`, source, target, sourceHandle: 'output', targetHandle: 'input' })),
    viewport: { x: 0, y: 0, zoom: 1 } } } })).ok()).toBeTruthy();
  await page.goto(`/?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
}
const textNode = (id: string, x: number, y: number, prompt: unknown, customTitle?: string) =>
  ({ id, type: 'text', position: { x, y }, data: { type: 'text', label: '文本', prompt, ...(customTitle ? { customTitle } : {}) } });

test('文本节点：展示区显示内容，控制台只有编辑器；可以引用上游文本并逐层展开发送', async ({ page, request }) => {
  const run = await captureRun(page);
  await openTextGraph(page, request, [
    textNode('scene', 30, 60, '花园', '场景'),
    textNode('shot', 420, 60, '镜头：', '镜头'),
    { id: 'image', type: 'textToImage', position: { x: 820, y: 60 }, data: { type: 'textToImage', label: '文生图', model: 'BananaPro', prompt: [{ ref: 'shot' }] } },
  ], [['scene', 'shot'], ['shot', 'image']]);
  const shot = page.locator('.react-flow__node[data-id="shot"]');
  await expect(shot.getByTestId('text-content')).toHaveText('镜头：');
  await shot.click();
  const panel = page.getByRole('region', { name: '节点控制台' });
  await expect(editorOf(page)).toHaveText('镜头：');
  await expect(panel.getByRole('button')).toHaveCount(0);
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  await expect(panel.getByRole('list', { name: '连接的上游节点' })).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: '节点工具栏' })).toHaveCount(0);
  await editorOf(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('@');
  await page.getByRole('listbox', { name: '引用连接的节点' }).getByRole('option', { name: /场景/ }).click();
  await expect(shot.getByTestId('text-content')).toHaveText('镜头：花园');
  await page.locator('.react-flow__node[data-id="image"]').click();
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => run.body?.prompt).toBe('镜头：花园');
});

test('分镜：没有连接层，编辑器、镜头数量和运行在控制台；生成的文本节点带各自内容，可以被引用', async ({ page, request }) => {
  const sent: { prompt: string; shotCount: number }[] = [];
  let reply: Record<string, unknown> = { success: false, error: '分镜失败' };
  await page.route('**/api/storyboard', async route => { sent.push(route.request().postDataJSON()); await route.fulfill({ json: reply }); });
  await openTextGraph(page, request, [{ id: 'board', type: 'storyboard', position: { x: 30, y: 60 }, data: { type: 'storyboard', label: '分镜', prompt: '' } }], []);
  const board = page.locator('.react-flow__node[data-id="board"]');
  await board.click();
  const panel = page.getByRole('region', { name: '节点控制台' });
  await expect(panel.getByRole('list', { name: '连接的上游节点' })).toHaveCount(0);
  const run = panel.getByRole('button', { name: '生成', exact: true });
  await expect(run).toBeDisabled();
  await editorOf(page).click();
  await page.keyboard.type('勇士的故事');
  await panel.getByRole('button', { name: '增加镜头' }).click();
  await expect(panel.getByLabel('镜头数量')).toHaveText('5');
  await run.click();
  await expect(panel.getByRole('alert')).toHaveText('分镜失败');
  expect(sent[0]).toMatchObject({ prompt: '勇士的故事', shotCount: 5 });
  reply = { success: true, data: [{ title: '出发', description: '勇士出发' }, { title: '归来', description: '勇士归来' }] };
  await run.click();
  await expect(board.getByText('已生成 2 个文本节点')).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  const shots = page.locator('.react-flow__node-text');
  await expect(shots).toHaveCount(2);
  await expect(shots.getByTestId('text-content')).toHaveText(['勇士出发', '勇士归来']);
  await shots.first().click();
  await expect(editorOf(page)).toHaveText('勇士出发');
  await expect(editorOf(page).locator('[data-node-reference]')).toHaveCount(0);
});

async function openSourceNode(page: Page, request: APIRequestContext, node: Record<string, unknown>) {
  const id = crypto.randomUUID();
  expect((await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: { name: '素材节点', nodes: [
    { position: { x: 300, y: 200 }, ...node },
  ], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } })).ok()).toBeTruthy();
  await page.goto(`/?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const shown = page.locator(`.react-flow__node[data-id="${node.id}"]`);
  await shown.click();
  return { node: shown, toolbar: page.getByRole('toolbar', { name: '节点工具栏' }) };
}

test('原图：只有节点工具栏，可以上传、预览、下载和删除图片', async ({ page, request }) => {
  const imageUrl = 'https://upload-fixture.test/original.png';
  await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(result.split(',')[1], 'base64'), contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } }));
  await page.route('**/api/upload/image', route => route.fulfill({ json: { success: true, data: { url: imageUrl } } }));
  const { node, toolbar } = await openSourceNode(page, request, { id: 'original', type: 'originalImage', data: { type: 'originalImage', label: '原图' } });
  await expect(toolbar).toBeVisible();
  await expect(page.getByRole('region', { name: '节点控制台' })).toHaveCount(0);
  for (const name of ['预览', '下载', '删除图片']) await expect(toolbar.getByRole('button', { name, exact: true })).toBeDisabled();
  const chooser = page.waitForEvent('filechooser');
  await toolbar.getByRole('button', { name: '上传图片', exact: true }).click();
  await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('png') });
  await expect(node.getByAltText('Uploaded image')).toBeVisible();
  await expect(toolbar.getByRole('button', { name: '重新上传', exact: true })).toBeVisible();
  await toolbar.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.locator('body > div.fixed img')).toHaveAttribute('src', imageUrl);
  await page.keyboard.press('Escape');
  const download = page.waitForEvent('download');
  await toolbar.getByRole('button', { name: '下载', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^image-\d+\.png$/);
  await toolbar.getByRole('button', { name: '删除图片', exact: true }).click();
  await expect(node.getByAltText('Uploaded image')).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: '上传图片', exact: true })).toBeVisible();
});

test('角色：节点展示区显示角色信息，编辑角色和打开角色库在节点工具栏，取消选中不关闭编辑', async ({ page, request }) => {
  const { node, toolbar } = await openSourceNode(page, request, { id: 'hero', type: 'character', data: { type: 'character', label: '角色',
    characterData: { name: '小明', id: 'hero-character', description: '勇敢的少年', tags: ['少年', '勇士'], referenceImages: [swatch('blue'), swatch('green')] } } });
  await expect(node.getByText('小明')).toBeVisible();
  await expect(node.getByText('勇敢的少年')).toBeVisible();
  await expect(node.getByText('勇士')).toBeVisible();
  await expect(page.getByTestId('character-stage').getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '节点控制台' })).toHaveCount(0);
  await toolbar.getByRole('button', { name: '编辑角色', exact: true }).click();
  await expect(page.getByRole('heading', { name: '编辑角色' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '编辑角色' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await node.click();
  await expect(page.getByRole('heading', { name: '编辑角色' })).toHaveCount(0);
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: '打开角色库', exact: true }).click();
  await expect(page.getByText('角色', { exact: true }).first()).toBeVisible();
  const empty = await openSourceNode(page, request, { id: 'blank', type: 'character', data: { type: 'character', label: '角色' } });
  await expect(empty.toolbar.getByRole('button', { name: '编辑角色', exact: true })).toBeDisabled();
  await expect(empty.toolbar.getByRole('button', { name: '打开角色库', exact: true })).toBeEnabled();
});

test('原图：上传失败时节点展示区显示错误，依赖图片的操作不可用，删除图片可以清除错误', async ({ page, request }) => {
  const { node, toolbar } = await openSourceNode(page, request, { id: 'original', type: 'originalImage', data: { type: 'originalImage', label: '原图', imageSrc: result, error: '上传失败了' } });
  await expect(node).toContainText('上传失败了');
  for (const name of ['预览', '下载', '保存为角色']) await expect(toolbar.getByRole('button', { name, exact: true })).toBeDisabled();
  await toolbar.getByRole('button', { name: '删除图片', exact: true }).click();
  await expect(node).not.toContainText('上传失败了');
  await expect(toolbar.getByRole('button', { name: '上传图片', exact: true })).toBeVisible();
});
