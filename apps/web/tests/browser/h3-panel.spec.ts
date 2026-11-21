import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import path from 'node:path';
import type { CreateGeneration, GenerationTask } from '../../lib/generation/types';

const assets = 'https://h3-fixture.test';
const fixture = (extension: string) => path.join(process.cwd(), 'tests/fixtures/h3/reference.' + extension);
async function mocks(page: Page) {
  await page.route('**/api/canvas-preview?**', route => route.fulfill({ path: fixture('png'), contentType: 'image/png' }));
  await page.route('**/api/generation/models', async route => {
    const response = await route.fetch();
    const models = await response.json();
    await route.fulfill({ json: models.map((model: Record<string, unknown>) => ({ ...model, configured: true })) });
  });
  await page.route(assets + '/**', route => {
    const ext = new URL(route.request().url()).pathname.split('.').pop()!;
    return route.fulfill({ path: fixture(ext), contentType: { png: 'image/png', mp4: 'video/mp4', wav: 'audio/wav' }[ext] });
  });
}
async function open(page: Page, request: APIRequestContext, connected = false, data: Record<string, unknown> = {}, nodeType = 'imageToVideo', textInput = false) {
  await mocks(page);
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.addInitScript(() => localStorage.setItem('canvas-theme', 'dark'));
  const id = crypto.randomUUID();
  const response = await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'H3 集成验收', nodes: [
      { id: 'h3', type: nodeType, position: { x: 420, y: 60 }, data: { label: 'H3', type: nodeType, model: 'runninghub-h3',
        usesGenerationTasks: true, prompt: '人物走过田野', ...data } },
      ...(textInput ? [{ id: 'story', type: 'text', position: { x: -200, y: 60 }, data: { type: 'text', label: '故事', prompt: '清晨，人物走过田野' } }] : []),
      ...(connected ? [
        { id: 'source-image', type: 'originalImage', position: { x: -100, y: 40 }, data: { type: 'originalImage', label: '角色图', imageSrc: assets + '/linked.png' } },
        { id: 'source-video', type: 'textToVideo', position: { x: -100, y: 420 }, data: { type: 'textToVideo', label: '动作视频', videoSrc: assets + '/linked.mp4' } },
      ] : [])
    ], edges: connected ? ['image', 'video'].map(kind => ({ id: 'link-' + kind, source: 'source-' + kind, target: 'h3', sourceHandle: 'output', targetHandle: 'input' })) : textInput ? [{ id: 'text-link', source: 'story', target: 'h3', sourceHandle: 'output', targetHandle: 'input' }] : [],
    viewport: { x: 0, y: 0, zoom: 1 } } } });
  expect(response.ok()).toBeTruthy();
  await page.goto(`/?project=${id}`);
  const node = page.locator('.react-flow__node[data-id="h3"]');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await node.getByText('H3', { exact: true }).first().click();
  await expect(page.getByRole('region', { name: '节点控制台' })).toBeVisible();
  return { id, node, read: async () => (await (await request.get(`/api/workflow/${id}`)).json()).data.nodes.find((n: { id: string }) => n.id === 'h3').data };
}

