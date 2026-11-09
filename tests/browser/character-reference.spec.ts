import { test, expect } from '@playwright/test';

for (const view of ['headshot', 'turnaround']) test(`creating a character image with ${view} preserves its description`, async ({ page, request }) => {
  const id = crypto.randomUUID();
  const text = '## 镜头 001｜放学\n时长：15秒\n画面描述：徐雨言穿浅灰校服，黑发低马尾，捏着便签。\n角色：徐雨言\n场景：无\n道具：无';
  const saved = await request.put(`/api/workflow/${id}`, { data: { id, requestId: crypto.randomUUID(), baseVersion: 0, snapshot: {
    name: '角色参考图', nodes: [{ id: 'board', type: 'text', position: { x: 200, y: 150 }, data: { type: 'text', label: '分镜', prompt: [{ text }], storyboard: { duration: 15, maxShots: 1 } } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  } } });
  expect(saved.ok()).toBeTruthy();
  await page.goto(`/canvas?project=${id}`);
  await page.getByRole('button', { name: '查看分镜内容 →', exact: true }).click();
  await page.getByRole('tab', { name: /资产设定/ }).click();
  await page.getByLabel('徐雨言人像模板').selectOption(view);
  await page.getByRole('button', { name: '创建图片节点', exact: true }).click();
  await page.getByRole('img', { name: '尚无生成图片', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: '提示词', exact: true });
  await expect(prompt).toContainText(view === 'headshot' ? 'photographic headshot' : 'three full-body views');
  await expect(prompt).toContainText('visible pores');
  await expect(prompt).toContainText('徐雨言穿浅灰校服');
  await expect(prompt).toContainText('plastic skin');
  await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
  const graph = (await (await request.get(`/api/workflow/${id}`)).json()).data;
  const character = graph.nodes.find((node: { data: { storyboardAsset?: { key: string } } }) => node.data.storyboardAsset?.key === 'characters:徐雨言');
  expect(character.data.prompt[0].text).toContain(view === 'headshot' ? 'photographic headshot' : 'three full-body views');
  expect(character.data.aspectRatio).toBe(view === 'headshot' ? '3:4' : '16:9');
  expect(character.data.resolution).toBe('2k');
  expect(character.data.imageSrc).toBeFalsy();
});
