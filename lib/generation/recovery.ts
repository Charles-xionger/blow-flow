import type { NodeData } from '../../types';
import type { CreateGeneration, GenerationTask } from './types';
import { createGeneration, deleteGenerationNode, generationActive, generationLabel, GenerationRequestError, getGeneration, resumeGeneration, retryGenerationSave } from './client';

interface Association { request: CreateGeneration; taskId?: string; deleted?: boolean; detached?: boolean; restoredNodeId?: string; resultBlocked?: boolean; contentVersion?: number }
interface Storage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const key = (nodeId: string) => 'generation-node-v1:' + nodeId;
export function generationAssociation(nodeId: string, storage: Storage = localStorage): Association | undefined {
  const value = storage.getItem(key(nodeId));
  return value ? JSON.parse(value) : undefined;
}
function persist(value: Association, storage: Storage, nodeId = value.request.nodeId) {
  storage.setItem(key(nodeId), JSON.stringify(value));
}

export interface GenerationView {
  generationNodeId?: string;
  generationContentVersion?: number;
  generationBindingVersion?: number;
  generationRevision?: number;
  generationResultBlocked?: boolean;
  generationResultArtifacts?: string[];
  pendingGeneration?: CreateGeneration; generationTaskId?: string;
  generationStatus?: string; generationBlocked?: boolean; isLoading?: boolean;
  generationCanRetrySave?: boolean; generationSaving?: boolean;
  error?: string; imageSrc?: string; videoSrc?: string; outputArtifacts?: string[];
}
export const clearedGenerationAssociation = {
  pendingGeneration: undefined, generationTaskId: undefined, generationStatus: undefined,
  generationBlocked: false, generationCanRetrySave: false, generationSaving: false,
} satisfies GenerationView;
export const copiedGenerationData = {
  pendingScript: undefined, pendingScriptPublish: undefined, scriptTaskId: undefined, scriptSource: undefined,
  ...clearedGenerationAssociation, isLoading: false, error: undefined,
  generationNodeId: undefined, generationContentVersion: undefined, generationBindingVersion: undefined,
  generationRevision: undefined, generationResultBlocked: undefined, generationResultArtifacts: undefined,
} satisfies GenerationView & Partial<NodeData>;