test('H3 combines canvas references and uploads, persists ordering and submits the displayed video parameters', async ({ page, request }, testInfo) => {
  const { read } = await open(page, request, true);
  const refs = page.getByTestId('video-reference');
  await expect(refs).toHaveCount(2);
  const uploadResults = [
    { kind: 'image', url: assets + '/upload.png' }, { kind: 'audio', url: assets + '/voice.wav' },
  ];
  await page.route('**/api/upload/reference', route => route.fulfill({ json: uploadResults.shift() }));
  await page.getByTestId('reference-file-input').setInputFiles([fixture('png'), fixture('wav')]);
  await expect(refs).toHaveCount(4);
  await expect(refs.nth(3)).toContainText('<Audio 2>');
  await page.getByRole('checkbox', { name: '<Video 1> 参考原声' }).uncheck();
  await expect(refs.nth(3)).toContainText('<Audio 1>');
  await page.getByRole('button', { name: '上移素材 3' }).click();
  await page.getByRole('button', { name: '上移素材 2' }).click();
  await expect(refs.first()).toContainText('reference.png');
  await page.getByRole('combobox', { name: '视频分辨率' }).selectOption('1080p');
  await page.getByRole('combobox', { name: '视频画幅' }).selectOption('9:16');
  await page.getByRole('combobox', { name: '视频目标时长' }).selectOption('7');
  await expect(page.getByRole('combobox', { name: '视频画幅' })).toHaveValue('9:16');
  const channel = page.getByRole('button', { name: '高性能 48G 渠道' });
  const memoryHint = page.getByText('1080p 在标准渠道可能显存不足');
  await expect(channel).toHaveAttribute('aria-pressed', 'false'); await expect(memoryHint).toBeVisible();
  await channel.click(); await expect(channel).toHaveAttribute('aria-pressed', 'true');
  await expect(memoryHint).toHaveCount(0);
  await refs.first().getByRole('button', { name: '<Picture 1>', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '提示词' })).toHaveText('人物走过田野<Picture 1>');
  await expect.poll(async () => (await read()).videoReferenceAudio?.['node:source-video']).toBe(false);
  await expect.poll(async () => (await read()).videoResolution).toBe('1080p');
  await expect.poll(async () => (await read()).videoInstanceType).toBe('plus');
  await page.reload();
  await page.locator('.react-flow__node[data-id="h3"]').click();
  await expect(refs).toHaveCount(4); await expect(refs.first()).toContainText('reference.png');
  await expect(page.getByRole('checkbox', { name: '<Video 1> 参考原声' })).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('h3-full-panel.png'), animations: 'disabled' });
  let submitted: CreateGeneration | undefined;
  await page.route('**/api/generation/tasks', async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { error: '测试捕获参数，未提交平台' } });
  });
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => submitted?.input.width).toBe(1088);
  expect(submitted?.input.height).toBe(1920); expect(submitted?.input.duration).toBe(7);
  expect(submitted?.input.instanceType).toBe('plus');
  expect(submitted?.input.references).toEqual([
    { kind: 'image', url: assets + '/upload.png' }, { kind: 'image', url: assets + '/linked.png' },
    { kind: 'video', url: assets + '/linked.mp4', useAudio: false }, { kind: 'audio', url: assets + '/voice.wav' },
  ]);
  await page.getByRole('button', { name: '移除素材 3' }).click();
  await expect(refs).toHaveCount(3);
  await expect(page.locator('.react-flow__edge[data-id="link-video"]')).toHaveCount(0);
});

