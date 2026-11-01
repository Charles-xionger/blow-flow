import { test, expect, type Page } from '@playwright/test';

async function addTextNode(page: Page) {
  // Use the application's real drop handler, with no store or persistence mocks.
  await page.locator('.react-flow').dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.setData('application/reactflow-nodetype', 'text');
      return transfer;
    }), clientX: 500, clientY: 200,
  });
}

async function localDraft(page: Page, id: string) {
  return page.evaluate(id => new Promise<{ localVersion: number; confirmedLocalVersion: number; snapshot: { nodes: unknown[] } }>((resolve, reject) => {
    const open = indexedDB.open('ai-flow-canvas');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('drafts');
      const get = tx.objectStore('drafts').get(id);
      tx.oncomplete = () => { db.close(); resolve(get.result); };
    };
  }), id);
}

test('editing a canvas survives clearing browser storage and deleting its last node', async ({ page, request, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('尚未保存');
  await addTextNode(page);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const id = new URL(page.url()).searchParams.get('project')!;
  expect(id).toBeTruthy();
  const read = async () => (await (await request.get(`/api/workflow/${id}`)).json()).data;
  expect((await read()).nodes).toHaveLength(1);
  const local = await localDraft(page, id);
  expect(local.snapshot.nodes).toHaveLength(1);
  expect(local.localVersion).toBe(local.confirmedLocalVersion);
  await page.locator('.react-flow__node').click();
  await page.getByPlaceholder('输入文本描述...').fill('浏览器真实编辑');
  await expect.poll(async () => (await read()).nodes[0].data.prompt).toBe('浏览器真实编辑');
  await expect(page.getByPlaceholder('输入文本描述...')).toBeFocused();
  await page.getByPlaceholder('输入文本描述...').fill('快捷键保存文字');
  await page.getByPlaceholder('输入文本描述...').press('ControlOrMeta+s');
  await expect.poll(async () => (await read()).nodes[0].data.prompt).toBe('快捷键保存文字');
  const version = (await read()).version;
  // A new browser context has no IndexedDB/localStorage and reads the same SQLite-backed API.
  const clean = await context.browser()!.newContext();
  const reopened = await clean.newPage();
  await reopened.goto(`http://127.0.0.1:3217/?project=${id}`);
  await expect(reopened.getByTestId('canvas-save-status')).toHaveText('已同步');
  await expect(reopened.getByText('快捷键保存文字', { exact: true })).toBeVisible();
  await reopened.locator('.react-flow__node').click();
  await reopened.keyboard.press('Backspace');
  await expect.poll(async () => (await read()).nodes.length).toBe(0);
  await expect(reopened.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect((await read()).version).toBeGreaterThan(version);
  await clean.close();
});


test('local transaction abort prevents server-only saving', async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      if (this.name === 'drafts') request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
  });
  let writes = 0;
  page.on('request', request => { if (request.url().includes('/api/workflow') && request.method() === 'PUT') writes++; });
  await page.goto('/');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('尚未保存');
  await addTextNode(page);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('本地保存失败');
  expect(writes).toBe(0);
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
});

test('restoration preserves pending local edits instead of replacing them with server content', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('尚未保存');
  await addTextNode(page);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const id = new URL(page.url()).searchParams.get('project')!;
  await page.route('**/api/workflow/*', route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await page.getByRole('button', { name: '未命名项目', exact: true }).click();
  await page.getByPlaceholder('项目名称...').fill('本地待同步名称');
  await page.getByPlaceholder('项目名称...').press('Enter');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('同步失败/冲突');
  const draft = await localDraft(page, id);
  expect(draft.localVersion).toBeGreaterThan(draft.confirmedLocalVersion);
  await page.reload();
  await expect(page.getByRole('button', { name: '本地待同步名称', exact: true })).toBeVisible();
  await expect(page.getByTestId('canvas-save-status')).not.toHaveText('已同步');
  await page.unroute('**/api/workflow/*');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect((await (await request.get(`/api/workflow/${id}`)).json()).data.name).toBe('本地待同步名称');
});

test('real API rejects legacy writes and replays versioned requests without advancing twice', async ({ request }) => {
  const id = crypto.randomUUID();
  const operation = { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name: 'HTTP protocol', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } };
  const first = await request.post('/api/workflow', { data: operation });
  expect(first.status()).toBe(200);
  expect((await first.json()).data).toEqual({ id, requestId: operation.requestId, version: 1 });
  expect((await (await request.put(`/api/workflow/${id}`, { data: operation })).json()).data.version).toBe(1);
  expect((await request.put(`/api/workflow/${id}`, { data: { ...operation, requestId: crypto.randomUUID() } })).status()).toBe(409);
  expect((await request.put(`/api/workflow/${id}`, { data: { name: 'unversioned' } })).status()).toBe(400);
  expect((await request.post('/api/workflow', { data: operation.snapshot })).status()).toBe(400);
  expect((await request.put('/api/workflow/wrong-id', { data: operation })).status()).toBe(400);
});

