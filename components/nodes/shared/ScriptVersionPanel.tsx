'use client';
import { useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { scriptActive, scriptStatusLabel } from '@/lib/script/types';
import { ScriptPublishPanel } from './ScriptPublishPanel';
import type { ScriptVersion, ScriptVersions } from '@/lib/script/versions';

async function requestVersions(url: string, body?: object) {
  const response = await fetch(url, body ? { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : { cache:'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '无法读取脚本版本');
  return value;
}
function DraftEditor({ version, onSaved, onDirty }: { version:ScriptVersion; onSaved:() => void; onDirty:(dirty:boolean) => void }) {
  const [editing,setEditing] = useState<{text:string;revision:number} | null>(null);
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState('');
  const changedElsewhere = editing && editing.revision !== version.draftRevision;
  const save = async () => {
    if (!editing || saving) return;
    setSaving(true); setError('');
    try {
      await requestVersions('/api/script/versions',{ action:'draft',versionId:version.id,text:editing.text,expectedRevision:editing.revision });
      setEditing(null); onDirty(false); onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : '编辑稿保存失败'); }
    finally { setSaving(false); }
  };
  return <div>
    <textarea aria-label="脚本编辑稿" value={editing?.text ?? version.draft} readOnly={scriptActive(version.status) || saving}
      onChange={event => { onDirty(true); setEditing(previous => ({text:event.target.value,revision:previous?.revision ?? version.draftRevision})); }}
      className="h-48 w-full resize-y rounded-lg bg-black/20 p-2 text-sm leading-6 outline-none"/>
    <div className="mt-1 flex items-center gap-3">
      <button type="button" disabled={!editing || saving || !!changedElsewhere} onClick={() => void save()} className="rounded bg-violet-600 px-3 py-1 disabled:opacity-40">{saving ? '保存中' : '保存编辑稿'}</button>
      {editing && <button type="button" disabled={saving} onClick={() => { setEditing(null); onDirty(false); setError(''); }}>放弃本地修改</button>}
      {!editing && <span className="text-zinc-500">已保存 · 修订 {version.draftRevision}</span>}
    </div>
    {(error || changedElsewhere) && <p role="alert" className="mt-2 text-amber-300">{error || '其他窗口已保存新编辑稿。你的本地修改仍在，请复制保留后放弃本地修改以载入最新稿。'}</p>}
    {scriptActive(version.status) ? <p className="mt-2 text-zinc-400">生成结束后可编辑，已保存正文持续更新。</p> : version.status !== 'completed' ? <p className="mt-2 text-amber-300">该版本未完成，编辑不会改变任务状态，也不能发布。</p> : null}
  </div>;
}
export function ScriptVersionPanel({ nodeId }: { nodeId:string }) {
  const canvasId = useCanvasStore(s => s.currentWorkflowId);
  const [state,setState] = useState<ScriptVersions | null>(null);
  const [error,setError] = useState('');
  const [tab,setTab] = useState<'draft'|'original'|'input'>('draft');
  const [selecting,setSelecting] = useState(false);
  const [editingId,setEditingId] = useState<string | null>(null);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!canvasId) return;
    let alive = true; let sequence = 0;
    const load = async () => {
      const current = ++sequence;
      try {
        const value = await requestVersions(`/api/script/versions?canvasId=${encodeURIComponent(canvasId)}&nodeId=${encodeURIComponent(nodeId)}`);
        if (alive && current === sequence) setState(value);
      } catch (error) { if (alive) setError(error instanceof Error ? error.message : '读取版本失败'); }
    };
    refresh.current = () => void load();
    void load(); const timer = setInterval(() => void load(),3000);
    return () => { alive = false; clearInterval(timer); refresh.current = () => {}; };
  },[canvasId,nodeId]);
  const versions = state?.versions.filter(v => v.canvasId === canvasId && v.nodeId === nodeId) ?? [];
  const version = versions.find(v => v.id === (editingId ?? state?.selectedId));
  const select = async (versionId:string) => {
    if (!state || selecting) return;
    setSelecting(true); setError('');
    try {
      await requestVersions('/api/script/versions',{action:'select',canvasId,nodeId,versionId,expectedRevision:state.selectionRevision});
      refresh.current();
    } catch (error) { setError(error instanceof Error ? error.message : '选用版本失败'); refresh.current(); }
    finally { setSelecting(false); }
  };
  return <section aria-label="脚本历史版本" className="mt-3 border-t border-white/10 pt-3 text-xs">
    <details>
      <summary className="cursor-pointer text-zinc-300">历史版本与编辑稿（{versions.length}）{version ? ` · ${scriptStatusLabel[version.status]}` : ''}</summary>
      {version && <div className="mt-3">
        <label className="flex items-center gap-2">选用版本
          <select aria-label="选用脚本版本" disabled={selecting || !!editingId} value={version.id} onChange={event => void select(event.target.value)} className="min-w-0 flex-1 rounded bg-[#303033] p-2">
            {versions.map((v,index) => <option key={v.id} value={v.id}>第 {versions.length-index} 版 · {v.input.model} · {new Date(v.createdAt).toLocaleString()} · {scriptStatusLabel[v.status]}</option>)}
          </select>
        </label>
        {editingId && <p className="mt-2 text-amber-300">本地修改尚未保存，请保存或放弃修改后切换版本。</p>}
        <div className="my-2 flex gap-3">{(['draft','original','input'] as const).map(value => <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)} className={tab === value ? 'text-violet-300' : 'text-zinc-500'}>{{draft:'编辑稿',original:'模型原稿',input:'输入来源'}[value]}</button>)}</div>
        <div className={tab === 'draft' ? '' : 'hidden'}><DraftEditor key={version.id} version={version} onSaved={() => refresh.current()} onDirty={dirty => setEditingId(dirty ? version.id : null)}/></div>
        <ScriptPublishPanel key={`${canvasId}:${nodeId}:${version.id}`} version={version} disabled={!!editingId || selecting}/>
        {tab === 'original' && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-2 font-sans leading-6">{version.text || '尚无已保存正文'}</pre>}
        {tab === 'input' && <div className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-2 leading-6">
          <p>模型：{version.input.model} · 任务：{version.input.preset}</p><p>任务指令：{version.input.instruction || '无'}</p><p>创作要求：{version.input.requirements}</p>
          {version.input.references.map((reference,index) => <div key={`${reference.nodeId}-${index}`} className="mt-2 border-t border-white/10 pt-2"><p>参考 {index+1}：{reference.label}（{reference.type}）</p><p>{reference.content}</p></div>)}
        </div>}
      </div>}
    </details>
    {error && <p role="alert" className="mt-2 text-amber-300">{error}</p>}
  </section>;
}