interface ViewPort {
  // Returns undefined after deletion, navigation or unmount.
  read(): GenerationView | undefined;
  update(value: GenerationView): void;
}
const defaultIO = { create: createGeneration, get: getGeneration, resume: resumeGeneration, retrySave: retryGenerationSave };
export function generationRecovery(nodeId: string, view: ViewPort, storage: Storage, io = defaultIO) {
  const revisions = new Map<string, number>();
  function current(taskId: string) {
    const node = view.read();
    const association = generationAssociation(nodeId, storage);
    return !association?.deleted && !association?.detached && node && !node.pendingGeneration && node.generationTaskId === taskId;
  }
  function apply(task: GenerationTask) {
    if (!current(task.id)) return;
    const previous = Math.max(revisions.get(task.id) ?? -1, view.read()?.generationRevision ?? -1);
    if (previous !== undefined && task.revision !== undefined && previous > task.revision) return;
    if (task.revision !== undefined) revisions.set(task.id, task.revision);
    const saved = generationAssociation(nodeId, storage);
    const canApplyResult = !saved?.resultBlocked && !view.read()?.generationResultBlocked && (saved?.contentVersion ?? view.read()?.generationBindingVersion ?? 0) === (view.read()?.generationContentVersion ?? 0);
    view.update({ generationRevision: task.revision, generationResultArtifacts: task.artifacts, generationStatus: generationLabel(task), generationBlocked: ['uncertain', 'timed_out'].includes(task.status),
      isLoading: generationActive(task), error: task.error || undefined,
      generationCanRetrySave: task.status === 'succeeded' && task.saveStatus === 'failed',
      generationSaving: task.status === 'succeeded' && ['pending', 'saving'].includes(task.saveStatus),
      ...(task.artifacts.length && canApplyResult ? { [task.outputType === 'video' ? 'videoSrc' : 'imageSrc']: task.artifacts[0], outputArtifacts: task.artifacts } : {}) });
  }
  async function start(request: CreateGeneration) {
    if (!view.read()) return;
    const association = generationAssociation(nodeId, storage);
    if (association?.deleted) return;
    // Saving a draft assigns a workflow ID; retain the generation identity of this node.
    const persistedPending = view.read()?.pendingGeneration;
    const pending = persistedPending || { ...request, nodeId: view.read()?.generationNodeId || request.nodeId, canvasId: view.read()?.generationNodeId ? request.canvasId : association?.request.canvasId || request.canvasId };
    const sameRequest = association?.request.requestId === pending.requestId;
    const bindingVersion = sameRequest ? association.contentVersion ?? view.read()?.generationBindingVersion ?? 0
      : persistedPending ? view.read()?.generationBindingVersion ?? 0 : view.read()?.generationContentVersion ?? 0;
    try {
      // Synchronous durable write must succeed before the paid request can be sent.
      try { persist({ request: pending, contentVersion: bindingVersion }, storage, nodeId); }
      catch {
        view.update({ isLoading: false, error: '无法保存任务恢复记录，尚未提交生成' });
        return;
      }
      view.update({ generationRevision: undefined, generationBindingVersion: bindingVersion, generationResultBlocked: false, generationResultArtifacts: [], pendingGeneration: pending, generationTaskId: undefined, isLoading: true,
        generationBlocked: false, generationCanRetrySave: false, generationSaving: false, error: undefined, generationStatus: '提交中' });
      const task = await io.create(pending);
      const latest = generationAssociation(nodeId, storage);
      if (latest?.request.requestId !== pending.requestId) return;
      persist({ ...latest, request: pending, taskId: task.id }, storage, nodeId);
      if (latest.deleted) return;
      if (latest.resultBlocked) {
        if (view.read()?.generationNodeId === latest.restoredNodeId && !view.read()?.generationTaskId) {
          view.update({ pendingGeneration: undefined, generationTaskId: task.id });
          apply(task);
        }
        return;
      }
      if (view.read()?.pendingGeneration?.requestId !== pending.requestId) return;
      view.update({ pendingGeneration: undefined, generationTaskId: task.id });
      apply(task);
    } catch (error) {
      if (!view.read() || view.read()?.pendingGeneration?.requestId !== pending.requestId) return;
      if (error instanceof GenerationRequestError && error.rejected) {
        storage.removeItem(key(nodeId));
        view.update({ pendingGeneration: undefined, isLoading: false, error: error.message, generationStatus: '创建被拒绝' });
      } else view.update({ isLoading: false, error: '创建结果待确认，请恢复原请求', generationStatus: '创建待确认' });
    }
  }
  async function recover({ submitPending = true } = {}) {
    const saved = generationAssociation(nodeId, storage);
    if (!view.read()) return;
    if (saved?.detached) {
      view.update({ ...clearedGenerationAssociation });
      return;
    }
    if (saved?.deleted) {
      view.update({ ...clearedGenerationAssociation, isLoading: false,
        generationBlocked: true, generationStatus: '节点任务关联已删除' });
      return;
    }
    if (saved?.taskId) {
      view.update({ pendingGeneration: undefined, generationTaskId: saved.taskId,
        ...(view.read()?.generationTaskId !== saved.taskId ? { generationRevision: undefined,
          generationBindingVersion: saved.contentVersion ?? 0, generationResultBlocked: !!saved.resultBlocked } : {}) });
    } else if (saved?.resultBlocked) {
      view.update({ pendingGeneration: undefined, isLoading: false, generationStatus: '原请求已取消，重新生成需明确发起' });
    } else if (saved || view.read()?.pendingGeneration) {
      if (!submitPending) {
        view.update({ pendingGeneration: saved?.request || view.read()!.pendingGeneration, isLoading: false,
          generationStatus: '旧草稿请求待核实', error: '旧生成请求未自动提交，请确认后恢复原请求' });
        return;
      }
      // Override a stale saved canvas with the durable latest request.
      const request = saved?.request || view.read()!.pendingGeneration!;
      view.update({ pendingGeneration: request });
      await start(request);
    }
  }
  async function poll(taskId: string) {
    try {
      const task = await io.get(taskId);
      if (!current(taskId)) return false;
      apply(task);
      return generationActive(task);
    } catch {
      if (!current(taskId)) return false;
      view.update({ error: '连接暂时中断，后台任务继续执行' });
      return true;
    }
  }
  async function resume() {
    const taskId = view.read()?.generationTaskId;
    if (!taskId) return;
    try { apply(await io.resume(taskId)); }
    catch (error) { if (current(taskId)) view.update({ error: error instanceof Error ? error.message : '继续查询失败' }); }
  }
  async function retrySave() {
    const node = view.read();
    const taskId = node?.generationTaskId;
    if (!taskId || !node?.generationCanRetrySave || !current(taskId)) return;
    view.update({ generationCanRetrySave: false, generationSaving: true, isLoading: true, error: undefined,
      generationStatus: '正在请求重试保存' });
    try { apply(await io.retrySave(taskId)); }
    catch (error) {
      if (current(taskId)) view.update({ generationCanRetrySave: true, generationSaving: false, isLoading: false,
        generationStatus: '生成成功，保存状态待确认',
        error: error instanceof Error ? error.message : '重试保存请求失败' });
    }
  }
  async function detach() {
    const taskId = view.read()?.generationTaskId;
    let saved = generationAssociation(nodeId, storage);
    if (!saved && taskId) saved = { request: await io.get(taskId), taskId };
    if (saved) persist({ ...saved, detached: true }, storage, nodeId);
    if (view.read()) view.update({ ...clearedGenerationAssociation });
  }
  return { start, recover, poll, apply, resume, retrySave, detach };
}

