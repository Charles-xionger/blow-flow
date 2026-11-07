"use client";
import { CanvasPreview } from '@/components/ui/canvas-preview';
import type { NodeData } from '@/types';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useUpstreamNodes } from '@/hooks/useUpstreamNodes';
import { promptSegments } from '@/lib/canvas/prompt';
import { buildScriptInput, scriptPresets } from '@/lib/script/inputs';
import { defaultStoryboardLimits, storyboardInstruction, storyboardLimitsProblem } from '@/lib/script/storyboard';
import type { ScriptTask } from '@/lib/script/types';
import { PromptEditor } from './PromptEditor';

export function ScriptInputs({ id, data, expanded, task }: { id: string; data: NodeData; expanded: boolean; task?: ScriptTask }) {
  const update = useCanvasStore(s => s.updateNodeData);
  const upstream = useUpstreamNodes(id);
  const preset = scriptPresets.find(p => p.id === data.scriptPreset) || scriptPresets[0];
  const board = preset.id === 'storyboard';
  const limits = data.storyboard ?? defaultStoryboardLimits;
  const limitsError = board ? storyboardLimitsProblem(limits) : undefined;
  const minimumShots = Math.ceil(limits.duration / 15);
  const custom = data.scriptInstruction !== undefined && data.scriptInstruction !== preset.instruction;
  // Subscribe to reference content, without rerendering on node movement.
  const snapshot = useCanvasStore(state => {
    try { return JSON.stringify(buildScriptInput(id, state).references); } catch (error) { return error instanceof Error ? error.message : '参考不可用'; }
  });
  let references: ReturnType<typeof buildScriptInput>['references'] = [];
  let referenceError = '';
  try { references = JSON.parse(snapshot); } catch { referenceError = snapshot; }
  const changed = task && JSON.stringify(task.input.references) !== snapshot;
  const select = (item: typeof scriptPresets[number]) => update(id, { scriptPreset: item.id, scriptInstruction: item.instruction });
  return <div className={`flex flex-col gap-3 ${expanded ? 'flex-1' : ''}`}>
    <div>
      <div role="group" aria-label="创作类型" className="grid grid-cols-3 gap-1 rounded-xl bg-black/15 p-1">
        {scriptPresets.filter(item => item.id !== 'extract').map(item => <button key={item.id} type="button" aria-pressed={preset.id === item.id} onClick={() => select(item)}
          className={`rounded-lg px-2 py-2.5 text-xs font-medium transition-colors ${preset.id === item.id ? 'bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/40' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}>{item.label}</button>)}
      </div>
      <p className="mt-2 px-1 text-[11px] leading-5 text-zinc-500">{preset.description}</p>
      {preset.id === 'extract' && <div className="mt-2 flex items-center justify-between rounded-lg bg-white/5 p-2 text-xs text-zinc-400"><span>当前保留旧版素材提取指令</span><button type="button" className="text-violet-300" onClick={() => select(scriptPresets[2])}>切换分镜与资产</button></div>}
    </div>

    <details className="rounded-xl border border-white/10 px-3 py-2.5">
      <summary className="cursor-pointer text-xs text-zinc-400">参考内容 <span className="ml-1 text-zinc-200">{references.length} 项</span><span className="ml-2 text-[11px] text-zinc-500">全部参与生成</span></summary>
      <div className="mt-2 flex max-h-28 gap-2 overflow-auto">{references.map((ref, index) => <div key={`${ref.nodeId}-${index}`} title={ref.type === 'text' ? ref.content : ref.label} className="w-28 shrink-0 rounded-lg bg-black/20 p-2">
        {ref.type === 'image' ? <CanvasPreview compact src={ref.content} alt={ref.label} className="h-12 w-full rounded object-contain" /> : <p className="line-clamp-2 h-10 whitespace-pre-wrap break-words text-[10px] text-zinc-400">{ref.content || '文本为空'}</p>}
        <p className="mt-1 truncate text-[11px]">{index + 1}. {ref.label}</p>
      </div>)}</div>
      {!references.length && !referenceError && <p className="mt-1 text-xs text-zinc-500">连接文本或图片，也可以直接填写创作要求。</p>}
    </details>
    {referenceError && <p role="alert" className="text-xs text-red-300">{referenceError}</p>}
    {changed && <p role="status" className="text-[11px] text-amber-300">参考已更新，下次生成将使用最新内容。</p>}

    <div className={`rounded-xl border border-white/10 bg-black/10 p-3 ${expanded ? 'flex min-h-40 flex-1 flex-col' : ''}`}>
      <div className="mb-2 flex items-center justify-between text-xs text-zinc-300"><span>{board ? '创作要求' : '创作内容'}</span><span className="text-[10px] text-zinc-500">{references.length ? '补充要求选填' : '输入 @ 引用参考节点'}</span></div>
      <div className={expanded ? 'flex-1 [&_[role=textbox]]:max-h-none [&_[role=textbox]]:min-h-32' : '[&_[role=textbox]]:min-h-20 [&_[role=textbox]]:max-h-40'}>
        <PromptEditor value={promptSegments(data.prompt)} upstream={upstream} placeholder={board ? '例如：温暖治愈的风格，突出人物转变，减少对白…' : '写下故事想法或补充要求…'} onChange={prompt => update(id, { prompt })} />
      </div>
    </div>

    {board && <div className="rounded-xl border border-white/10 p-3">
      <div className="mb-3 flex items-center justify-between"><span className="text-xs text-zinc-300">分镜配置</span><span className="text-[10px] text-zinc-500">每镜 ≤15 秒</span></div>
      <div className="flex gap-3 text-xs text-zinc-400">
        <label className="min-w-0 flex-1">总时长（秒）<input aria-label="分镜总时长" type="number" min={5} max={600} value={limits.duration} onChange={e => update(id, { storyboard: { ...limits, duration: Number(e.target.value) } })} className="mt-2 w-full rounded-lg bg-white/5 p-2 text-zinc-200 outline-none focus:ring-1 focus:ring-violet-400/50" /></label>
        <label className="min-w-0 flex-1">最多镜头数<input aria-label="最多镜头数" aria-invalid={!!limitsError} type="number" min={1} max={40} value={limits.maxShots} onChange={e => update(id, { storyboard: { ...limits, maxShots: Number(e.target.value) } })} className="mt-2 w-full rounded-lg bg-white/5 p-2 text-zinc-200 outline-none focus:ring-1 focus:ring-violet-400/50" /></label>
      </div>
      <div className="mt-2 flex items-center gap-2">{[30, 60, 120].map(duration => <button type="button" key={duration} onClick={() => update(id, { storyboard: { duration, maxShots: duration === 60 ? 5 : Math.ceil(duration / 15) } })} className="rounded-md bg-white/5 px-2 py-1 text-[10px] text-zinc-400 hover:bg-white/10">{duration} 秒</button>)}</div>
      {limitsError ? <div className="mt-2 rounded-lg bg-amber-500/10 p-2 text-[11px] leading-5 text-amber-200"><p role="alert">{limitsError}</p>
        {Number.isInteger(limits.duration) && limits.duration >= 5 && limits.duration <= 600 && limits.maxShots < minimumShots && <button type="button" className="mt-1 underline underline-offset-4" onClick={() => update(id, { storyboard: { ...limits, maxShots: minimumShots } })}>调整为最多 {minimumShots} 镜</button>}
      </div> : <p className="mt-2 text-[11px] text-zinc-500">按 {minimumShots}–{limits.maxShots} 镜规划，共 {limits.duration} 秒；同时整理角色、场景和道具。</p>}
      <p className="mt-2 text-[10px] text-zinc-600">输出一个分镜节点，资产图片按需创建，不自动生图。</p>
    </div>}

    <details className="rounded-xl border border-white/10 px-3 py-2.5">
      <summary className="cursor-pointer text-xs text-zinc-400">指令设置<span className="ml-2 text-[10px] text-zinc-500">{custom ? '已自定义' : '使用默认指令'}</span></summary>
      <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-500"><span>任务指令 · 切换创作类型会恢复对应默认值</span>{custom && <button type="button" className="text-violet-300" onClick={() => update(id, { scriptInstruction: preset.instruction })}>恢复默认</button>}</div>
      <textarea aria-label="任务指令" value={data.scriptInstruction ?? preset.instruction} onChange={e => update(id, { scriptInstruction: e.target.value })} className="mt-2 max-h-56 min-h-24 w-full resize-y rounded-lg bg-black/20 p-3 text-xs leading-6 text-zinc-300 outline-none" />
      {board && <details className="mt-2"><summary className="cursor-pointer text-[11px] text-zinc-500">查看当前输出约束（随配置更新）</summary><p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-[11px] leading-5 text-zinc-500">{storyboardInstruction(limits)}</p></details>}
    </details>
  </div>;
}