test('API offline edits survive refresh and automatically sync into a clean browser', async ({ page, request, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('尚未保存');
  await addTextNode(page);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const id = new URL(page.url()).searchParams.get('project')!;
  // Static assets stay online: this tests API recovery, not an offline app shell.
  await page.route('**/api/workflow/**', route => route.abort());
  await page.locator('.react-flow__node').click();
  await page.getByPlaceholder('输入文本描述...').fill('离线编辑后刷新');
  await page.getByRole('button', { name: '未命名项目', exact: true }).click();
  await page.getByPlaceholder('项目名称...').fill('离线恢复项目');
  await page.getByPlaceholder('项目名称...').press('Enter');
  await expect.poll(async () => (await localDraft(page, id)).localVersion).toBeGreaterThan(1);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('同步失败/冲突');
  const before = await localDraft(page, id);
  await page.reload();
  await expect(page.getByRole('button', { name: '离线恢复项目', exact: true })).toBeVisible();
  await expect(page.getByText('离线编辑后刷新', { exact: true })).toBeVisible();
  expect((await localDraft(page, id)).snapshot).toEqual(before.snapshot);
  // Let restoration/layout events settle while the API is still unavailable.
  await page.waitForTimeout(2500);
  await page.unroute('**/api/workflow/**');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步', { timeout: 35_000 });
  const remote = (await (await request.get(`/api/workflow/${id}`)).json()).data;
  expect(remote.name).toBe('离线恢复项目');
  expect(remote.nodes).toEqual(before.snapshot.nodes);
  const clean = await context.browser()!.newContext();
  try {
    const reopened = await clean.newPage();
    await reopened.goto(`http://127.0.0.1:3217/?project=${id}`);
    await expect(reopened.getByRole('button', { name: '离线恢复项目', exact: true })).toBeVisible();
    await expect(reopened.getByText('离线编辑后刷新', { exact: true })).toBeVisible();
    await expect(reopened.getByTestId('canvas-save-status')).toHaveText('已同步');
  } finally { await clean.close(); }
});

for (const mode of ['create', 'update'] as const) {
  test(`lost ${mode} acknowledgement replays after refresh without duplicate versions and keeps newer edits`, async ({ page, request, context }) => {
    await page.goto('/');
    await expect(page.getByTestId('canvas-save-status')).toHaveText('尚未保存');
    if (mode === 'update') {
      await addTextNode(page);
      await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
    }
    const sent: { id: string; requestId: string; baseVersion: number; localVersion: number; snapshot: unknown }[] = [];
    let dropResponse = true;
    let committedVersion = 0;
    await page.route('**/api/workflow/*', async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      sent.push(route.request().postDataJSON());
      if (!dropResponse) return route.continue();
      // Real HTTP reaches the isolated SQLite transaction, then its response is lost.
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committedVersion = (await response.json()).data.version;
      await route.abort('failed');
    });
    if (mode === 'create') await addTextNode(page);
    else {
      await page.locator('.react-flow__node').click();
      await page.getByPlaceholder('输入文本描述...').fill('服务端已写入但响应丢失');
    }
    await expect.poll(() => committedVersion).toBe(mode === 'create' ? 1 : 2);
    const original = sent[0];
    const id = original.id;
    await page.locator('.react-flow__node').click();
    await page.getByPlaceholder('输入文本描述...').fill('确认前产生的新修改');
    await expect.poll(async () => (await localDraft(page, id)).localVersion).toBeGreaterThan(original.localVersion);
    const pending = await localDraft(page, id);
    await page.reload();
    await expect(page.getByText('确认前产生的新修改', { exact: true })).toBeVisible();
    expect((await localDraft(page, id)).snapshot).toEqual(pending.snapshot);
    dropResponse = false;
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步', { timeout: 35_000 });
    const remote = (await (await request.get(`/api/workflow/${id}`)).json()).data;
    expect(remote.version).toBe(original.baseVersion + 2);
    expect(remote.nodes).toEqual(pending.snapshot.nodes);
    const replays = sent.filter(op => op.requestId === original.requestId);
    expect(replays.length).toBeGreaterThan(1);
    for (const replay of replays) expect(replay).toEqual(original);
    const following = sent.find(op => op.requestId !== original.requestId)!;
    expect(following.baseVersion).toBe(original.baseVersion + 1);
    const all = (await (await request.get('/api/workflow')).json()).data;
    // A duplicate create would also contain the original node ID under a new canvas ID.
    const nodeId = remote.nodes[0].id;
    expect(all.filter((canvas: { nodes: { id: string }[] }) => canvas.nodes.some(node => node.id === nodeId))).toHaveLength(1);
    const clean = await context.browser()!.newContext();
    try {
      const reopened = await clean.newPage();
      await reopened.goto(`http://127.0.0.1:3217/?project=${id}`);
      await expect(reopened.getByText('确认前产生的新修改', { exact: true })).toBeVisible();
      await expect(reopened.getByTestId('canvas-save-status')).toHaveText('已同步');
    } finally { await clean.close(); }
  });
}

test('browser reconnect wakes locally committed edits without manual saving', async ({ page, context, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('尚未保存');
  await addTextNode(page);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const id = new URL(page.url()).searchParams.get('project')!;
  await page.locator('.react-flow__node').click();
  await context.setOffline(true);
  await page.getByPlaceholder('输入文本描述...').fill('重新联网后补传');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已保存到本地，待同步');
  const draft = await localDraft(page, id);
  expect(draft.localVersion).toBeGreaterThan(draft.confirmedLocalVersion);
  await context.setOffline(false);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect((await (await request.get(`/api/workflow/${id}`)).json()).data.nodes[0].data.prompt).toBe('重新联网后补传');
});
