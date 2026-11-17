'use client';

import { ImagePlus, Scan } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AgentAssistantUI } from './AgentAssistantUI';
import { AgentPanelFrame } from './AgentPanelFrame';
import { AgentNodePicker } from './AgentNodePicker';
import styles from './AgentSidebar.module.css';
import { BrandMark } from '@/components/ui/brand-mark';
import { uploadAgentReference } from '@/lib/agent/upload';
import { canvasAutosave, useCanvasStore } from '@/store/useCanvasStore';
import { createWorkspaceProject } from '@/lib/workspace/client';
import type { AgentReference, AgentSnapshot } from '@/lib/agent/types';
import type { SkillSummary } from '@/lib/agent/skills';

type Snapshot = AgentSnapshot & { models: { id: string; name: string; available: boolean }[] };
const statusText: Record<string, string> = { queued: '等待执行', running: '执行中', waiting: '等待回答', interrupted: '待继续', completed: '完成', stopped: '已停止', failed: '失败' };

export function AgentSidebar() {
  const projectId = useCanvasStore(state => state.currentWorkflowId);
  const router = useRouter();
  const search = useSearchParams();
  const [open, setOpen] = useState(search.get('assistant') === '1');
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpening(true); setOpenError('');
    try {
      await canvasAutosave.flush();
      if (!useCanvasStore.getState().currentWorkflowId) {
        const id = await createWorkspaceProject(null);
        router.replace(`/canvas?project=${encodeURIComponent(id)}&assistant=1`);
        return;
      }
      setOpen(true);
    } catch { setOpenError('无法打开助手，请等待画布同步后重试。'); }
    finally { setOpening(false); }
  }
  return <><button aria-label="创作助手" disabled={opening} onClick={() => void toggle()} aria-expanded={open} className={styles.launcher}><BrandMark size={20}/>创作助手</button>{openError && <p role="alert" className="fixed right-4 top-32 z-180 bg-background p-2">{openError}</p>}{open && projectId && <AgentConversation key={projectId} projectId={projectId} close={() => setOpen(false)}/>}</>;
}

