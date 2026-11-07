'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, Download, Film, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { CanvasPreview } from '@/components/ui/canvas-preview';
import { NodeType, type NodeData } from '@/types';
import { useCanvasStore } from '@/store/useCanvasStore';
import { stopScriptTask } from '@/lib/script/client';
import { scriptActive, scriptPhaseLabel, scriptStatusLabel, type ScriptTask } from '@/lib/script/types';
import { defaultStoryboardLimits, parseStoryboard, serializeStoryboard, shotFields, shotSeconds, storyboardProblem, type StoryboardShot } from '@/lib/script/storyboard';
import { workflowProgress, workflowStage } from '@/lib/script/pipeline/types';
import { NodeShell, NodeToolbarButton } from './NodeShell';

const Particles = dynamic(() => import('./shared/ScriptParticles'), { ssr: false });
const tabs = ['确认镜头', '资产设定', '视频提示词'] as const;
const button = 'rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-40';

export function StoryboardNode({ text, task, nodeConsole, extraToolbar, onChangeText, onContinue, continuing, canContinue = true, onConfigure, ...props }: NodeProps<Node<NodeData>> & { text: string; task?: ScriptTask; nodeConsole?: ReactNode; extraToolbar?: ReactNode; onChangeText?: (text: string) => void; onContinue?: () => void; continuing?: boolean; canContinue?: boolean; onConfigure?: () => void }) {
  const { id, data } = props;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);
  const [error, setError] = useState('');
  const [now, setNow] = useState(0);
  const update = useCanvasStore(state => state.updateNodeData);
  const nodes = useCanvasStore(state => state.nodes);
  const flow = useReactFlow();
  const limits = task?.workflow ? task.input.storyboard ?? defaultStoryboardLimits : data.storyboard ?? defaultStoryboardLimits;
  const shots = useMemo(() => parseStoryboard(text), [text]);
  const active = scriptActive(task?.status);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  const currentStep = task?.workflow?.steps.find(step => step.status === 'running');
  const waiting = active && currentStep?.startedAt && now > currentStep.startedAt ? ` · ${Math.floor((now - currentStep.startedAt) / 1000)}秒` : '';
  const locked = active || !!task?.workflow && task.status !== 'completed';
  const progress = workflowProgress(task?.workflow, task?.status === 'completed');
  const stage = task?.workflow ? workflowStage(task.workflow) : '';
  const retryable = !!task?.workflow && ['failed','stopped','interrupted'].includes(task.status);
  const total = shots.reduce((sum, shot) => sum + shotSeconds(shot), 0);
  const problem = storyboardProblem(shots, limits);
  const status = task ? task.status === 'running' && task.phase ? scriptPhaseLabel[task.phase] : scriptStatusLabel[task.status] : '可编辑';
  const workflowAssets = task?.workflow?.assets;
  const assets = useMemo(() => workflowAssets ? workflowAssets.map(asset => ({ ...asset, key: `${asset.kind}:${asset.name}`, context: asset.description })) : (['characters', 'scene', 'props'] as const).flatMap(kind => {
    const names = [...new Set(shots.flatMap(shot => shot[kind].split(/[、，,；;\n]/).map(name => name.trim()).filter(name => name && name !== '无')))];
    return names.map(name => ({ kind, name, key: `${kind}:${name}`, context: shots.filter(shot => shot[kind].includes(name)).map(shot => shot.visual).join('\n') }));
  }), [shots, workflowAssets]);
  const linked = (key: string) => nodes.find(node => node.data.storyboardAsset?.boardId === id && node.data.storyboardAsset.key === key);
  const ready = assets.filter(asset => linked(asset.key)?.data.imageSrc).length;
  const prompts = shots.filter(shot => shot.prompt.trim()).length;
  const focus = (nodeId: string) => { setOpen(false); useCanvasStore.getState().setSelectedNodeIds([nodeId]); void flow.fitView({ nodes: [{ id: nodeId }], duration: 250, padding: 0.5, maxZoom: 1 }); };
  const save = (next: StoryboardShot[]) => { const value = serializeStoryboard(next); if (onChangeText) onChangeText(value); else update(id, { prompt: [{ text: value }] }); };
  const change = (index: number, key: keyof StoryboardShot, value: string) => save(shots.map((shot, i) => i === index ? { ...shot, [key]: value } : shot));
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${data.customTitle || '分镜'}.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const createAsset = (asset: typeof assets[number]) => {
    const existing = linked(asset.key); if (existing) { focus(existing.id); return; }
    const state = useCanvasStore.getState(); const source = state.nodes.find(node => node.id === id); if (!source) return;
    // Assets only enter the canvas on request, never as a side effect of streaming a storyboard.
    const x = props.positionAbsoluteX + (source.data.displaySize?.width || 320) + 100;
    const occupied = state.nodes.filter(node => !node.parentId && Math.abs(node.position.x - x) < 360);
    const y = Math.max(props.positionAbsoluteY, ...occupied.map(node => node.position.y + (node.data.displaySize?.height || 240) + 60));
    const nodeId = state.addNode(NodeType.TEXT_TO_IMAGE, { x, y });
    state.updateNodeData(nodeId, { customTitle: asset.name, storyboardAsset: { boardId: id, key: asset.key },
      prompt: [{ text: `为短片制作${asset.kind === 'characters' ? '角色设定图' : asset.kind === 'scene' ? '场景设定图' : '道具设定图'}：${asset.name}。保持与以下分镜的视觉设定一致：\n${asset.context}` }] });
    focus(nodeId);
  };
  return <>
    <NodeShell {...props} console={nodeConsole} toolbar={<>{extraToolbar}<NodeToolbarButton label="打开分镜" icon={ArrowUpRight} onClick={() => setOpen(true)} /><NodeToolbarButton label="下载分镜文稿" icon={Download} disabled={!text} onClick={download} /></>}>
      <div className="relative flex h-full flex-col gap-1.5 overflow-hidden p-3">
        {active && !shots.length && <Particles />}
        <div className="relative flex items-center gap-2 text-zinc-200"><Film size={18} /><span className="text-sm font-medium">分镜</span><span className="ml-auto text-xs text-zinc-500">{limits.duration} 秒 · 最多 {limits.maxShots} 镜</span></div>
        <div className="relative grid flex-1 grid-cols-3 gap-2 overflow-hidden">
          {tabs.map((label, index) => <button key={label} className="nodrag rounded-lg border border-white/5 bg-white/[0.03] p-2 text-left" onClick={() => { setTab(index); setOpen(true); }}>
            <span className="mb-2 block text-xs text-zinc-500">0{index + 1}</span><span className="block text-xs text-zinc-200">{label}</span>
            <span className="mt-2 block text-[10px] text-zinc-500">{index === 0 ? `${shots.length} 个镜头 · ${total} 秒` : index === 1 ? `${ready}/${assets.length} 已有图片` : `${prompts}/${shots.length} 已填写`}</span>
          </button>)}
        </div>
        <div role="status" className="relative flex items-center justify-between text-[11px] text-zinc-400"><span>{task?.workflow ? `${active ? stage : retryable ? `${status} · ${stage}` : status}${waiting} · ${progress}%` : active ? `${status} · 已收到 ${shots.length} 个镜头` : task ? status : text ? problem ? '分镜待调整' : '可编辑' : '等待生成'}</span>
          {active && task && <button className="nodrag" onClick={() => void stopScriptTask(task.id).catch(() => setError('停止失败，请稍后重试'))}>停止</button>}
        </div>
        {task?.workflow && <div role="progressbar" aria-label="分镜流程完成度" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} className="relative h-1 shrink-0 overflow-hidden rounded bg-white/10"><div className="h-full bg-violet-400 transition-[width]" style={{ width: `${progress}%` }} /></div>}
        {retryable && onContinue && <button disabled={continuing || !canContinue} className="nodrag relative text-left text-xs text-amber-300 disabled:opacity-40" onClick={onContinue}>{continuing ? '正在提交…' : canContinue ? '继续未完成步骤 →' : '配置已变更，请在控制台发起新流程'}</button>}
        <button className="nodrag relative rounded-xl bg-white/10 py-2.5 text-xs text-zinc-100 hover:bg-white/15" onClick={() => setOpen(true)}>查看分镜内容 →</button>
        {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
      </div>
    </NodeShell>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent overlayZIndex={200} contentZIndex={201} className="nokey nodrag nopan nowheel flex h-[90dvh] w-[96vw] max-w-none flex-col gap-0 overflow-hidden rounded-2xl border-white/10 bg-[#141414] p-0 text-zinc-200 sm:max-w-none" onPointerDown={event => event.stopPropagation()}>
        <div className="shrink-0 border-b border-white/10 px-6 py-5 pr-14">
          <DialogTitle className="text-base">{data.customTitle || '分镜'}<span className="ml-3 text-xs font-normal text-zinc-500">目标 {limits.duration} 秒 · 最多 {limits.maxShots} 镜 · 每镜 ≤15 秒</span></DialogTitle>
          <DialogDescription className="mt-2 text-xs text-zinc-500">镜头、资产与提示词集中管理；创建图片节点时才展开到画布。</DialogDescription>
          <div role="tablist" aria-label="分镜制作步骤" className="mt-5 flex gap-3">
            {tabs.map((label, index) => <button key={label} role="tab" id={`${id}-tab-${index}`} aria-selected={tab === index} aria-controls={`${id}-panel`} className={`flex items-center gap-3 rounded-xl px-5 py-3 text-left ${tab === index ? 'bg-white/10 text-white' : 'text-zinc-500 hover:bg-white/5'}`} onClick={() => setTab(index)}>
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-current text-xs">{index + 1}</span><span className="text-sm">{label}<span className="mt-1 block text-[11px] text-zinc-500">{index === 0 ? `${shots.length} 镜 · ${total} 秒` : index === 1 ? `${ready}/${assets.length} 已有图片` : `${prompts}/${shots.length} 已填写`}</span></span>
            </button>)}
          </div>
        </div>
        {task?.workflow && <div className="shrink-0 border-b border-white/10 px-5 py-3">
          <div className="mb-2 flex justify-between text-xs text-zinc-400"><span>{active ? stage : status} · 已细化 {Object.keys(task.workflow.details).length}/{shots.length} 镜</span><span>{progress}%</span></div>
          <div className="h-1 rounded bg-white/10"><div className="h-full rounded bg-violet-400" style={{ width: `${progress}%` }} /></div>
          <div className="mt-2 flex flex-wrap gap-2">{task.workflow.steps.map(step => <details key={step.key} className="max-w-full rounded bg-white/5 px-2 py-1 text-[11px] text-zinc-400"><summary className="cursor-pointer">{step.label} · {step.status === 'completed' ? '完成' : step.status === 'failed' ? '失败' : step.status === 'running' && active ? scriptPhaseLabel[step.phase as keyof typeof scriptPhaseLabel] || '执行中' : '待执行'}</summary><div className="mt-2 max-h-40 max-w-xl overflow-auto whitespace-pre-wrap break-words">{step.error || ''}{step.draft ? `\n${step.draft}` : '\n尚无正文'}<p className="mt-1 text-zinc-500">阶段草稿仅供查看；校验完成后才填入结果。</p></div></details>)}</div>
          {locked && <p className="mt-2 text-[11px] text-zinc-500">检查点内容已保存；流程完成后可编辑。停止或失败后点击继续，已完成步骤不会重跑。</p>}
        </div>}
        <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className="min-h-0 flex-1 overflow-auto overscroll-contain p-5">
          {tab !== 1 ? shots.length ? <table className="w-full min-w-[1100px] border-collapse text-xs"><thead className="sticky top-0 z-10 bg-[#242424] text-zinc-400"><tr><th className="border border-white/10 p-3 text-left">镜号</th>
            {(tab === 0 ? shotFields.slice(0, 7) : [shotFields[1], shotFields[10]]).map(([key, label]) => <th key={key} className="border border-white/10 p-3 text-left">{label}</th>)}<th className="border border-white/10 p-3">操作</th></tr></thead>
            <tbody>{shots.map((shot, index) => <tr key={index} className="align-top"><td className="w-20 border border-white/10 p-3 text-zinc-400">{String(index + 1).padStart(2, '0')}</td>
              {(tab === 0 ? shotFields.slice(0, 7) : [shotFields[1], shotFields[10]]).map(([key, label]) => <td key={key} className={`border border-white/10 p-2 ${key === 'visual' || key === 'prompt' ? 'min-w-64' : key === 'duration' ? 'w-20' : 'min-w-32'}`}>
                <textarea aria-label={`镜头 ${index + 1} ${label}`} disabled={locked} value={shot[key]} onChange={event => change(index, key, event.target.value)} rows={key === 'duration' ? 2 : 5} className="w-full resize-y rounded bg-transparent p-1 leading-6 outline-none focus:bg-white/5 disabled:opacity-70" />
              </td>)}<td className="w-16 border border-white/10 p-3"><button aria-label={`删除镜头 ${index + 1}`} disabled={locked} className="text-zinc-500 hover:text-red-300 disabled:opacity-30" onClick={() => save(shots.filter((_, i) => i !== index))}><Trash2 size={15} /></button></td></tr>)}</tbody></table>
          : <div className="flex h-full min-h-40 items-center justify-center whitespace-pre-wrap text-sm text-zinc-500">{active ? '正在规划镜头，收到内容后将在列表中实时显示…' : text || '还没有镜头，可回到脚本节点生成，或添加镜头。'}</div>
          : <div className="space-y-8">{(['characters', 'scene', 'props'] as const).map(kind => <section key={kind}><h3 className="mb-3 text-sm">{kind === 'characters' ? '角色' : kind === 'scene' ? '场景' : '道具'}</h3>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{assets.filter(asset => asset.kind === kind).map(asset => { const node = linked(asset.key); return <div key={asset.key} className="rounded-xl border border-white/10 p-3">
              <div className="mb-3 flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-white/[0.03]">{node?.data.imageSrc ? <CanvasPreview src={node.data.imageSrc} alt={asset.name} className="h-full w-full object-contain" /> : <Film size={24} className="text-zinc-600" />}</div>
              <h4 className="text-sm">{asset.name}</h4><p className="my-2 line-clamp-2 text-xs leading-5 text-zinc-500">{asset.context}</p><button disabled={locked} className={button} onClick={() => createAsset(asset)}>{node ? '打开图片节点' : '创建图片节点'}</button>
            </div>; })}</div>{!assets.some(asset => asset.kind === kind) && <p className="text-xs text-zinc-500">暂无{kind === 'characters' ? '角色' : kind === 'scene' ? '场景' : '道具'}信息</p>}
          </section>)}</div>}
        </div>
        <footer className="flex shrink-0 items-center gap-3 border-t border-white/10 bg-[#1c1c1c] px-5 py-4 text-xs">
          {tab !== 1 && <button disabled={locked || shots.length >= limits.maxShots} className={`${button} flex items-center gap-2`} onClick={() => save([...shots, { title: '新镜头', ...Object.fromEntries(shotFields.map(([key]) => [key, key === 'duration' ? `${Math.min(15, Math.max(1, limits.duration - total))}秒` : ''])) } as StoryboardShot])}><Plus size={14} />添加镜头</button>}
          <p role="status" className={`flex-1 ${!active && problem ? 'text-amber-300' : 'text-zinc-500'}`}>{active ? `${status} · 已收到 ${shots.length} 个镜头` : problem || `${shots.length} 个镜头，共 ${total} 秒`}{!active && task?.error ? ` · ${task.error}` : ''}</p>
          {retryable && onContinue && <button disabled={continuing || !canContinue} className={button} onClick={onContinue}>继续未完成步骤</button>}{onConfigure && <button className={button} onClick={() => { setOpen(false); onConfigure(); }}>创作设置</button>}{data.scriptOutputSource && <button className={button} onClick={() => focus(data.scriptOutputSource!)}>回到脚本设置</button>}<button className={button} disabled={!text} onClick={download}>下载</button>
        </footer>
      </DialogContent>
    </Dialog>
  </>;
}
