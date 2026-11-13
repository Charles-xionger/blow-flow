import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const item = (page: Page, name: string) => page.getByTestId('workspace-item').filter({ hasText: name });
async function menu(page: Page, name: string, action: string) {
  await item(page, name).getByRole('button', { name: `${name}的更多操作` }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
async function confirm(page: Page) { await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click(); await expect(page.getByRole('dialog')).toBeHidden(); }
async function seed(request: APIRequestContext, name: string) {
  const id = crypto.randomUUID();
  const response = await request.post('/api/workflow', { data: { id, requestId: crypto.randomUUID(), baseVersion: 0,
    snapshot: { name, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } });
  expect(response.ok()).toBeTruthy();
  return id;
}

test('workspace creates an empty project, opens the canvas, saves a rename and reopens fresh server content', async ({ page, request }) => {
  // Keep another grid row beneath the menu: the menu must stay above neighboring cards.
  await Promise.all(Array.from({ length: 8 }, (_, index) => seed(request, `菜单层级-${index}`)));
  await page.goto('/');
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole('button', { name: '卡片视图' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await expect(page).toHaveURL(/\/canvas\?project=/);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const id = new URL(page.url()).searchParams.get('project')!;
  expect((await (await request.get(`/api/workflow/${id}`)).json()).data.nodes).toEqual([]);
  const name = `创作-${id.slice(0, 6)}`;
  await page.getByRole('button', { name: '未命名项目', exact: true }).click();
  await page.getByPlaceholder('项目名称...').fill(name);
  await page.getByRole('button', { name: '返回工作空间' }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(item(page, name)).toBeVisible();
  await menu(page, name, '重命名');
  await page.getByRole('textbox', { name: '名称', exact: true }).fill(`${name}-新`);
  await confirm(page);
  await item(page, `${name}-新`).getByRole('button', { name: `打开 ${name}-新`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${name}-新`, exact: true })).toBeVisible();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.goto(`/?project=${id}`);
  await expect(page).toHaveURL(new RegExp(`/canvas\\?project=${id}`));
  await expect(page.getByRole('button', { name: `${name}-新`, exact: true })).toBeVisible();
});

test('folders, global search, batch trash and recovery work across list and card views', async ({ page, request }) => {
  const suffix = crypto.randomUUID().slice(0, 6);
  const nameA = `测试-${suffix}-A`, nameB = `测试-${suffix}-B`, folder = `灵感-${suffix}`;
  const idA = await seed(request, nameA);
  await seed(request, nameB);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill(folder);
  await confirm(page);
  await page.getByRole('button', { name: '列表视图' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '列表视图' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: '搜索项目和文件夹' }).fill(`测试-${suffix}`);
  await item(page, nameA).getByRole('checkbox', { name: `选择 ${nameA}` }).check();
  await item(page, nameB).getByRole('checkbox', { name: `选择 ${nameB}` }).check();
  await page.getByRole('button', { name: '移动至', exact: true }).click();
  await page.getByRole('combobox', { name: '目标文件夹' }).selectOption({ label: folder });
  await confirm(page);
  await page.getByRole('button', { name: '清除搜索' }).click();
  await item(page, folder).getByRole('button', { name: folder, exact: true }).click();
  await expect(item(page, nameA)).toBeVisible();
  await expect(item(page, nameB)).toBeVisible();
  await page.getByRole('checkbox', { name: '选择全部项目' }).check();
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await confirm(page);
  await expect(item(page, nameA)).toHaveCount(0);
  await page.getByRole('tab', { name: '回收站' }).click();
  await expect(item(page, nameA)).toBeVisible();
  await menu(page, nameA, '恢复项目');
  await confirm(page);
  expect((await (await request.get(`/api/workflow/${idA}`)).json()).success).toBeTruthy();
  await menu(page, nameB, '永久删除');
  await page.getByRole('dialog').getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(item(page, nameB)).toHaveCount(0);
  await page.getByRole('tab', { name: '个人项目' }).click();
  await menu(page, folder, '删除文件夹');
  await confirm(page);
  await expect(item(page, nameA)).toBeVisible();
  await expect(item(page, folder)).toHaveCount(0);
  await page.getByRole('button', { name: '卡片视图' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '新建项目', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('loading failure has a retry and a broken cover falls back without hiding the project', async ({ page, request }) => {
  const name = `坏封面-${crypto.randomUUID().slice(0, 6)}`;
  const id = await seed(request, name);
  const original = (await (await request.get(`/api/workflow/${id}`)).json()).data;
  await request.put(`/api/workflow/${id}`, { data: { id, baseVersion: original.version, requestId: crypto.randomUUID(), snapshot: { ...original, nodes: [{ id: 'image', type: 'originalImage', position: { x: 0, y: 0 }, data: { imageSrc: '/missing-workspace-cover.png' } }] } } });
  await page.route('**/api/workspace', route => route.fulfill({ status: 500, json: { success: false, error: '测试加载失败' } }));
  await page.goto('/workspace');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('测试加载失败');
  await page.unroute('**/api/workspace');
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(item(page, name).getByText('创作从这里开始')).toBeVisible();
  await page.getByRole('textbox', { name: '搜索项目和文件夹' }).fill('不存在的项目名称');
  await expect(page.getByText('没有找到匹配的内容')).toBeVisible();
});

test('a project restored from trash can be edited again in the browser that observed its deletion', async ({ page, request }) => {
  const name = `恢复原项目-${crypto.randomUUID().slice(0, 6)}`;
  const id = await seed(request, name);
  await page.goto(`/canvas?project=${id}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await request.delete(`/api/workflow/${id}`);
  await page.reload();
  await expect(page.getByLabel('草稿恢复')).toContainText('服务端项目已删除');
  await page.goto('/workspace?trash=true');
  await menu(page, name, '恢复项目');
  await confirm(page);
  await page.getByRole('tab', { name: '个人项目' }).click();
  await item(page, name).getByRole('button', { name: `打开 ${name}`, exact: true }).click();
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await expect(page.getByLabel('草稿恢复')).toBeHidden();
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByPlaceholder('项目名称...').fill(`${name}-继续编辑`);
  await page.getByPlaceholder('项目名称...').press('Enter');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  expect((await (await request.get(`/api/workflow/${id}`)).json()).data.name).toBe(`${name}-继续编辑`);
});

test('returning to the workspace preserves current edits despite an unrelated deleted draft', async ({ page, request }) => {
  const suffix = crypto.randomUUID().slice(0, 6);
  const deletedId = await seed(request, `已删除-${suffix}`);
  const name = `正常项目-${suffix}`;
  const healthyId = await seed(request, name);
  await page.goto(`/canvas?project=${deletedId}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await request.delete(`/api/workflow/${deletedId}`);
  await page.reload();
  await expect(page.getByLabel('草稿恢复')).toContainText('服务端项目已删除');
  await page.goto(`/canvas?project=${healthyId}`);
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByPlaceholder('项目名称...').fill(`${name}-离开前修改`);
  await page.getByRole('button', { name: '返回工作空间' }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await page.goto(`/canvas?project=${healthyId}`);
  await expect(page.getByRole('button', { name: `${name}-离开前修改`, exact: true })).toBeVisible();
});

test('folder dialogs validate names and cancelling a rename preserves the original folder', async ({ page }) => {
  const name = `弹窗验收-${crypto.randomUUID().slice(0, 6)}`;
  await page.goto('/workspace');
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill(name);
  await confirm(page);
  await menu(page, name, '重命名');
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('   ');
  await expect(dialog.getByRole('button', { name: '确认', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('不应保存的名字');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(item(page, name)).toBeVisible();
  await menu(page, name, '重命名');
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(name);
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill(`${name}-新`);
  await confirm(page);
  await expect(item(page, `${name}-新`)).toBeVisible();
});

test('retrying project creation after a lost response and reload opens the original empty project', async ({ page, request }) => {
  await page.goto('/workspace');
  const createdIds: string[] = [];
  let loseResponse = true;
  await page.route('**/api/workspace', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const command = route.request().postDataJSON();
    if (command.action !== 'create-project') return route.continue();
    createdIds.push(command.id);
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    if (loseResponse) { loseResponse = false; return route.abort('failed'); }
    return route.fulfill({ response });
  });
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await expect.poll(() => createdIds.length).toBe(1);
  await expect(page.getByRole('button', { name: '新建项目', exact: true })).toBeEnabled();
  const firstId = createdIds[0];
  expect((await (await request.get(`/api/workflow/${firstId}`)).json()).success).toBeTruthy();
  await page.reload();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/canvas\\?project=${firstId}`));
  expect(createdIds.every(id => id === firstId)).toBeTruthy();
});
