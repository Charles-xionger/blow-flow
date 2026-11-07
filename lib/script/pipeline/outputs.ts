import { serializeStoryboard, type StoryboardLimits, type StoryboardShot } from '../storyboard';
import type { PlannedShot, ShotDetail, ShotPlan, StoryboardWorkflow, WorkflowAsset } from './types';
export class WorkflowError extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowError('模型返回的结构无效，请重试当前步骤');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new WorkflowError('模型输出缺少有效内容或内容过长，请重试当前步骤');
  return value.trim();
}
function names(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30) throw new WorkflowError('镜头资产名称列表无效');
  return [...new Set(value.map(name => text(name, 100)))];
}
export function parseStepJSON(raw: string): unknown {
  try { return JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new WorkflowError('模型未返回完整 JSON，草稿已保留；可重试当前步骤'); }
}
export function validatePlan(value: unknown, limits: StoryboardLimits): ShotPlan {
  const result = object(value);
  if (!Array.isArray(result.shots) || !result.shots.length || result.shots.length > limits.maxShots) throw new WorkflowError(`规划必须包含 1–${limits.maxShots} 个镜头`);
  const shots: PlannedShot[] = result.shots.map((entry, index) => {
    const shot = object(entry);
    if (typeof shot.duration !== 'number' || !Number.isInteger(shot.duration) || shot.duration < 1 || shot.duration > 15) throw new WorkflowError('每个镜头须为 1–15 秒的整数');
    return { id: `shot-${String(index + 1).padStart(3, '0')}`, title: text(shot.title, 100), duration: shot.duration,
      action: text(shot.action, 1200), characters: names(shot.characters), scene: text(shot.scene, 100), props: names(shot.props) };
  });
  if (shots.reduce((sum, shot) => sum + shot.duration, 0) !== limits.duration) throw new WorkflowError(`规划的镜头总时长必须等于 ${limits.duration} 秒`);
  return { summary: text(result.summary), shots };
}
export function assetNames(plan: ShotPlan) {
  return { characters: [...new Set(plan.shots.flatMap(shot => shot.characters))], scene: [...new Set(plan.shots.map(shot => shot.scene))], props: [...new Set(plan.shots.flatMap(shot => shot.props))] };
}
export function validateAssets(value: unknown, plan: ShotPlan): WorkflowAsset[] {
  const result = object(value); const expected = assetNames(plan);
  return (['characters', 'scene', 'props'] as const).flatMap(kind => {
    const entries = result[kind];
    if (!Array.isArray(entries) || entries.length !== expected[kind].length) throw new WorkflowError('资产清单与镜头规划不一致，请重试资产整理');
    const mapped = entries.map(entry => { const asset = object(entry); return { name: text(asset.name, 100), description: text(asset.description) }; });
    if (new Set(mapped.map(asset => asset.name)).size !== entries.length) throw new WorkflowError('资产名称重复，请重试资产整理');
    return expected[kind].map((name, index) => {
      const asset = mapped.find(item => item.name === name); if (!asset) throw new WorkflowError(`缺少资产设定：${name}`);
      return { ...asset, kind, id: `${kind}-${index + 1}` };
    });
  });
}
export function validateDetails(value: unknown, shots: PlannedShot[]): ShotDetail[] {
  const result = object(value);
  if (!Array.isArray(result.shots) || result.shots.length !== shots.length) throw new WorkflowError('返回的镜头数量与当前批次不一致');
  const details = result.shots.map(entry => {
    const shot = object(entry); const id = text(shot.id, 100);
    if (!shots.some(item => item.id === id)) throw new WorkflowError('模型返回了当前批次之外的镜头');
    return { id, visual: text(shot.visual), size: text(shot.size, 500), lighting: text(shot.lighting), dialogue: text(shot.dialogue), sound: text(shot.sound), camera: text(shot.camera) };
  });
  if (new Set(details.map(shot => shot.id)).size !== shots.length) throw new WorkflowError('模型重复返回了同一个镜头');
  return details;
}
export function assemblePrompts(workflow: StoryboardWorkflow): Record<string, string> {
  return Object.fromEntries((workflow.plan?.shots ?? []).map(shot => {
    const detail = workflow.details[shot.id];
    if (!detail) throw new WorkflowError('镜头尚未全部完成，不能组装提示词');
    const assets = workflow.assets?.filter(asset => asset.kind === 'characters' ? shot.characters.includes(asset.name) : asset.kind === 'scene' ? shot.scene === asset.name : shot.props.includes(asset.name)) ?? [];
    return [shot.id, [`时长：${shot.duration} 秒。`, ...assets.map(asset => `${asset.name}：${asset.description}`),
      `画面：${detail.visual}`, `景别：${detail.size}`, `光影：${detail.lighting}`, `运镜：${detail.camera}`, `对白旁白：${detail.dialogue}`, `音效：${detail.sound}`].join('\n')];
  }));
}
export function workflowText(workflow: StoryboardWorkflow): string {
  if (!workflow.plan) return '';
  const shots: StoryboardShot[] = workflow.plan.shots.map(shot => {
    const detail = workflow.details[shot.id];
    return { title: shot.title, duration: `${shot.duration}秒`, visual: detail?.visual || shot.action,
      size: detail?.size || '', lighting: detail?.lighting || '', dialogue: detail?.dialogue || '', sound: detail?.sound || '', camera: detail?.camera || '',
      characters: shot.characters.join('、') || '无', scene: shot.scene, props: shot.props.join('、') || '无', prompt: workflow.prompts[shot.id] || '' };
  });
  return serializeStoryboard(shots);
}
