'use client';
import { useEffect, useMemo, useState, useRef } from 'react';
import { useCanvasStore, canvasDraftStorage } from '@/store/useCanvasStore';
import type { NodeData } from '@/types';
import { generationRecovery } from '@/lib/generation/recovery';

export function useGenerationTask(id: string, data: NodeData) {
  const canvasId = useCanvasStore(s => s.currentWorkflowId);
  const [pollVersion, setPollVersion] = useState(0);
  const activeSession = useRef<symbol | undefined>(undefined);
  const session = useMemo(() => {
    const token = Symbol();
    const read = () => {
      const state = useCanvasStore.getState();
      return activeSession.current === token && state.currentWorkflowId === canvasId ? state.nodes.find(n => n.id === id)?.data : undefined;
    };
    const recovery = generationRecovery(id, {
      read,
      update: value => {
        if (read()) useCanvasStore.getState().updateNodeData(id, { ...value });
      },
    }, { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: key => localStorage.removeItem(key) });
    return { recovery, token };
  }, [id, canvasId]);
  const { recovery } = session;
  useEffect(() => {
    activeSession.current = session.token;
    void recovery.recover().catch(() => {
      if (activeSession.current === session.token) useCanvasStore.getState().updateNodeData(id, { isLoading: false, error: '无法读取任务恢复记录' });
    });
    return () => { if (activeSession.current === session.token) activeSession.current = undefined; };
  }, [session, recovery, id]);
  useEffect(() => {
    if (!data.generationTaskId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const active = await recovery.poll(data.generationTaskId!);
      if (!stopped && active) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [data.generationTaskId, recovery, pollVersion]);
  return {
    detach: recovery.detach,
    start: async (request: Parameters<typeof recovery.start>[0]) => {
      const result = recovery.start(request);
      canvasDraftStorage.flush();
      await result;
    },
    retrySave: async () => { await recovery.retrySave(); setPollVersion(v => v + 1); },
    resume: async () => { await recovery.resume(); setPollVersion(v => v + 1); },
  };
}
