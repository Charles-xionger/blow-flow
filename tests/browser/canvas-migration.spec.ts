import { test, expect, type Page } from '@playwright/test';

const snapshot = { name: '升级前草稿', nodes: [{ id: 'legacy-node', type: 'text', position: { x: 80, y: 100 }, data: { label: 'Text', type: 'text', prompt: '升级前保留的文字' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
const legacy = (id: string | null = null, content = snapshot) => JSON.stringify({ version: 0, state: { currentWorkflowId: id, projectName: content.name, nodes: content.nodes, edges: content.edges, viewport: content.viewport, isDarkMode: false } });
async function seed(page: Page, raw: string) {
  await page.addInitScript(raw => {
    if (localStorage.getItem('canvas-storage') === null) localStorage.setItem('canvas-storage', raw);
  }, raw);
}
async function records(page: Page) {
  return page.evaluate(() => new Promise<{ drafts: { id: string; snapshot: typeof snapshot; recovery?: { kind: string } }[]; marker: unknown; operations: unknown[] }>((resolve, reject) => {
    const open = indexedDB.open('ai-flow-canvas');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['drafts', 'metadata', 'operations']);
      const drafts = tx.objectStore('drafts').getAll();
      const marker = tx.objectStore('metadata').get('legacyMigration');
      const operations = tx.objectStore('operations').getAll();
      tx.oncomplete = () => { db.close(); resolve({ drafts: drafts.result, marker: marker.result, operations: operations.result }); };
    };
  }));
}

test('first startup migrates a new legacy canvas once, preserving its backup and independent preferences', async ({ page, request }) => {
  const raw = legacy();
  await seed(page, raw);
  await page.addInitScript(() => {
    localStorage.setItem('generation-node-v1:unrelated', 'keep-generation-record');
    localStorage.setItem('theme', 'dark');
  });
  await page.goto('/');
  await expect(page.getByText('升级前保留的文字', { exact: true })).toBeVisible();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const [first] = (await records(page)).drafts;
  expect(first.id).toBeTruthy();
  expect((await (await request.get(`/api/workflow/${first.id}`)).json()).data.nodes[0].data.prompt).toBe('升级前保留的文字');
  await page.reload();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect((await records(page)).drafts.map(draft => draft.id)).toEqual([first.id]);
  expect(await page.evaluate(() => localStorage.getItem('canvas-storage'))).toBe(raw);
  expect(await page.evaluate(() => localStorage.getItem('generation-node-v1:unrelated'))).toBe('keep-generation-record');
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
});

for (const choice of ['server', 'copy'] as const) {
  test(`different remote content remains untouched until choosing ${choice}`, async ({ page, request }) => {
    const id = crypto.randomUUID();
    const remote = { ...snapshot, name: '服务端版本' };
    expect((await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: remote } })).ok()).toBeTruthy();
    await seed(page, legacy(id));
    let writes = 0;
    page.on('request', req => { if (req.url().endsWith(`/api/workflow/${id}`) && req.method() === 'PUT') writes++; });
    await page.goto('/');
    await expect(page.getByText('本地草稿与服务端不同，双方内容均已保留。')).toBeVisible();
    expect(writes).toBe(0);
    expect((await records(page)).operations).toHaveLength(0);
    await page.getByRole('button', { name: choice === 'server' ? '采用服务端版本' : '将本地内容另存为新画布', exact: true }).click();
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
    const savedRemote = (await (await request.get(`/api/workflow/${id}`)).json()).data;
    expect(savedRemote.name).toBe('服务端版本');
    expect(savedRemote.version).toBe(1);
    if (choice === 'server') {
      await expect(page.getByRole('button', { name: '服务端版本', exact: true })).toBeVisible();
      await page.getByText('恢复副本（1）').click();
      await page.getByRole('button', { name: '打开恢复副本：升级前草稿' }).click();
      await expect(page.getByRole('button', { name: '升级前草稿', exact: true })).toBeVisible();
    } else {
      const savedCopy = (await records(page)).drafts.find(draft => draft.id !== id && !draft.recovery)!;
      expect((await (await request.get(`/api/workflow/${savedCopy.id}`)).json()).data.nodes[0].data.prompt).toBe('升级前保留的文字');
    }
    expect(writes).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('canvas-storage'))).toBe(legacy(id));
  });
}

