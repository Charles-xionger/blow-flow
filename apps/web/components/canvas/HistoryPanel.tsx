"use client";

import { useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { historyBatches, operationDetails, type HistoryBatchView } from '@/lib/canvas/history-view';
import { saveStatusText } from '@/lib/canvas/save-status';
import type { HistoryOperation } from '@/lib/canvas/history';

import { pageSize, actionNames, buttonClass, Time, Pages } from './HistoryPagination';
function Operation({ operation }: { operation: HistoryOperation }) {
  const [page, setPage] = useState(0);
  const details = operationDetails(operation);
  return <li className="border-t border-zinc-400/20 py-2">
    <p className="text-xs text-zinc-500">{actionNames[operation.kind]} · <Time value={operation.time} /></p>
    <ul className="mt-1 text-sm">{details.slice(page * pageSize, (page + 1) * pageSize).map((detail, i) => <li key={i}>{detail}</li>)}</ul>
    {details.length > pageSize && <Pages page={page} total={details.length} setPage={setPage} name="受影响内容" />}
  </li>;
}
function Batch({ batch }: { batch: HistoryBatchView }) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  return <li data-testid="history-batch" className="rounded-xl border border-zinc-400/30 p-3">
    <div className="flex items-start justify-between gap-4"><strong>{batch.label}</strong><span className="text-xs">{batch.status}</span></div>
    <p className="mt-1 text-xs text-zinc-500"><Time value={batch.time} /> · 批次 {batch.id.slice(0, 8)}</p>
    <button className={`${buttonClass} mt-2`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起批次详情' : '查看批次详情'}</button>
    {expanded && <div className="mt-2">
      <p className="text-xs">完整批次编号：{batch.id} · {batch.operations.length} 次内部操作</p>
      {batch.operations.length ? <ol>{batch.operations.slice(page * pageSize, (page + 1) * pageSize).map(op => <Operation key={op.id} operation={op} />)}</ol>
        : <p className="text-sm">旧记录未保存内部操作明细。</p>}
      {batch.operations.length > pageSize && <Pages page={page} total={batch.operations.length} setPage={setPage} name="内部操作" />}
    </div>}
  </li>;
}
export default function HistoryPanel({ onClose }: { onClose: () => void }) {
  const history = useCanvasStore(state => state.history);
  const name = useCanvasStore(state => state.projectName);
  const saveStatus = useCanvasStore(state => state.saveStatus);
  const saveError = useCanvasStore(state => state.saveError);
  const [page, setPage] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const batches = history ? historyBatches(history) : [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(batches.length / pageSize) - 1));
  return <dialog ref={dialog} aria-labelledby="history-title" onClose={onClose}
    onKeyDown={event => event.stopPropagation()}
    className="m-auto max-h-[85vh] w-[640px] max-w-[95vw] overflow-y-auto rounded-2xl bg-white p-5 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:bg-zinc-900 dark:text-zinc-100">
    <header className="flex items-center justify-between"><h2 id="history-title" className="text-lg font-semibold">操作历史</h2>
      <button autoFocus className={buttonClass} aria-label="关闭历史" onClick={() => dialog.current?.close()}>关闭</button></header>
    <p className="mt-2 truncate">{name}</p>
    <p role="status" data-testid="history-save-status" className="text-sm">{saveStatusText[saveStatus]}</p>
    {saveError && <p role="alert" className="text-sm text-amber-600">{saveError}</p>}
    <p className="my-3 text-sm text-zinc-500">记录包含尚未保存的当前编辑；保存状态以此处为准。撤销和重做按顺序执行，失效分支仅供追溯。</p>
    <p className="text-sm">当前可撤销 {history?.undo.length ?? 0} 步 · 可重做 {history?.redo.length ?? 0} 步</p>
    {history?.notice && <p className="text-sm text-amber-600">{history.notice}</p>}
    <Pages page={currentPage} total={batches.length} setPage={setPage} name="批次" />
    {batches.length ? <ol className="space-y-3">{batches.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(batch => <Batch key={batch.id} batch={batch} />)}</ol>
      : <p className="py-8 text-center text-zinc-500">暂无操作记录。旧项目从启用历史后的编辑开始记录。</p>}
  </dialog>;
}
