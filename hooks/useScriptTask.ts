'use client';
import { useEffect, useRef, useState } from 'react';
import { canvasAutosave, useCanvasStore } from '@/store/useCanvasStore';
import { createScriptTask, subscribeScriptTasks, ScriptSubmissionError } from '@/lib/script/client';
import type { CreateScriptTask, ScriptInput, ScriptTask } from '@/lib/script/types';

export function useScriptTask(nodeId: string) {
  const canvasId = useCanvasStore(s => s.currentWorkflowId);
  const [tasks,setTasks] = useState<ScriptTask[]>([]);
  const [polling,setPolling] = useState(false);
  const [submitting,setSubmitting] = useState(false);
  const [error,setError] = useState('');
  const busy = useRef(false);
  const session = useRef(canvasId);
  session.current = canvasId;
  useEffect(() => {
    if (!canvasId) return;
    return subscribeScriptTasks(canvasId,(all,fallback) => {
      setTasks(previous => {
        const merged = new Map(previous.filter(t => t.canvasId === canvasId && t.nodeId === nodeId).map(t => [t.id,t]));
        for (const task of all.filter(t => t.nodeId === nodeId)) {
          if (!merged.has(task.id) || merged.get(task.id)!.revision < task.revision) merged.set(task.id,task);
        }
        return [...merged.values()].sort((a,b) => b.createdAt-a.createdAt);
      });
      setPolling(fallback);
    });
  },[canvasId,nodeId]);
  const start = async (input: ScriptInput | (() => ScriptInput)) => {
    if (busy.current) return;
    busy.current = true; setSubmitting(true); setError('');
    const originalSession = useCanvasStore.getState().canvasSession;
    let submittedCanvas: string | null = null;
    try {
      await canvasAutosave.flush();
      const state = useCanvasStore.getState();
      if (state.canvasSession !== originalSession) return;
      submittedCanvas = state.currentWorkflowId;
      if (!submittedCanvas || state.saveStatus !== 'synced') throw new Error('请先完成画布保存，再生成脚本');
      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return;
      const pending = node.data.pendingScript;
      const request: CreateScriptTask = pending || { requestId: crypto.randomUUID(), canvasId: submittedCanvas, nodeId, input: typeof input === 'function' ? input() : input };
      state.updateNodeData(nodeId,{ pendingScript:request });
      await canvasAutosave.flush();
      if (useCanvasStore.getState().saveStatus !== 'synced') throw new Error('请求身份保存失败，请恢复保存后重试');
      const task = await createScriptTask(request);
      if (session.current !== submittedCanvas || !useCanvasStore.getState().nodes.some(n => n.id === nodeId)) return;
      useCanvasStore.getState().updateNodeData(nodeId,{ pendingScript:undefined, scriptTaskId:task.id });
      setTasks(previous => {
        const newer = previous.find(t => t.id === task.id && t.revision > task.revision);
        return [newer || task,...previous.filter(t => t.id !== task.id)].sort((a,b) => b.createdAt-a.createdAt);
      });
    } catch (failure) {
      if (useCanvasStore.getState().canvasSession === originalSession) {
        if (failure instanceof ScriptSubmissionError && failure.definitive) useCanvasStore.getState().updateNodeData(nodeId,{ pendingScript:undefined });
        setError(failure instanceof Error ? failure.message : '提交失败；可恢复原请求');
      }
    }
    finally { busy.current = false; setSubmitting(false); }
  };
  return { tasks:tasks.filter(t => t.canvasId === canvasId), task:tasks.find(t => t.canvasId === canvasId), polling, submitting, error, start };
}