for (const nodeType of ['imageToVideo', 'textToVideo']) test(`${nodeType}: H3 restores a saved MP4 after refresh without submitting generation again`, async ({ page, request }, testInfo) => {
  let result: GenerationTask | undefined; let submits = 0;
  await page.route('**/api/generation/tasks', async route => {
    submits++;
    const submitted: CreateGeneration = route.request().postDataJSON();
    result = { ...submitted, id: 'h3-task', outputType: 'video', modelVersion: '1', status: 'succeeded', saveStatus: 'saved',
      revision: 3, createdAt: Date.now(), updatedAt: Date.now(), deadline: null, artifacts: [assets + '/saved.mp4'], error: null };
    await route.fulfill({ json: { ...result, status: 'queued', revision: 0, artifacts: [] } });
  });
  await page.route('**/api/generation/tasks/h3-task', route => route.fulfill({ json: result }));
  await page.route('**/api/generation/events', route => route.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(result ? [result] : [])}\n\n` }));
  const { read } = await open(page, request, false, {}, nodeType);
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page.getByTestId('video-preview').getByRole('img', { name: '视频封面' })).toBeVisible();
  await expect.poll(async () => (await read()).videoSrc).toBe(assets + '/saved.mp4');
  expect((await read()).imageSrc).toBeUndefined();
  await page.reload();
  const restored = page.locator('.react-flow__node[data-id="h3"]');
  await restored.getByText('H3', { exact: true }).first().click();
  await expect(restored.getByRole('img', { name: '视频封面' })).toBeVisible();
  await expect(page.getByRole('region', { name: '节点控制台' }).getByRole('status')).toHaveText('已保存');
  await page.screenshot({ path: testInfo.outputPath('h3-recovered-video.png'), animations: 'disabled' });
  expect(submits).toBe(1);
});

test('upload limits prevent extra requests and H3 selection preserves legacy video controls', async ({ page, request }) => {
  let uploads = 0;
  await page.route('**/api/upload/reference', route => { uploads++; return route.fulfill({ json: {} }); });
  await open(page, request);
  await page.getByTestId('reference-file-input').setInputFiles(Array.from({ length: 10 }, (_, i) => ({ name: `image-${i}.png`, mimeType: 'image/png', buffer: Buffer.from('fixture') })));
  await expect(page.getByRole('region', { name: '节点控制台' }).getByRole('alert')).toContainText('最多支持 9 张图片'); expect(uploads).toBe(0);
  await page.getByRole('combobox', { name: '视频模型' }).selectOption('sora-2');
  await expect(page.getByTestId('reference-file-input')).toHaveCount(0);
  await expect(page.getByText('请连接一个图片节点作为输入')).toBeVisible();
  await page.getByRole('combobox', { name: '视频模型' }).selectOption('runninghub-h3');
  await expect(page.getByTestId('reference-file-input')).toHaveCount(1);
});

test('H3 connected references are node references that follow reordering and send its own format', async ({ page, request }) => {
  await open(page, request, true, { prompt: '' });
  const refs = page.getByTestId('video-reference');
  const editor = page.getByRole('textbox', { name: '提示词' });
  await editor.click();
  await page.keyboard.type('让@');
  await page.getByRole('listbox', { name: '引用连接的节点' }).getByRole('option', { name: /Video 1/ }).click();
  await page.keyboard.type('像');
  await refs.first().getByRole('button', { name: '<Picture 1>', exact: true }).click();
  await expect(editor.locator('[data-node-reference]')).toHaveText([/<Video 1>$/, '<Picture 1>']);
  let submitted: CreateGeneration | undefined;
  await page.route('**/api/generation/tasks', async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { error: '测试捕获参数，未提交平台' } });
  });
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => submitted?.input.prompt).toBe('让<Video 1>像<Picture 1>');
  await page.getByRole('button', { name: '移除素材 2' }).click();
  await expect(editor).toHaveText('让@动作视频像<Picture 1>');
});

test('H3 has the node toolbar; drag hides the console', async ({ page, request }) => {
  const { node } = await open(page, request, false, { videoSrc: assets + '/saved.mp4' });
  await expect(page.getByRole('toolbar', { name: '节点工具栏' }).getByRole('button', { name: '预览', exact: true })).toBeEnabled();
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 40, { steps: 5 });
  await expect(page.getByRole('region', { name: '节点控制台' })).toHaveCount(0);
  await page.mouse.up();
});

test('H3 reference to a connected node with no material shows and sends its name', async ({ page, request }) => {
  await mocks(page);
  const id = crypto.randomUUID();
  expect((await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: { name: 'H3', nodes: [
    { id: 'h3', type: 'imageToVideo', position: { x: 420, y: 60 }, data: { label: 'H3', type: 'imageToVideo', model: 'runninghub-h3', usesGenerationTasks: true, prompt: [{ text: '让' }, { ref: 'empty' }] } },
    { id: 'empty', type: 'originalImage', position: { x: -100, y: 40 }, data: { type: 'originalImage', label: '空图' } },
  ], edges: [{ id: 'link', source: 'empty', target: 'h3', sourceHandle: 'output', targetHandle: 'input' }], viewport: { x: 0, y: 0, zoom: 1 } } } })).ok()).toBeTruthy();
  await page.goto(`/?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.locator('.react-flow__node[data-id="h3"]').click();
  await expect(page.getByRole('textbox', { name: '提示词' })).toContainText('让');
  await expect(page.getByRole('textbox', { name: '提示词' }).locator('[data-node-reference]')).toContainText('空图');
  let submitted: CreateGeneration | undefined;
  await page.route('**/api/generation/tasks', async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { error: '测试捕获参数，未提交平台' } });
  });
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => submitted?.input.prompt).toBe('让空图');
});


test('text-to-video selects H3, keeps text references and submits without reference media', async ({ page, request }) => {
  const { read } = await open(page, request, false, { model: 'Sora 2', usesGenerationTasks: false, prompt: [{ text: '拍摄：' }, { ref: 'story' }] }, 'textToVideo', true);
  const select = page.getByRole('combobox', { name: '视频模型' });
  await select.selectOption('runninghub-h3');
  await expect(page.getByRole('combobox', { name: '视频分辨率' })).toBeVisible();
  await select.selectOption('Sora 2');
  await expect(page.getByRole('combobox', { name: '视频时长' })).toBeVisible();
  await select.selectOption('runninghub-h3');
  await page.getByRole('combobox', { name: '视频分辨率' }).selectOption('480p');
  await page.getByRole('combobox', { name: '视频画幅' }).selectOption('9:16');
  await page.getByRole('combobox', { name: '视频目标时长' }).selectOption('10');
  await expect.poll(async () => (await read()).model).toBe('runninghub-h3');
  let submitted: CreateGeneration | undefined;
  let legacyRequests = 0;
  await page.route('**/api/generate/video', route => { legacyRequests++; return route.fulfill({ status: 400, json: { error: 'wrong endpoint' } }); });
  await page.route('**/api/generation/tasks', route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: '测试捕获参数，未提交平台' } });
  });
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => submitted?.input.prompt).toBe('拍摄：清晨，人物走过田野');
  expect(submitted?.modelId).toBe('runninghub-h3');
  expect(submitted?.input.references).toEqual([]);
  expect(submitted?.input.duration).toBe(10);
  expect(submitted?.input.width).toBeLessThan(submitted!.input.height);
  expect(legacyRequests).toBe(0);
});
