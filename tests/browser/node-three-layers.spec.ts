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

const editorOf = (page: Page) => page.getByRole('region', { name: '节点控制台' }).getByRole('textbox', { name: '提示词' });
const savedPrompt = async (request: APIRequestContext, page: Page) => {
  const id = new URL(page.url()).searchParams.get('project');
  const { data } = await (await request.get(`/api/workflow/${id}`)).json();
  return data.nodes.find((node: { id: string }) => node.id === 'image').data.prompt;
};

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
  await page.locator('.react-flow__node[data-id="garden"]').click();
  await page.locator('.react-flow__node[data-id="garden"] textarea').fill('新花园');
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
