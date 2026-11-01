import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const snapshot = (name: string) => ({ name, nodes: [{ id: 'text-node', type: 'text', position: { x: 120, y: 160 }, data: { label: 'Text', type: 'text', prompt: name } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
async function seed(request: APIRequestContext, name: string) {
  const id = crypto.randomUUID();
  expect((await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: snapshot(name) } })).ok()).toBeTruthy();
  return id;
}
const read = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/workflow/${id}`)).json()).data;
async function rename(page: Page, before: string, after: string) {
  await page.getByRole('button', { name: before, exact: true }).click();
  await page.getByPlaceholder('项目名称...').fill(after);
  await page.getByPlaceholder('项目名称...').press('Enter');
}
async function switchCanvas(page: Page, name: string) {
  await page.getByRole('button', { name: '项目', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^${name} 1 节点`) }).click();
}
async function drafts(page: Page) {
  return page.evaluate(() => new Promise<{ id: string; snapshot: { name: string }; recovery?: { kind: string } }[]>((resolve, reject) => {
    const open = indexedDB.open('ai-flow-canvas');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('drafts'), get = tx.objectStore('drafts').getAll();
      tx.oncomplete = () => { db.close(); resolve(get.result); };
    };
  }));
}

test('switching away from a hanging or failing A saves B independently and restores both identities', async ({ page, request }) => {
  const a = await seed(request, '隔离 A'), b = await seed(request, '隔离 B');
  await page.goto(`/?project=${a}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  let release!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/workflow/${a}`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    started = true; await gate; await route.continue();
  });
  await rename(page, '隔离 A', 'A 挂起修改');
  await expect.poll(() => started).toBeTruthy();
  try {
    await switchCanvas(page, '隔离 B');
    await rename(page, '隔离 B', 'B 独立保存');
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
    expect((await read(request, b)).name).toBe('B 独立保存');
    expect((await read(request, a)).name).toBe('隔离 A');
    await switchCanvas(page, '隔离 A');
    await expect(page.getByRole('button', { name: 'A 挂起修改', exact: true })).toBeVisible();
  } finally { release(); }
  await expect.poll(async () => (await read(request, a)).name).toBe('A 挂起修改');
  await page.unroute(`**/api/workflow/${a}`);
  await page.route(`**/api/workflow/${a}`, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await rename(page, 'A 挂起修改', 'A 离线保留');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('同步失败/冲突');
  await switchCanvas(page, 'B 独立保存');
  await rename(page, 'B 独立保存', 'B 持续成功');
  await expect.poll(async () => (await read(request, b)).name).toBe('B 持续成功');
  await page.reload();
  await expect(page.getByRole('button', { name: 'B 持续成功', exact: true })).toBeVisible();
  await page.unroute(`**/api/workflow/${a}`);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await read(request, a)).name).toBe('A 离线保留');
  expect(new URL(page.url()).searchParams.get('project')).toBe(b);
  expect((await read(request, a)).nodes[0].data.prompt).toBe('隔离 A');
  expect((await read(request, b)).nodes[0].data.prompt).toBe('隔离 B');
});

