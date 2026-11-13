import { test, expect, type Page } from '@playwright/test';

const snapshot = { name: '故障前项目', nodes: [
  { id: 'source', type: 'text', position: { x: 80, y: 100 }, data: { label: 'Text', type: 'text', prompt: '需要完整保留的文字' } },
  { id: 'target', type: 'text', position: { x: 480, y: 100 }, data: { label: 'Text', type: 'text', prompt: '另一个节点' } },
], edges: [{ id: 'link', source: 'source', target: 'target' }], viewport: { x: 30, y: 20, zoom: 0.8 } };

async function rename(page: Page, name: string) {
  await page.getByRole('button', { name: '故障前项目', exact: true }).click();
  await page.getByPlaceholder('项目名称...').fill(name);
  await page.getByPlaceholder('项目名称...').press('Enter');
}

async function downloadText(page: Page, button: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const stream = await (await pending).createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('opening failure keeps the editor gated, explains storage permission, and retries without an empty write', async ({ page, request }) => {
  const id = crypto.randomUUID();
  await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot } });
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args: Parameters<typeof open>) {
      if (args[0] === 'ai-flow-canvas' && !sessionStorage.getItem('storage-recovered')) throw new DOMException('denied', 'SecurityError');
      return open.apply(this, args);
    };
  });
  let writes = 0;
  page.on('request', req => { if (req.method() === 'PUT') writes++; });
  await page.goto(`/?project=${id}`);
  await expect(page.getByRole('button', { name: '重试恢复', exact: true })).toBeVisible();
  await expect(page.getByText('浏览器无法打开本地存储。', { exact: false }).first()).toBeVisible();
  await expect(page.locator('.react-flow')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '导出当前画布', exact: true })).not.toBeVisible();
  expect(writes).toBe(0);
  await page.evaluate(() => sessionStorage.setItem('storage-recovered', 'true'));
  await page.getByRole('button', { name: '重试恢复', exact: true }).click();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await expect(page.getByText('需要完整保留的文字', { exact: true })).toBeVisible();
  expect((await (await request.get(`/api/workflow/${id}`)).json()).data.version).toBe(1);
  expect(writes).toBe(0);
});

for (const failure of ['quota', 'abort'] as const) {
  test(`${failure} during editing retains memory and durable content, exports completely, then retries into SQLite`, async ({ page, request }) => {
    const id = crypto.randomUUID();
    await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot } });
    await page.addInitScript(failure => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
        if (this.name === 'drafts' && sessionStorage.getItem('fail-local-write')) {
          if (failure === 'quota') throw new DOMException('disk full', 'QuotaExceededError');
          const request = put.apply(this, args);
          request.addEventListener('success', () => this.transaction.abort());
          return request;
        }
        return put.apply(this, args);
      };
    }, failure);
    await page.goto(`/?project=${id}`);
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
    await page.evaluate(() => sessionStorage.setItem('fail-local-write', 'true'));
    let writes = 0;
    page.on('request', req => { if (req.method() === 'PUT') writes++; });
    await rename(page, '故障中尚未保存的修改');
    await expect(page.getByTestId('canvas-save-status')).toHaveText('本地保存失败');
    await expect(page.getByRole('alert').filter({ hasText: failure === 'quota' ? '本地存储空间不足' : '本地保存事务已中止' })).toBeVisible();
    await expect(page.getByText('需要完整保留的文字', { exact: true })).toBeVisible();
    expect(writes).toBe(0);
    expect((await (await request.get(`/api/workflow/${id}`)).json()).data.name).toBe('故障前项目');
    const exported = JSON.parse(await downloadText(page, '导出当前画布'));
    expect(exported).toMatchObject({ id, name: '故障中尚未保存的修改', nodes: snapshot.nodes, edges: snapshot.edges, viewport: snapshot.viewport });
    await expect(page.getByTestId('canvas-save-status')).toHaveText('本地保存失败');
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await expect(page.getByTestId('canvas-save-status')).toHaveText('本地保存失败');
    expect(writes).toBe(0);
    await expect(page.getByRole('button', { name: '重试保存', exact: true })).toBeEnabled();
    await page.evaluate(() => sessionStorage.removeItem('fail-local-write'));
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
    const saved = (await (await request.get(`/api/workflow/${id}`)).json()).data;
    expect(saved.name).toBe('故障中尚未保存的修改');
    expect(saved.nodes).toEqual(snapshot.nodes);
    expect(saved.edges).toEqual(snapshot.edges);
    expect(saved.version).toBe(2);
    await page.reload();
    await expect(page.getByRole('button', { name: '故障中尚未保存的修改', exact: true })).toBeVisible();
  });
}