test('matching legacy and server snapshots establish a baseline without any remote write', async ({ page, request }) => {
  const id = crypto.randomUUID();
  expect((await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot } })).ok()).toBeTruthy();
  await seed(page, legacy(id));
  let writes = 0;
  page.on('request', req => { if (req.method() === 'PUT') writes++; });
  await page.goto('/');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect(writes).toBe(0);
  expect((await (await request.get(`/api/workflow/${id}`)).json()).data.version).toBe(1);
  await page.reload();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect(writes).toBe(0);
});

for (const raw of ['{broken', JSON.stringify({ version: 0, state: { nodes: [{ id: 'broken' }] } })]) {
  test(`invalid legacy data stays exportable without recording migration success: ${raw.slice(0, 12)}`, async ({ page }) => {
    await seed(page, raw);
    await page.goto('/');
    await expect(page.getByRole('button', { name: '重试迁移' })).toBeVisible();
    expect((await records(page)).marker).toBeUndefined();
    expect((await records(page)).drafts).toHaveLength(0);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出旧草稿原文' }).click();
    const file = await download;
    const stream = await file.createReadStream();
    const chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe(raw);
    expect(await page.evaluate(() => localStorage.getItem('canvas-storage'))).toBe(raw);
    // Correcting the backup and retrying uses the same recovery entry point.
    await page.evaluate(raw => localStorage.setItem('canvas-storage', raw), legacy());
    await page.getByRole('button', { name: '重试迁移' }).click();
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  });
}

test('an interrupted migration rolls back its marker and imported draft, then retries successfully', async ({ page }) => {
  const raw = legacy();
  await seed(page, raw);
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      if (this.name === 'drafts' && !sessionStorage.getItem('migration-aborted')) {
        request.addEventListener('success', () => {
          sessionStorage.setItem('migration-aborted', 'true');
          this.transaction.abort();
        });
      }
      return request;
    };
  });
  let writes = 0;
  page.on('request', req => { if (req.method() === 'PUT') writes++; });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '重试迁移' })).toBeVisible();
  expect(await records(page)).toEqual({ drafts: [], operations: [], marker: undefined });
  expect(writes).toBe(0);
  await page.getByRole('button', { name: '重试迁移' }).click();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect((await records(page)).drafts).toHaveLength(1);
  expect((await records(page)).marker).toBeTruthy();
  expect(await page.evaluate(() => localStorage.getItem('canvas-storage'))).toBe(raw);
});

test('migration and recovery copies never submit a pending generation request', async ({ page, request }) => {
  const id = crypto.randomUUID();
  const pending = { requestId: crypto.randomUUID(), nodeId: 'legacy-node', canvasId: id, modelId: 'legacy-model', kind: 'image', prompt: 'old task' };
  const content = { ...snapshot, nodes: [{ ...snapshot.nodes[0], type: 'textToImage', data: { ...snapshot.nodes[0].data, type: 'textToImage', pendingGeneration: pending, isLoading: true } }] };
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot } });
  await seed(page, legacy(id, content));
  await page.addInitScript(pending => localStorage.setItem('generation-node-v1:legacy-node', JSON.stringify({ request: pending })), pending);
  const submissions: string[] = [];
  await page.route('**/api/generation/**', async route => {
    if (route.request().method() === 'POST') { submissions.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('本地草稿与服务端不同，双方内容均已保留。')).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  expect(submissions).toEqual([]);
  await expect(page.getByText('生成中...', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '将本地内容另存为新画布', exact: true }).click();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect(submissions).toEqual([]);
  const copy = (await records(page)).drafts.find(draft => draft.id !== id)!;
  expect(copy.snapshot.nodes[0].id).not.toBe('legacy-node');
  expect(copy.snapshot.nodes[0].data).not.toHaveProperty('pendingGeneration', pending);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('generation-node-v1:legacy-node')))!).request).toEqual(pending);
});