test('a stale tab preserves newer IndexedDB content and exposes its own edits as a recoverable new canvas', async ({ page, context, request }) => {
  const id = await seed(request, '共享原稿');
  await page.goto(`/?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const stale = await context.newPage();
  await stale.goto(`/?project=${id}`);
  await expect(stale.getByTestId('canvas-save-status')).toHaveText('已同步');
  await rename(page, '共享原稿', '较新标签内容');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await rename(stale, '共享原稿', '陈旧标签内容');
  await expect(stale.getByText('这是独立恢复副本，可另存为新画布。')).toBeVisible();
  expect((await drafts(page)).find(draft => draft.id === id)?.snapshot.name).toBe('较新标签内容');
  expect((await read(request, id)).name).toBe('较新标签内容');
  await stale.getByRole('button', { name: '将本地内容另存为新画布', exact: true }).click();
  await expect(stale.getByTestId('canvas-save-status')).toHaveText('已同步');
  await expect.poll(() => new URL(stale.url()).searchParams.get('project')).not.toBe(id);
  const copy = new URL(stale.url()).searchParams.get('project')!;
  expect((await read(request, copy)).name).toBe('陈旧标签内容');
  expect((await read(request, id)).name).toBe('较新标签内容');
});

test('two tabs replay the same durable request without advancing the server version twice', async ({ page, context, request }) => {
  const id = await seed(request, '重放原稿');
  await page.goto(`/?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const other = await context.newPage();
  await other.goto(`/?project=${id}`);
  await expect(other.getByTestId('canvas-save-status')).toHaveText('已同步');
  let release!: () => void, firstRequest: string | undefined, secondRequest: string | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/workflow/${id}`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    firstRequest = route.request().postDataJSON().requestId;
    const response = await route.fetch();
    await gate; await route.fulfill({ response });
  });
  other.on('request', req => { if (req.method() === 'PUT') secondRequest = req.postDataJSON().requestId; });
  await rename(page, '重放原稿', '一次生效');
  try {
    await expect.poll(async () => (await read(request, id)).name).toBe('一次生效');
    await other.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => secondRequest).toBe(firstRequest);
    expect((await read(request, id)).version).toBe(2);
  } finally { release(); }
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect((await read(request, id)).version).toBe(2);
});

for (const choice of ['server', 'copy'] as const) {
  test(`independent client conflict preserves both contents when choosing ${choice}`, async ({ page, browser, request }) => {
    const id = await seed(request, `冲突原稿 ${choice}`);
    await page.goto(`/?project=${id}`);
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
    const remoteContext = await browser.newContext();
    const remote = await remoteContext.newPage();
    await remote.goto(`http://127.0.0.1:3217/?project=${id}`);
    await expect(remote.getByTestId('canvas-save-status')).toHaveText('已同步');
    await rename(remote, `冲突原稿 ${choice}`, `远端 ${choice}`);
    await expect(remote.getByTestId('canvas-save-status')).toHaveText('已同步');
    await rename(page, `冲突原稿 ${choice}`, `本地 ${choice}`);
    await expect(page.getByText('本地草稿与服务端不同，双方内容均已保留。')).toBeVisible();
    expect((await read(request, id)).name).toBe(`远端 ${choice}`);
    await page.reload();
    await expect(page.getByText('本地草稿与服务端不同，双方内容均已保留。')).toBeVisible();
    await page.getByRole('button', { name: choice === 'server' ? '采用服务端版本' : '将本地内容另存为新画布', exact: true }).click();
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
    expect((await read(request, id)).name).toBe(`远端 ${choice}`);
    if (choice === 'server') {
      expect((await drafts(page)).some(draft => draft.recovery?.kind === 'copy' && draft.snapshot.name === '本地 server')).toBeTruthy();
    } else {
      await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(id);
      expect((await read(request, new URL(page.url()).searchParams.get('project')!)).name).toBe('本地 copy');
    }
    await remoteContext.close();
  });
}

test('offline edits cannot revive a deleted canvas and saving a copy uses a new identity', async ({ page, request }) => {
  const id = await seed(request, '即将删除');
  await page.goto(`/?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.route(`**/api/workflow/${id}`, route => route.abort());
  await rename(page, '即将删除', '离线保留副本');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('同步失败/冲突');
  expect((await request.delete(`/api/workflow/${id}`)).ok()).toBeTruthy();
  await page.unroute(`**/api/workflow/${id}`);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('服务端项目已删除，本地内容已保留。可另存为新画布。')).toBeVisible();
  await page.reload();
  await expect(page.getByText('服务端项目已删除，本地内容已保留。可另存为新画布。')).toBeVisible();
  expect((await request.get(`/api/workflow/${id}`)).status()).toBe(410);
  const list = (await (await request.get('/api/workflow')).json()).data;
  expect(list.some((canvas: { id: string }) => canvas.id === id)).toBeFalsy();
  // Once the user leaves the deleted project, its local content must remain
  // discoverable after reload even though it no longer appears in the API list.
  await page.getByRole('button', { name: '项目', exact: true }).click();
  await page.getByRole('button', { name: '新建项目 创建空白画布' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBeNull();
  await page.reload();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('尚未保存');
  await page.getByText('恢复副本（1）').click();
  await page.getByRole('button', { name: '打开恢复副本：离线保留副本' }).click();
  await expect(page.getByText('服务端项目已删除，本地内容已保留。可另存为新画布。')).toBeVisible();
  await page.getByRole('button', { name: '将本地内容另存为新画布', exact: true }).click();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(id);
  const copyId = new URL(page.url()).searchParams.get('project')!;
  expect((await read(request, copyId)).name).toBe('离线保留副本');
  expect((await request.get(`/api/workflow/${id}`)).status()).toBe(410);
});

for (const action of ['clear', 'import'] as const) {
  test(`${action} preserves the old canvas pending edit and starts a distinct project`, async ({ page, request }) => {
    const id = await seed(request, `原项目 ${action}`);
    await page.goto(`/?project=${id}`);
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
    await rename(page, `原项目 ${action}`, `切换前修改 ${action}`);
    if (action === 'clear') {
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: '清空', exact: true }).click();
      await expect(page.locator('.react-flow__node')).toHaveCount(0);
      await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBeNull();
      await page.reload();
      await expect(page.getByTestId('canvas-save-status')).toHaveText('尚未保存');
      await expect(page.locator('.react-flow__node')).toHaveCount(0);
    } else {
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '导入', exact: true }).click();
      await (await chooser).setFiles({ name: 'canvas.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ ...snapshot('导入的项目'), projectName: '导入的项目' })) });
      await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
      await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(id);
      const importedId = new URL(page.url()).searchParams.get('project')!;
      expect((await read(request, importedId)).name).toBe('导入的项目');
    }
    await expect.poll(async () => (await read(request, id)).name).toBe(`切换前修改 ${action}`);
    expect((await read(request, id)).nodes[0].data.prompt).toBe(`原项目 ${action}`);
  });
}