test('a real blocked schema upgrade explains which tabs to close and recovers after the blocker closes', async ({ page, context }) => {
  // Keep a version-1 connection open in a second tab which deliberately does
  // not cooperate with versionchange. The app makes a real version-2 request.
  const blocker = await context.newPage();
  await blocker.route('**/storage-blocker', route => route.fulfill({ contentType: 'text/html', body: '<title>Storage blocker</title>' }));
  await blocker.goto('/storage-blocker');
  await blocker.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('ai-flow-canvas', 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts', { keyPath: 'id' });
      request.result.createObjectStore('operations', { keyPath: 'id' });
      request.result.createObjectStore('metadata');
    };
    request.onsuccess = () => {
      Reflect.set(globalThis, 'storageBlocker', request.result);
      request.result.onversionchange = () => {}; resolve();
    };
  }));
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      return open.call(this, name, name === 'ai-flow-canvas' ? 2 : version!);
    };
  });
  await page.goto('/canvas');
  await expect(page.getByRole('button', { name: '重试恢复', exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '请关闭其他打开此应用的标签页后重试' })).toBeVisible();
  await expect(page.locator('.react-flow')).not.toBeVisible();
  await blocker.close();
  await page.getByRole('button', { name: '重试恢复', exact: true }).click();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('尚未保存');
  await expect(page.locator('.react-flow')).toBeVisible();
});

test('quota failure during migration exports the original backup and retries the same draft into SQLite', async ({ page, request }) => {
  const raw = JSON.stringify({ version: 0, state: { currentWorkflowId: null, projectName: snapshot.name,
    nodes: snapshot.nodes, edges: snapshot.edges, viewport: snapshot.viewport } }, null, 2);
  await page.addInitScript(raw => {
    localStorage.setItem('canvas-storage', raw);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'drafts' && !sessionStorage.getItem('storage-recovered')) throw new DOMException('full', 'QuotaExceededError');
      return put.apply(this, args);
    };
  }, raw);
  const writes: string[] = [];
  page.on('request', req => { if (req.method() === 'PUT') writes.push(req.url()); });
  await page.goto('/canvas');
  await expect(page.getByRole('button', { name: '重试迁移', exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '本地存储空间不足' })).toBeVisible();
  await expect(page.locator('.react-flow')).not.toBeVisible();
  expect(await downloadText(page, '导出旧草稿原文')).toBe(raw);
  expect(writes).toEqual([]);
  await page.evaluate(() => sessionStorage.setItem('storage-recovered', 'true'));
  await page.getByRole('button', { name: '重试迁移', exact: true }).click();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect(writes).toHaveLength(1);
  const saved = (await (await request.get(writes[0])).json()).data;
  expect(saved).toMatchObject(snapshot);
  expect(saved.version).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('canvas-storage'))).toBe(raw);
});

for (const action of ['clear', 'new', 'import', 'return'] as const) {
  test(`${action} cannot hide an unsaved canvas when its local checkpoint fails`, async ({ page, request }) => {
    const id = crypto.randomUUID();
    await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot } });
    await page.goto(`/?project=${id}`);
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
        if (this.name === 'drafts' && !sessionStorage.getItem('storage-recovered')) throw new DOMException('full', 'QuotaExceededError');
        return put.apply(this, args);
      };
    });
    await rename(page, '切换前未保存的内容');
    if (action === 'clear') {
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: '清空', exact: true }).click();
    } else if (action === 'new') {
      await page.getByRole('button', { name: '项目', exact: true }).click();
      await page.getByRole('button', { name: /新建项目/ }).click();
    } else if (action === 'import') {
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '导入', exact: true }).click();
      await (await chooser).setFiles({ name: 'new.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...snapshot, projectName: '不应替换当前创作' })) });
    } else {
      await page.getByRole('button', { name: '返回工作空间', exact: true }).click();
    }
    await expect(page.getByTestId('canvas-save-status')).toHaveText('本地保存失败');
    await expect(page.getByRole('button', { name: '切换前未保存的内容', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('project')).toBe(id);
    expect(JSON.parse(await downloadText(page, '导出当前画布'))).toMatchObject({ id, name: '切换前未保存的内容', nodes: snapshot.nodes });
    expect((await (await request.get(`/api/workflow/${id}`)).json()).data.name).toBe(snapshot.name);
    await page.evaluate(() => sessionStorage.setItem('storage-recovered', 'true'));
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
    expect((await (await request.get(`/api/workflow/${id}`)).json()).data.name).toBe('切换前未保存的内容');
  });
}
