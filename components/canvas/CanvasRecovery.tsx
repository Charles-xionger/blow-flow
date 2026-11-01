'use client';

import { useState } from 'react';
import { canvasAutosave, useCanvasStore } from '@/store/useCanvasStore';
import { LEGACY_CANVAS_KEY } from '@/lib/canvas/legacy-draft';

/** Shared recovery entry point for imported drafts and future conflict handling. */
export function CanvasRecovery() {
  const recovery = useCanvasStore(state => state.recovery);
  const copies = useCanvasStore(state => state.recoveryCopies);
  const failed = useCanvasStore(state => state.saveStatus === 'migration-error');
  const ready = useCanvasStore(state => state.persistenceReady);
  const saveError = useCanvasStore(state => state.saveError);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!failed && !recovery && !copies?.length) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const exportBackup = () => {
    const raw = localStorage.getItem(LEGACY_CANVAS_KEY);
    if (raw === null) throw new Error('没有找到旧草稿备份');
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'canvas-storage-backup.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const buttonClass = 'rounded border px-3 py-1 text-sm disabled:opacity-50';
  return (
    <aside aria-label="草稿恢复" className="absolute bottom-6 left-4 z-50 max-w-lg space-y-2 rounded-xl border bg-white p-4 text-gray-900 shadow-lg dark:bg-zinc-900 dark:text-gray-100">
      {failed ? <>
        <p>旧草稿迁移失败，原始备份已保留。</p>
        <button className={buttonClass} disabled={busy || !ready && !failed} onClick={() => void run(() => canvasAutosave.open(new URLSearchParams(location.search).get('project')))}>重试迁移</button>
        <button className={buttonClass} disabled={busy || !ready && !failed} onClick={() => void run(async () => exportBackup())}>导出旧草稿原文</button>
      </> : null}
      {recovery ? <>
        <p>{recovery.kind === 'conflict' ? '本地草稿与服务端不同，双方内容均已保留。'
          : recovery.kind === 'copy' ? '这是独立恢复副本，可另存为新画布。'
          : '旧草稿尚未核对服务端，已暂停上传。联网后可重试核对或另存。'}</p>
        {recovery.kind !== 'copy' ? <>
          <button className={buttonClass} disabled={busy || !ready && !failed} onClick={() => void run(() => canvasAutosave.recover('server'))}>采用服务端版本</button>
          <button className={buttonClass} disabled={busy || !ready && !failed} onClick={() => void run(() => canvasAutosave.save())}>重试核对</button>
        </> : null}
        <button className={buttonClass} disabled={busy || !ready && !failed} onClick={() => void run(() => canvasAutosave.recover('copy'))}>将本地内容另存为新画布</button>
      </> : null}
      {copies?.length ? <details><summary>恢复副本（{copies.length}）</summary>
        {copies.map(copy => <button key={copy.id} className={`${buttonClass} block`} disabled={busy || !ready && !failed}
          onClick={() => void run(() => canvasAutosave.open(copy.id))}>打开恢复副本：{copy.name}</button>)}
      </details> : null}
      {error || recovery && saveError ? <p role="alert">{error || saveError}</p> : null}
    </aside>
  );
}
