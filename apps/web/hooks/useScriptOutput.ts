'use client';
import { useEffect, useState } from 'react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { subscribeScriptTasks } from '@/lib/script/client';
import { scriptOutputIds } from '@/lib/script/shots';
import type { ScriptTask } from '@/lib/script/types';

/** Live text is read from the durable task, independently of selection and the script console. */
export function useScriptOutput(nodeId: string, taskId?: string) {
  const canvasId = useCanvasStore(state => state.currentWorkflowId);
  const session = useCanvasStore(state => state.canvasSession);
  const [task,setTask] = useState<ScriptTask>();
  useEffect(() => {
    if (!canvasId || !taskId) return;
    return subscribeScriptTasks(canvasId, tasks => {
      if (useCanvasStore.getState().canvasSession !== session) return;
      const next = tasks.find(value => value.id === taskId && scriptOutputIds(value).includes(nodeId));
      if (!next) return;
      setTask(previous => previous?.id === next.id && previous.revision >= next.revision ? previous : next);
    });
  },[canvasId,session,nodeId,taskId]);
  return task?.canvasId === canvasId && task.id === taskId && scriptOutputIds(task).includes(nodeId) ? task : undefined;
}
