'use client';
import { useEffect, useMemo, useRef } from 'react';
import { useCanvasStore, canvasDraftStorage, canvasAutosave } from '@/store/useCanvasStore';
import type { NodeData } from '@/types';
import { useGenerationNotifications } from '@/components/canvas/GenerationNotificationsProvider';
import { generationRecovery } from '@/lib/generation/recovery';

export function useGenerationTask(id: string, data: NodeData) {
  const canvasId = useCanvasStore(s => s.currentWorkflowId);
  const notifications = useGenerationNotifications();
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
    void recovery.recover({ submitPending: !useCanvasStore.getState().generationRecoveryReadOnly?.includes(id) }).catch(() => {
      if (activeSession.current === session.token) useCanvasStore.getState().updateNodeData(id, { isLoading: false, error: '无法读取任务恢复记录' });
    });
    return () => { if (activeSession.current === session.token) activeSession.current = undefined; };
  }, [session, recovery, id]);
  useEffect(() => {
    if (!data.generationTaskId) return;
    return notifications.subscribe(data.generationTaskId, recovery.apply);
  }, [data.generationTaskId, notifications, recovery]);
  return {
    detach: recovery.detach,
    start: async (request: Parameters<typeof recovery.start>[0]) => {
      await canvasAutosave.allowGenerationRecovery(id);
      const result = recovery.start(request);
      canvasDraftStorage.flush();
      await result;
    },
    retrySave: async () => { await recovery.retrySave(); if (data.generationTaskId) notifications.refresh(data.generationTaskId); },
    resume: async () => { await recovery.resume(); if (data.generationTaskId) notifications.refresh(data.generationTaskId); },
  };
}
