import type { CreateGeneration, GenerationTask, PublicModel } from './types';

let catalogRequest: Promise<PublicModel[]> | undefined;
export function generationModels(): Promise<PublicModel[]> {
  if (!catalogRequest) {
    catalogRequest = fetch('/api/generation/models').then(async r => {
      if (!r.ok) throw new Error('模型目录暂时不可用');
      return r.json();
    }).catch(error => { catalogRequest = undefined; throw error; });
  }
  return catalogRequest;
}
export class GenerationRequestError extends Error {
  constructor(message: string, public rejected: boolean) { super(message); }
}
export async function createGeneration(request: CreateGeneration): Promise<GenerationTask> {
  const response = await fetch('/api/generation/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  const result = await response.json();
  if (!response.ok) throw new GenerationRequestError(result.error || '创建任务失败', response.status >= 400 && response.status < 500);
  return result;
}
export async function getGeneration(id: string, signal?: AbortSignal): Promise<GenerationTask> {
  const response = await fetch(`/api/generation/tasks/${encodeURIComponent(id)}`, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('任务查询暂时不可用');
  return response.json();
}
export const generationLabels: Record<GenerationTask['status'], string> = {
  cancelled: '已取消', queued: '本地排队', submitting: '提交中', running: '平台处理中', uncertain: '待核实',
  timed_out: '等待超时', succeeded: '生成成功', failed: '生成失败',
};
export function generationLabel(task: Pick<GenerationTask, 'status' | 'saveStatus'>): string {
  if (task.status === 'succeeded') return { pending: '生成成功，等待保存', saving: '生成成功，保存中', saved: '已保存', failed: '生成成功，保存失败' }[task.saveStatus];
  return generationLabels[task.status];
}
export function generationActive(task: GenerationTask): boolean {
  return ['queued', 'submitting', 'running'].includes(task.status) || (task.status === 'succeeded' && ['pending', 'saving'].includes(task.saveStatus));
}

export async function resumeGeneration(id: string): Promise<GenerationTask> {
  const response = await fetch(`/api/generation/tasks/${encodeURIComponent(id)}`, { method: 'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '继续查询失败');
  return result;
}
export async function deleteGenerationNode(canvasId: string, nodeId: string): Promise<void> {
  const response = await fetch('/api/generation/tasks', { method: 'DELETE',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canvasId, nodeId }) });
  if (!response.ok) throw new Error('取消排队任务失败');
}

export async function retryGenerationSave(id: string): Promise<GenerationTask> {
  const response = await fetch(`/api/generation/tasks/${encodeURIComponent(id)}/save`, { method: 'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '重试保存失败');
  return result;
}
