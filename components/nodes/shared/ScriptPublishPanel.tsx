'use client';
import { useRef, useState } from 'react';
import { canvasAutosave, useCanvasStore } from '@/store/useCanvasStore';
import type { ScriptVersion } from '@/lib/script/versions';
import { textPurposes, type TextPurpose, type PublishScript, type PublishTarget } from '@/lib/script/publishing-types';

export function ScriptPublishPanel({ version, disabled }: { version:ScriptVersion; disabled:boolean }) {
  const [purpose,setPurpose] = useState<TextPurpose>('script');
  const [review,setReview] = useState<{target:PublishTarget | null} | null>(null);
  const [message,setMessage] = useState('');
  const [busy,setBusy] = useState(false);
  const lock = useRef(false);
  const pending = useCanvasStore(s => s.nodes.find(n => n.id === version.nodeId)?.data.pendingScriptPublish);
  const session = useCanvasStore(s => s.canvasSession);
  const current = () => { const s = useCanvasStore.getState(); return s.canvasSession === session && s.currentWorkflowId === version.canvasId && s.nodes.some(n => n.id === version.nodeId); };
  const prepare = async () => {
    await canvasAutosave.flush();
    if (!current()) throw new Error('画布已切换');
    if (useCanvasStore.getState().saveStatus !== 'synced') throw new Error('请先完成画布保存，再发布');
  };
  const inspect = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setMessage('');
    try {
      await prepare();
      const response = await fetch(`/api/script/publish?canvasId=${encodeURIComponent(version.canvasId)}&nodeId=${encodeURIComponent(version.nodeId)}`,{cache:'no-store'});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      if (current()) setReview(body);
    } catch(error) { if (current()) setMessage(error instanceof Error ? error.message : '无法查看发布目标'); }
    finally { lock.current = false; setBusy(false); }
  };
  const publish = async (mode:'new'|'update',overwrite = false) => {
    if (lock.current) return; lock.current = true; setBusy(true); setMessage('');
    let request: PublishScript | undefined;
    try {
      await prepare();
      const node = useCanvasStore.getState().nodes.find(n => n.id === version.nodeId)!;
      const saved = node.data.pendingScriptPublish;
      request = saved?.canvasId === version.canvasId && saved.nodeId === version.nodeId ? saved : {
        requestId:crypto.randomUUID(),canvasId:version.canvasId,nodeId:version.nodeId,versionId:version.id,expectedDraftRevision:version.draftRevision,purpose,mode,
        ...(mode === 'update' ? {targetId:review?.target?.id,...(overwrite ? {reviewedTargetRevision:review?.target?.revision} : {})} : {}) };
      useCanvasStore.getState().updateNodeData(version.nodeId,{pendingScriptPublish:request});
      await prepare();
      const response = await fetch('/api/script/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
      const body = await response.json();
      if (!current()) return;
      if (response.ok || response.status < 500) {
        useCanvasStore.getState().updateNodeData(version.nodeId,{pendingScriptPublish:undefined});
        // Existing remote-history reconciliation preserves unrelated local edits.
        await canvasAutosave.flush();
      }
      if (!response.ok) { if (body.target) setReview({target:body.target}); throw new Error(body.error || '发布失败'); }
      setReview(null); setMessage('已发布为文本节点；下游使用该文本内容。');
    } catch(error) { if (current()) setMessage(error instanceof Error ? error.message : '发布结果未知，请恢复原发布请求'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <div className="mt-3 border-t border-white/10 pt-3">
    <div className="flex items-center gap-2"><label>文本用途 <select aria-label="发布文本用途" value={purpose} disabled={busy || !!pending} onChange={e => setPurpose(e.target.value as TextPurpose)} className="rounded bg-[#303033] p-1">{Object.entries(textPurposes).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <button type="button" disabled={busy || (!pending && (disabled || version.status !== 'completed' || !version.draft.trim()))} onClick={() => void (pending ? publish(pending.mode) : inspect())} className="rounded bg-violet-600 px-3 py-1 disabled:opacity-40">{busy ? '发布处理中' : pending ? '恢复原发布请求' : '发布编辑稿'}</button></div>
    {review && !pending && <div className="mt-2 rounded bg-black/20 p-3">
      <p>{!review.target ? '创建独立的文本节点供下游使用。' : review.target.deleted ? '原文本已删除，请创建新文本。' : review.target.changed ? '原文本已修改。推荐创建新文本，保留现有内容。' : '选择更新原文本，或创建新的文本节点。'}</p>
      {review.target && !review.target.deleted && <details className="my-2" open={review.target.changed}><summary>查看当前文本</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans">{review.target.text}</pre></details>}
      <div className="mt-2 flex gap-3"><button type="button" disabled={busy || disabled} onClick={() => void publish('new')} className="rounded bg-violet-600 px-2 py-1">创建新文本{review.target?.changed ? '（推荐）' : ''}</button>
      {review.target && !review.target.deleted && <button type="button" disabled={busy || disabled} onClick={() => void publish('update',!!review.target?.changed)} className="rounded border border-white/20 px-2 py-1">{review.target.changed ? '确认覆盖已查看的文本' : '更新原文本'}</button>}
      <button type="button" disabled={busy} onClick={() => setReview(null)}>取消</button></div>
    </div>}
    {message && <p role="status" className="mt-2 text-amber-200">{message}</p>}
  </div>;
}
