'use client';
import { useEffect, useRef, useState } from 'react';
import { canvasAutosave, useCanvasStore } from '@/store/useCanvasStore';
import { createScriptTask, stopScriptTask, subscribeScriptTasks, ScriptSubmissionError } from '@/lib/script/client';
import { scriptOutputIds } from '@/lib/script/shots';
import { scriptActive, type CreateScriptTask, type ScriptInput, type ScriptTask } from '@/lib/script/types';

function mergeTasks(previous: ScriptTask[], incoming: ScriptTask[]) {
  const merged = new Map(previous.map(task => [task.id, task]));
  for (const task of incoming) if (!merged.has(task.id) || merged.get(task.id)!.revision < task.revision) merged.set(task.id, task);
  return [...merged.values()].sort((a,b) => b.createdAt-a.createdAt);
}
export function useScriptTask(nodeId: string) {
  const canvasId = useCanvasStore(s => s.currentWorkflowId);
  const canvasSession = useCanvasStore(s => s.canvasSession);
  const [snapshot,setSnapshot] = useState<{ session: number; tasks: ScriptTask[]; polling: boolean }>({ session: -1,tasks:[],polling:false });
  const [operation,setOperation] = useState<{ session: number; submitting?: boolean; stopping?: boolean; error?: string }>({ session:-1 });
  const busy = useRef<number | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; },[]);
  const isCurrent = (session: number) => mounted.current && useCanvasStore.getState().canvasSession === session && useCanvasStore.getState().nodes.some(node => node.id === nodeId && node.type === 'script');
  const accept = (task: ScriptTask, session: number) => setSnapshot(previous => ({ session,polling:previous.session === session && previous.polling,tasks:mergeTasks(previous.session === session ? previous.tasks : [],[task]) }));
  useEffect(() => {
    if (!canvasId) return;
    let closed = false;
    let outputSnapshot = '';
    let synchronizing = false;
    return subscribeWithCleanup();
    function subscribeWithCleanup() {
      const unsubscribe = subscribeScriptTasks(canvasId!, (all,polling) => {
        const state = useCanvasStore.getState();
        if (closed || state.canvasSession !== canvasSession) return;
        const tasks = all.filter(task => task.canvasId === canvasId && task.nodeId === nodeId);
        setSnapshot(previous => ({ session:canvasSession,tasks:mergeTasks(previous.session === canvasSession ? previous.tasks : [], tasks),polling }));
        const nextOutputSnapshot = JSON.stringify(tasks.map(task => [task.id, scriptOutputIds(task).length, task.outputSaved]));
        if (!synchronizing && nextOutputSnapshot !== outputSnapshot) {
          synchronizing = true;
          void canvasAutosave.flush().then(() => { outputSnapshot = nextOutputSnapshot; }).catch(() => {}).finally(() => { synchronizing = false; });
        }
        const pending = state.nodes.find(node => node.id === nodeId)?.data.pendingScript;
        const recovered = pending && tasks.find(task => task.requestId === pending.requestId && pending.canvasId === canvasId && pending.nodeId === nodeId);
        if (recovered) state.updateNodeData(nodeId,{ pendingScript:undefined,scriptTaskId:recovered.id });
      });
      return () => { closed = true; unsubscribe(); };
    }
  },[canvasId,canvasSession,nodeId]);
  const start = async (input: ScriptInput | (() => ScriptInput)) => {
    const originalSession = useCanvasStore.getState().canvasSession;
    if (busy.current === originalSession) return;
    busy.current = originalSession; setOperation({ session:originalSession,submitting:true });
    try {
      await canvasAutosave.flush();
      if (!isCurrent(originalSession)) return;
      const state = useCanvasStore.getState();
      const submittedCanvas = state.currentWorkflowId;
      if (!submittedCanvas || state.saveStatus !== 'synced') throw new Error('请先完成画布保存，再生成脚本');
      const node = state.nodes.find(n => n.id === nodeId)!;
      const pending = node.data.pendingScript;
      // Copied/imported nodes must never replay another canvas/node's request identity.
      const request: CreateScriptTask = pending?.canvasId === submittedCanvas && pending.nodeId === nodeId ? pending : { requestId:crypto.randomUUID(),canvasId:submittedCanvas,nodeId,input: typeof input === 'function' ? input() : input };
      state.updateNodeData(nodeId,{ pendingScript:request });
      await canvasAutosave.flush();
      if (!isCurrent(originalSession)) return;
      if (useCanvasStore.getState().saveStatus !== 'synced') throw new Error('请求身份保存失败，请恢复保存后重试');
      const task = await createScriptTask(request);
      if (!isCurrent(originalSession)) return;
      useCanvasStore.getState().updateNodeData(nodeId,{ pendingScript:undefined,scriptTaskId:task.id });
      accept(task,originalSession);
      await canvasAutosave.flush();
    } catch (failure) {
      if (isCurrent(originalSession)) {
        if (failure instanceof ScriptSubmissionError && failure.definitive) useCanvasStore.getState().updateNodeData(nodeId,{ pendingScript:undefined });
        setOperation({ session:originalSession,error:failure instanceof Error ? failure.message : '提交失败；可恢复原请求' });
      }
    } finally {
      if (busy.current === originalSession) busy.current = null;
      if (isCurrent(originalSession)) setOperation(previous => previous.session === originalSession ? { ...previous,submitting:false } : previous);
    }
  };
  const tasks = snapshot.session === canvasSession ? snapshot.tasks.filter(task => task.canvasId === canvasId && task.nodeId === nodeId) : [];
  const activeTask = tasks.find(task => scriptActive(task.status));
  const stop = async () => {
    if (!activeTask || (operation.session === canvasSession && operation.stopping)) return;
    const originalSession = canvasSession;
    setOperation({ session:originalSession,stopping:true });
    try {
      const task = await stopScriptTask(activeTask.id);
      if (isCurrent(originalSession)) { accept(task,originalSession); setOperation({ session:originalSession }); }
    } catch (failure) {
      if (isCurrent(originalSession)) setOperation({ session:originalSession,error:failure instanceof Error ? failure.message : '停止失败，请重试' });
    }
  };
  return { tasks,task:tasks[0],activeTask,polling:snapshot.session === canvasSession && snapshot.polling,
    submitting:operation.session === canvasSession && !!operation.submitting,stopping:operation.session === canvasSession && !!operation.stopping,
    error:operation.session === canvasSession ? operation.error || '' : '',start,stop };
}