function AgentConversation({ projectId, close }: { projectId: string; close: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ tasks: [], messages: [], models: [] });
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pickingNodes, setPickingNodes] = useState(false);
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [references, setReferences] = useState<AgentReference[]>([]);
  const task = snapshot.tasks.at(-1);
  const waiting = task?.status === 'waiting' && task.question && !task.question.answer && !task.question.cancelled;
  const pendingRequest = useRef<{ signature: string; requestId: string } | null>(null);
  const endpoint = `/api/agent/${encodeURIComponent(projectId)}`;
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let active = true;
    fetch('/api/personal/skills', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error();
      return response.json();
    }).then(result => { if (active) setSkills(result.data ?? []); })
      .catch(() => { if (active) setError('无法加载创作技能，仍可继续普通对话。'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function refresh() {
      if (!active || inFlight || document.visibilityState === 'hidden') return;
      clearTimeout(timer); inFlight = true;
      let delay = 5000;
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), cache: 'no-store' });
        if (!response.ok) throw new Error('加载失败');
        const data: Snapshot = await response.json();
        if (!active) return;
        setSnapshot(current => data.messages.length < current.messages.length ? current : data);
        const running = data.tasks.some(item => item.status === 'queued' || item.status === 'running' || item.status === 'waiting' && item.awaitingGeneration) || data.generations?.some(batch => batch.items.some(({ task: generation }) => generation && (['queued', 'submitting', 'running'].includes(generation.status) || generation.status === 'succeeded' && ['pending', 'saving'].includes(generation.saveStatus))));
        delay = running ? 1000 : 30_000;
      } catch { if (active) setError('无法同步助手，请检查连接。'); }
      finally { inFlight = false; if (active) timer = setTimeout(() => void refresh(), delay); }
    }
    const wake = () => { void refresh(); };
    void refresh();
    document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake);
    return () => { active = false; controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); };
  }, [endpoint, refreshVersion]);

  async function send(action: string, value: string, messageReferences = references) {
    setBusy(true); setError('');
    try {
      await canvasAutosave.flush();
      const signature = JSON.stringify({ action, value, model, references: messageReferences, questionId: task?.question?.id });
      if (pendingRequest.current?.signature !== signature) pendingRequest.current = { signature, requestId: crypto.randomUUID() };
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, requestId: pendingRequest.current.requestId, text: value, modelId: model || snapshot.models.find(item => item.available)?.id, references: messageReferences, questionId: task?.question?.id }) });
      if (!response.ok) throw new Error((await response.json()).error);
      pendingRequest.current = null; setReferences([]);
      // External-store runtimes expect the host snapshot to carry an accepted
      // message before onNew resolves; otherwise the optimistic row is removed.
      const refreshed = await fetch(endpoint, { cache: 'no-store' });
      if (refreshed.ok) {
        const data: Snapshot = await refreshed.json();
        setSnapshot(current => data.messages.length < current.messages.length ? current : data);
      }
      setRefreshVersion(version => version + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '发送失败'); }
    finally { setBusy(false); }
  }

  function referenceSelection() {
    const nodes = useCanvasStore.getState().nodes.filter(node => node.selected);
    if (!nodes.length) { setPickingNodes(true); return; }
    setReferences(old => [...old, ...nodes.filter(node => !old.some(reference => reference.nodeId === node.id)).map(node => ({ nodeId: node.id, name: String(node.data.customTitle || node.data.label || node.type) }))].slice(0, 8));
  }
  async function upload(file?: File) {
    if (!file || references.length >= 8) return;
    setUploading(true); setError('');
    try { const reference = await uploadAgentReference(file); setReferences(old => [...old, reference].slice(0, 8)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '参考图上传失败，请重试。'); }
    finally { setUploading(false); }
  }

  const statusContent = <>
    {snapshot.generations?.filter(batch => batch.taskId === task?.id).map(batch => <div key={batch.id} aria-label="生成进度" className={styles.progress}>{batch.items.map((item, index) => <p key={index}>{item.nodeId}：{item.task ? ({ queued: '等待生成', submitting: '提交中', running: '生成中', succeeded: item.task.saveStatus === 'saved' ? '已保存' : item.task.saveStatus === 'failed' ? '保存失败，可要求重试保存' : '保存中', failed: '生成失败', uncertain: '提交结果待核实，请勿重复生成', cancelled: '已取消，重新生成需要确认', timed_out: '查询超时' }[item.task.status]) : batch.status === 'pending' ? '等待确认' : '已取消'}{item.task?.error ? ` · ${item.task.error}` : ''}{item.note ? ` · ${item.note}` : ''}</p>)}</div>)}
    {waiting && <div className={styles.question}><span className={styles.eyebrow}>需要你的确认</span><p>{task.question!.text}</p>{task.question!.scope?.kind === 'generation' && <ol aria-label="生成方案" className="max-h-52 overflow-y-auto space-y-2 text-sm">{task.question!.scope.items.map((item, index) => <li key={index} className="rounded border p-2"><strong>{index + 1}. {item.modelId} → {item.nodeId}</strong>{item.newNode && <p>目标已有结果，将新建节点，原结果保留</p>}<p className="whitespace-pre-wrap break-words">{item.input.prompt}</p><p>数量：1 · {item.specification ?? `${item.input.width} × ${item.input.height}`}{item.input.duration ? ` · ${item.input.duration} 秒` : ''}{item.input.instanceType ? ' · 高性能渠道' : ''}</p>{item.input.references?.map((reference, index) => <a key={index} href={reference.url} target="_blank" rel="noreferrer" className="block truncate underline">参考 {index + 1} · {reference.kind}{reference.kind === 'video' ? reference.useAudio ? '（使用原声）' : '（无原声）' : ''}</a>)}</li>)}</ol>}{task.question!.options.map(option => <button key={option} disabled={busy || uploading} onClick={() => void send('answer', option)} className={styles.option}>{option}</button>)}<p className="text-xs">也可输入回答或修改要求；停止会取消本次等待。</p></div>}
  </>;

  return <AgentPanelFrame close={close}>
    <div className={styles.context}><span><Scan size={13}/> 当前画布</span><span role="status"><i data-active={task?.status === 'running' || task?.status === 'queued'}/>{task ? task.status === 'interrupted' ? '待继续' : task.awaitingGeneration ? '等待生成结果' : task.question?.scope?.kind === 'generation' && waiting ? '等待批准' : statusText[task.status] : '可以开始创作'}</span></div>
    <AgentAssistantUI messages={snapshot.messages} tasks={snapshot.tasks} task={task} skills={skills} waiting={!!waiting} busy={busy || !snapshot.models.some(item => item.available)} uploading={uploading} error={error} references={references}
      onRemoveReference={index => setReferences(old => old.filter((_, itemIndex) => itemIndex !== index))}
      onSubmit={value => send(waiting ? 'answer' : 'send', value)}
      onRetry={parentId => { const original = snapshot.messages.find(message => message.id === parentId) ?? [...snapshot.messages].reverse().find(message => message.role === 'user'); return original ? send('send', original.text, original.references) : Promise.reject(new Error('没有可重试的消息')); }}
      onStop={() => send('stop', '')} onResume={() => send('continue', '')} statusContent={statusContent}
      picker={pickingNodes ? <AgentNodePicker references={references} onChange={setReferences} close={() => setPickingNodes(false)}/> : null}
      referenceTools={<div className={styles.referenceTools}><button aria-expanded={pickingNodes} disabled={busy || uploading} onClick={() => setPickingNodes(!pickingNodes)}><Scan size={14}/>选择节点</button><button disabled={busy || uploading || references.length >= 8} onClick={referenceSelection}><Scan size={14}/>引用选中节点</button><label aria-disabled={busy || uploading || references.length >= 8}><ImagePlus size={14}/>添加参考图<input aria-label="添加参考图" type="file" disabled={busy || uploading || references.length >= 8} accept="image/png,image/jpeg,image/webp" className="hidden" onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }}/></label></div>}
      modelControl={<select aria-label="助手模型" value={model || snapshot.models.find(item => item.available)?.id || ''} onChange={event => setModel(event.target.value)}><option value="" disabled>选择可用模型</option>{snapshot.models.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.name}{!item.available ? '（未配置）' : ''}</option>)}</select>}/>
  </AgentPanelFrame>;
}
