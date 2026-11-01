'use client';

import { useState } from 'react';
import { History, X } from 'lucide-react';
import { canvasAutosave, useCanvasStore } from '@/store/useCanvasStore';
import { LEGACY_CANVAS_KEY } from '@/lib/canvas/legacy-draft';
import { canvasSnapshot } from '@/lib/canvas/snapshot';

/** Shared recovery entry point for imported drafts and future conflict handling. */
export function CanvasRecovery() {
  const recovery = useCanvasStore(state => state.recovery);
  const copies = useCanvasStore(state => state.recoveryCopies);
  const failed = useCanvasStore(state => state.saveStatus === 'migration-error');
  const localFailed = useCanvasStore(state => state.saveStatus === 'local-error');
  const ready = useCanvasStore(state => state.persistenceReady);
  const saveError = useCanvasStore(state => state.saveError);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copiesOpen, setCopiesOpen] = useState(false);
  if (!failed && !localFailed && !recovery && !copies?.length) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const download = (raw: string, filename: string) => {
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportBackup = () => {
    const raw = localStorage.getItem(LEGACY_CANVAS_KEY);
    if (raw === null) throw new Error('没有找到旧草稿备份');
    download(raw, 'canvas-storage-backup.json');
  };
  const exportCurrent = () => {
    const state = useCanvasStore.getState();
    if (!state.persistenceReady) throw new Error('画布尚未恢复，无法导出当前内容');
    const snapshot = canvasSnapshot(state);
    download(JSON.stringify({ ...snapshot, projectName: snapshot.name,
      id: state.currentWorkflowId, version: '1.0.0' }, null, 2), 'canvas-recovery.json');
  };
  const actionError = error && error !== saveError ? error : undefined;
  const buttonClass = 'rounded border px-3 py-1 text-sm disabled:opacity-50';
  const needsAttention = failed || localFailed || !!recovery;
  const copyButtons = copies?.map(copy => <button key={copy.id} className={`${buttonClass} block`} disabled={busy || !ready && !failed}
    onClick={() => void run(() => canvasAutosave.open(copy.id))}>打开恢复副本：{copy.name}</button>);
  if (!needsAttention && !copiesOpen) return (
    <button type="button" aria-expanded={false} title="查看保存在本机的恢复副本" onClick={() => setCopiesOpen(true)}
      className="absolute bottom-6 left-16 z-50 flex items-center gap-2 rounded-full border bg-white px-3 py-2 text-xs text-gray-600 shadow-sm hover:bg-gray-50 dark:bg-zinc-900 dark:text-gray-300 dark:hover:bg-zinc-800">
      <History size={14} aria-hidden="true" />恢复副本（{copies?.length}）
    </button>
  );
  return (
    <aside aria-label="草稿恢复" className="absolute bottom-6 left-4 z-50 max-w-lg space-y-2 rounded-xl border bg-white p-4 text-gray-900 shadow-lg dark:bg-zinc-900 dark:text-gray-100">
      {!needsAttention ? <div className="flex items-center justify-between gap-6">
        <span className="text-sm font-medium">恢复副本（{copies?.length}）</span>
        <button type="button" aria-label="收起恢复副本" onClick={() => setCopiesOpen(false)}
          className="rounded p-1 hover:bg-gray-100 dark:hover:bg-zinc-800"><X size={16} aria-hidden="true" /></button>
      </div> : null}
      {localFailed ? <>
        <p>{ready ? '当前修改尚未保存到本地。请保持此页面打开，重试或导出以保留内容。' : '画布恢复失败，尚未加载原有内容。请重试恢复。'}</p>
        <p role="alert">{saveError}</p>
        <button className={buttonClass} disabled={busy} onClick={() => void run(() => ready
          ? canvasAutosave.save() : canvasAutosave.open(new URLSearchParams(location.search).get('project')))}>{ready ? '重试保存' : '重试恢复'}</button>
        {ready ? <button className={buttonClass} disabled={busy} onClick={() => void run(async () => exportCurrent())}>导出当前画布</button> : null}
      </> : null}
      {failed ? <>
        <p>旧草稿迁移失败，原始备份已保留。</p>
        <p role="alert">{saveError}</p>
        <button className={buttonClass} disabled={busy || !ready && !failed} onClick={() => void run(() => canvasAutosave.open(new URLSearchParams(location.search).get('project')))}>重试迁移</button>
        <button className={buttonClass} disabled={busy || !ready && !failed} onClick={() => void run(async () => exportBackup())}>导出旧草稿原文</button>
      </> : null}
      {recovery ? <>
        <p>{recovery.kind === 'deleted' ? '服务端项目已删除，本地内容已保留。可另存为新画布。'
          : recovery.kind === 'conflict' ? '本地草稿与服务端不同，双方内容均已保留。'
          : recovery.kind === 'copy' ? '这是独立恢复副本，可另存为新画布。'
          : '旧草稿尚未核对服务端，已暂停上传。联网后可重试核对或另存。'}</p>
        {recovery.kind !== 'copy' && recovery.kind !== 'deleted' ? <>
          <button className={buttonClass} disabled={busy || !ready && !failed} onClick={() => void run(() => canvasAutosave.recover('server'))}>采用服务端版本</button>
          <button className={buttonClass} disabled={busy || !ready && !failed} onClick={() => void run(() => canvasAutosave.save())}>重试核对</button>
        </> : null}
        <button className={buttonClass} disabled={busy || !ready && !failed} onClick={() => void run(() => canvasAutosave.recover('copy'))}>将本地内容另存为新画布</button>
      </> : null}
      {copies?.length ? needsAttention ? <details><summary>恢复副本（{copies.length}）</summary>{copyButtons}</details> : copyButtons : null}
      {actionError || recovery && !localFailed && !failed && saveError ? <p role="alert">{actionError || saveError}</p> : null}
    </aside>
  );
}