test('an existing IndexedDB draft survives collision and the legacy copy remains reachable after restart', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('尚未保存');
  await page.locator('.react-flow').dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.setData('application/reactflow-nodetype', 'text'); return transfer; }),
    clientX: 450, clientY: 200,
  });
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const existing = (await records(page)).drafts[0];
  const raw = legacy(existing.id);
  await page.evaluate(raw => localStorage.setItem('canvas-storage', raw), raw);
  await page.reload();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect((await records(page)).drafts.find(draft => draft.id === existing.id)!.snapshot).toEqual(existing.snapshot);
  await page.getByText('恢复副本（1）').click();
  await page.getByRole('button', { name: '打开恢复副本：升级前草稿' }).click();
  await expect(page.getByText('升级前保留的文字', { exact: true })).toBeVisible();
  const copy = (await records(page)).drafts.find(draft => draft.recovery?.kind === 'copy')!;
  // Opening a draft updates the editor before Next finishes replacing the URL.
  await expect(page).toHaveURL(new RegExp(`project=${copy.id}`));
  await page.reload();
  await expect(page.getByText('升级前保留的文字', { exact: true })).toBeVisible();
  expect((await records(page)).drafts).toHaveLength(2);
  expect((await (await request.get(`/api/workflow/${existing.id}`)).json()).data.nodes).toEqual(existing.snapshot.nodes);
  expect(await page.evaluate(() => localStorage.getItem('canvas-storage'))).toBe(raw);
});

test('API offline migration is readable and cannot upload even after local editing and manual saving', async ({ page, request }) => {
  const id = crypto.randomUUID();
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: { ...snapshot, name: '远端不能被覆盖' } } });
  await seed(page, legacy(id));
  await page.route('**/api/workflow/**', route => route.abort());
  let writes = 0;
  page.on('request', req => { if (req.method() === 'PUT') writes++; });
  await page.goto('/');
  await expect(page.getByText('升级前保留的文字', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '升级前草稿', exact: true }).click();
  await page.getByPlaceholder('项目名称...').fill('离线迁移编辑');
  await page.getByPlaceholder('项目名称...').press('Enter');
  await expect.poll(async () => (await records(page)).drafts[0].snapshot.name).toBe('离线迁移编辑');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '离线迁移编辑', exact: true })).toBeVisible();
  expect(writes).toBe(0);
  expect((await records(page)).operations).toHaveLength(0);
  await page.unroute('**/api/workflow/**');
  await page.getByRole('button', { name: '重试核对', exact: true }).click();
  await expect(page.getByText('本地草稿与服务端不同，双方内容均已保留。')).toBeVisible();
  expect(writes).toBe(0);
  expect((await (await request.get(`/api/workflow/${id}`)).json()).data.name).toBe('远端不能被覆盖');
});

test('adopting remote content freezes editing until the local backup and replacement commit', async ({ page, request }) => {
  const id = crypto.randomUUID();
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: { ...snapshot, name: '采用的远端' } } });
  await seed(page, legacy(id));
  await page.goto('/');
  await expect(page.getByText('本地草稿与服务端不同，双方内容均已保留。')).toBeVisible();
  await page.getByRole('button', { name: '升级前草稿', exact: true }).click();
  await page.getByPlaceholder('项目名称...').fill('选择前最后的编辑');
  await page.getByPlaceholder('项目名称...').press('Enter');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/workflow/${id}`, async route => { await gate; await route.continue(); });
  try {
    await page.getByRole('button', { name: '采用服务端版本', exact: true }).click();
    await expect(page.locator('.react-flow')).not.toBeVisible();
  } finally { release(); }
  await expect(page.getByRole('button', { name: '采用的远端', exact: true })).toBeVisible();
  const copy = (await records(page)).drafts.find(draft => draft.recovery?.kind === 'copy');
  expect(copy!.snapshot.name).toBe('选择前最后的编辑');
});
