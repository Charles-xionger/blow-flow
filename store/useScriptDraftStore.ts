'use client';
import { create } from 'zustand';

export interface PendingScriptDraft { text: string; revision: number }
interface DraftState {
  drafts: Record<string, PendingScriptDraft>;
  loaded: boolean;
  storageError: string;
}
const storagePrefix = 'ai-flow:pending-script-draft:v1:';
export const scriptDraftKey = (canvasId: string, nodeId: string, versionId: string) => JSON.stringify([canvasId,nodeId,versionId]);
export const useScriptDraftStore = create<DraftState>(() => ({ drafts:{},loaded:false,storageError:'' }));
const storageWarning = '本地编辑稿缓存不可用。当前页面仍保留修改，请保存到服务器或复制文字后再刷新／关闭页面。';

/** Called on mount; the store outlives both the inline console and its expanded portal. */
export function loadScriptDrafts() {
  if (useScriptDraftStore.getState().loaded) return;
  try {
    const drafts: Record<string, PendingScriptDraft> = {};
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(storagePrefix)) continue;
      const draft = JSON.parse(localStorage.getItem(key) || 'null');
      if (!draft || typeof draft.text !== 'string' || !Number.isSafeInteger(draft.revision) || draft.revision < 0) throw new Error('Invalid draft cache');
      drafts[key.slice(storagePrefix.length)] = draft;
    }
    useScriptDraftStore.setState({drafts,loaded:true});
  } catch { useScriptDraftStore.setState({loaded:true,storageError:storageWarning}); }
}
function persist(drafts: DraftState['drafts'], key: string) {
  useScriptDraftStore.setState({drafts});
  try {
    // Separate keys prevent a different node's edits in another tab being overwritten.
    if (drafts[key]) localStorage.setItem(storagePrefix+key,JSON.stringify(drafts[key]));
    else localStorage.removeItem(storagePrefix+key);
    useScriptDraftStore.setState({storageError:''});
  } catch { useScriptDraftStore.setState({storageError:storageWarning}); }
}
export function editScriptDraft(key: string, text: string, revision: number) {
  const drafts = useScriptDraftStore.getState().drafts;
  persist({...drafts,[key]:{text,revision:drafts[key]?.revision ?? revision}},key);
}
export function clearScriptDraft(key: string, expected: PendingScriptDraft) {
  const drafts = useScriptDraftStore.getState().drafts;
  // A save finishing after unmount must not erase newer local typing.
  if (drafts[key] !== expected) return;
  const next = {...drafts};
  delete next[key];
  persist(next,key);
}
