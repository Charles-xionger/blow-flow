import { test, expect } from '@playwright/test';

test('personal space opens the read-only built-in creative skill library', async ({ page }) => {
  await page.goto('/workspace');
  await page.getByRole('button', { name: '个人空间' }).click();
  await page.getByRole('menuitem', { name: '创作技能' }).click();

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
  await expect(page.getByText(/场景标题：地点 \/ 时间/)).toBeVisible();
  await expect(page.getByRole('button', { name: /删除|编辑|覆盖/ })).toHaveCount(0);
});
