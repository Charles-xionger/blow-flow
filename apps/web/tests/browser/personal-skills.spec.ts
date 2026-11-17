import { test, expect } from '@playwright/test';

test('personal space opens the read-only built-in creative skill library', async ({ page }) => {
  await page.goto('/workspace');
  const personalSpace = page.getByRole('button', { name: '个人空间' });
  await personalSpace.focus();
  await expect(personalSpace).toBeFocused();
  await personalSpace.press('Enter');
  const creativeSkills = page.getByRole('menuitem', { name: '创作技能' });
  await expect(creativeSkills).toBeVisible();
  await personalSpace.press('Tab');
  await expect(creativeSkills).toBeFocused();
  await creativeSkills.press('Enter');

  await expect(page).toHaveURL(/\/personal\/skills$/);
  await expect(page.getByRole('heading', { name: '个人技能库' })).toBeVisible();
  await expect(page.getByText('跨所有项目使用和管理你的创作技能。')).toBeVisible();

  const screenplay = page.getByRole('link', { name: /剧本创作/ });
  const storyboard = page.getByRole('link', { name: /分镜创作/ });
  await expect(screenplay).toContainText('screenplay');
  await expect(screenplay).toContainText('内置');
  await expect(screenplay).toContainText('只读');
  await expect(storyboard).toContainText('storyboard');

  await screenplay.click();
  await expect(page.getByRole('heading', { name: '完整指令' })).toBeVisible();
  await expect(page.getByText(/人物、场景、动作与对白/)).toBeVisible();
  await expect(page.getByRole('heading', { name: '资源清单' })).toBeVisible();
  await expect(page.getByText('format', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /删除|编辑|覆盖/ })).toHaveCount(0);
});

test('uploading SKILL.md gives progress feedback and adds a reusable personal skill', async ({ page }) => {
  await page.goto('/personal/skills');
  const dropzone = page.getByRole('button', { name: '选择或拖放技能包' });
  await expect(dropzone).toContainText('拖放 SKILL.md 或 ZIP');
  let releaseUpload!: () => void;
  const uploadMayFinish = new Promise<void>(resolve => { releaseUpload = resolve; });
  await page.route('**/api/personal/skills', async route => {
    await uploadMayFinish;
    await route.continue();
  });
  await dropzone.evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'SKILL.md', { type: 'text/markdown' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.getByRole('status')).toContainText('单个文件不能超过 20 MB');
  await expect(page.getByLabel('已选择文件')).toHaveCount(0);

  await dropzone.evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([
      '---\nname: sound-designer\ndescription: Build a purposeful soundscape.\n---\n\nUse layered ambience and motivated effects.',
    ], 'SKILL.md', { type: 'text/markdown' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.getByLabel('已选择文件')).toContainText('SKILL.md');
  await expect(page.getByRole('button', { name: '移除 SKILL.md' })).toBeVisible();
  await page.getByRole('button', { name: '移除 SKILL.md' }).click();
  await expect(page.getByLabel('已选择文件')).toHaveCount(0);
  await page.getByLabel('选择 SKILL.md 或 ZIP').setInputFiles({
    name: 'SKILL.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('---\nname: sound-designer\ndescription: Build a purposeful soundscape.\n---\n\nUse layered ambience and motivated effects.'),
  });
  await page.getByRole('button', { name: '上传技能' }).click();
  await expect(page.getByRole('button', { name: '上传中…' })).toBeDisabled();
  await expect(page.getByRole('progressbar', { name: '技能上传进度' })).toBeVisible();
  releaseUpload();

  await expect(page.getByRole('status')).toContainText('sound-designer 上传成功');
  const uploaded = page.getByRole('link', { name: /sound-designer/ });
  await expect(uploaded).toContainText('用户上传');
  await expect(uploaded).not.toContainText('只读');
  await expect(page.getByText('Use layered ambience and motivated effects.')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('link', { name: /sound-designer/ })).toBeVisible();

  await page.getByLabel('选择 SKILL.md 或 ZIP').setInputFiles({
    name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from('missing frontmatter'),
  });
  await page.getByRole('button', { name: '上传技能' }).click();
  await expect(page.getByRole('status')).toContainText('YAML frontmatter');

  await page.getByRole('button', { name: '删除 sound-designer' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('sound-designer');
  await expect(dialog).toContainText('新的技能发现与读取');
  await expect(dialog).toContainText('已记录在助手任务中的历史内容会保留');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('link', { name: /sound-designer/ })).toBeVisible();

  await page.getByRole('button', { name: '删除 sound-designer' }).click();
  await dialog.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('link', { name: /sound-designer/ })).toHaveCount(0);
  await expect(page).toHaveURL(/\/personal\/skills(?:\?skill=(?:screenplay|storyboard))?$/);
});
