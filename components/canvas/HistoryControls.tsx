"use client";

import { Undo2, Redo2 } from 'lucide-react';
import { useCanvasStore } from '@/store/useCanvasStore';

export function HistoryControls() {
  const canUndo = useCanvasStore(state => state.persistenceReady && !!state.history?.undo.length);
  const canRedo = useCanvasStore(state => state.persistenceReady && !!state.history?.redo.length);
  const notice = useCanvasStore(state => state.history?.notice);
  const travel = (direction: 'undo' | 'redo') => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    useCanvasStore.getState()[direction]();
  };
  return <>
    <button type="button" aria-label="撤销" title="撤销 (Ctrl/⌘ Z)" disabled={!canUndo} onClick={() => travel('undo')}
      className="rounded-lg p-2 hover:bg-zinc-500/10 disabled:opacity-30"><Undo2 size={16} /></button>
    <button type="button" aria-label="重做" title="重做 (Ctrl/⌘ Shift Z)" disabled={!canRedo} onClick={() => travel('redo')}
      className="rounded-lg p-2 hover:bg-zinc-500/10 disabled:opacity-30"><Redo2 size={16} /></button>
    {notice && <span role="status" title={notice} className="max-w-32 text-xs text-amber-600">历史已分段</span>}
  </>;
}