// Keep a durable cancellation outbox when deletion races creation or the network is offline.
interface Deletion { id?: string; nodeId: string; canvasId: string; taskId?: string }
const deletionKey = 'generation-deletions-v1';
function deletions(storage: Storage): Deletion[] {
  return JSON.parse(storage.getItem(deletionKey) || '[]');
}
export async function retryGenerationDeletions(storage: Storage = localStorage) {
  for (const deletion of deletions(storage)) {
    try {
      const canvasId = deletion.taskId ? (await getGeneration(deletion.taskId)).canvasId : deletion.canvasId;
      await deleteGenerationNode(canvasId, deletion.nodeId);
      storage.setItem(deletionKey, JSON.stringify(deletions(storage).filter(d => deletion.id ? d.id !== deletion.id : d.nodeId !== deletion.nodeId)));
    } catch { /* Retain for the next online event or canvas mount. */ }
  }
}
export function deleteNodeGeneration(nodeId: string, canvasId: string, data: GenerationView, storage: Storage = localStorage) {
  const saved = generationAssociation(nodeId, storage);
  const request = saved?.request || data.pendingGeneration;
  const executionId = request?.nodeId || data.generationNodeId || nodeId;
  const queue = deletions(storage).filter(d => d.nodeId !== executionId);
  queue.push({ id: crypto.randomUUID(), nodeId: executionId, canvasId: request?.canvasId || canvasId,
    taskId: request ? undefined : data.generationTaskId });
  storage.setItem(deletionKey, JSON.stringify(queue));
  // Retain a task identity even when the canvas predates local recovery records.
  const identity = request || { requestId: 'deleted-' + crypto.randomUUID(), nodeId: executionId, canvasId,
    modelId: '', input: { prompt: '', width: 0, height: 0 } };
  persist({ ...saved, request: identity, taskId: saved?.taskId || data.generationTaskId, deleted: true }, storage, nodeId);
  void retryGenerationDeletions(storage);
}

/** Restore content under a fresh execution identity; old cancellation remains durable and cannot target a new run. */
export function restoreDeletedGeneration(nodeId: string, data: GenerationView, storage: Storage = localStorage): GenerationView {
  let saved = generationAssociation(nodeId, storage);
  if (!saved && (data.generationTaskId || data.pendingGeneration)) {
    // Persisted history can be reopened without this browser's cancellation outbox.
    deleteNodeGeneration(nodeId, data.pendingGeneration?.canvasId || 'draft', data, storage);
    saved = generationAssociation(nodeId, storage);
  }
  if (!saved?.deleted) return data;
  const restoredNodeId = saved.restoredNodeId || crypto.randomUUID();
  persist({ ...saved, restoredNodeId, deleted: false, resultBlocked: true }, storage, nodeId);
  return { ...data, ...clearedGenerationAssociation, pendingGeneration: undefined,
    generationNodeId: restoredNodeId, generationTaskId: saved.taskId, generationResultBlocked: true,
    isLoading: false, error: undefined, generationStatus: saved.taskId ? '正在核实原任务状态' : '原请求已取消，重新生成需明确发起' };
}
