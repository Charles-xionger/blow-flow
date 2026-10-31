'use client';
import { useCallback, useEffect, useRef } from 'react';
import { useCanvasStore } from '@/store/useCanvasStore';
import type { NodeData } from '@/types';
import type { CreateGeneration, GenerationTask } from '@/lib/generation/types';
import { createGeneration, GenerationRequestError, generationActive, generationLabel, getGeneration } from '@/lib/generation/client';

export function useGenerationTask(id: string, data: NodeData) {
  const update = useCanvasStore(s => s.updateNodeData);
  const initialPending = useRef(data.pendingGeneration);
  useEffect(() => {
    if (initialPending.current) update(id, { isLoading: false, generationStatus: '创建待确认', error: '请重试创建以找回原请求' });
  }, [id, update]);
  const canvasId = useCanvasStore(s => s.currentWorkflowId);
  const apply = useCallback((task: GenerationTask) => {
    const state = useCanvasStore.getState();
    const node = state.nodes.find(n => n.id === id);
    if (state.currentWorkflowId !== canvasId || !node || node.data.generationTaskId !== task.id) return;
    update(id, { generationStatus: generationLabel(task), generationBlocked: ['uncertain', 'timed_out'].includes(task.status),
      isLoading: generationActive(task), error: task.error || undefined,
      ...(task.artifacts.length ? { imageSrc: task.artifacts[0], outputArtifacts: task.artifacts } : {}) });
  }, [canvasId, id, update]);

  useEffect(() => {
    if (!data.generationTaskId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const task = await getGeneration(data.generationTaskId!);
        if (stopped) return;
        apply(task);
        if (!generationActive(task)) return;
      } catch {
        if (stopped) return;
        update(id, { error: '连接暂时中断，后台任务继续执行' });
      }
      timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [data.generationTaskId, apply, id, update]);

  return useCallback(async (request: CreateGeneration) => {
    // Persist before POST; retries reuse the exact request even after edits.
    const pending = data.pendingGeneration || request;
    update(id, { pendingGeneration: pending, isLoading: true, error: undefined, generationStatus: '提交中' });
    try {
      const task = await createGeneration(pending);
      const state = useCanvasStore.getState();
      const node = state.nodes.find(n => n.id === id);
      if (state.currentWorkflowId !== canvasId || node?.data.pendingGeneration?.requestId !== pending.requestId) return;
      update(id, { pendingGeneration: undefined, generationTaskId: task.id });
      apply(task);
    } catch (error) {
      const state = useCanvasStore.getState();
      if (state.currentWorkflowId !== canvasId || state.nodes.find(n => n.id === id)?.data.pendingGeneration?.requestId !== pending.requestId) return;
      if (error instanceof GenerationRequestError && error.rejected) {
        update(id, { pendingGeneration: undefined, isLoading: false, error: error.message, generationStatus: '创建被拒绝' });
        return;
      }
      update(id, { isLoading: false, error: `${error instanceof Error ? error.message : '创建结果未确认'}；重试将使用相同请求标识`, generationStatus: '创建待确认' });
    }
  }, [data.pendingGeneration, canvasId, id, update, apply]);
}
