"use client";
import { useState } from 'react';
import { CanvasPreview } from '@/components/ui/canvas-preview';
import type { NodeData } from '@/types';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useUpstreamNodes } from '@/hooks/useUpstreamNodes';
import { promptSegments } from '@/lib/canvas/prompt';
import { buildScriptInput, scriptPresets } from '@/lib/script/inputs';
import type { ScriptTask } from '@/lib/script/types';
import { PromptEditor } from './PromptEditor';

export function ScriptInputs({ id, data, expanded, task }: { id: string; data: NodeData; expanded: boolean; task?: ScriptTask }) {
  const update = useCanvasStore(s => s.updateNodeData);
  const upstream = useUpstreamNodes(id);
  const [instructions, setInstructions] = useState(false);
  const preset = scriptPresets.find(p => p.id === data.scriptPreset) || scriptPresets[0];
  // Primitive subscription also catches changes to recursively referenced text without subscribing to positions.
  const snapshot = useCanvasStore(state => {
    try { return JSON.stringify(buildScriptInput(id, state).references); } catch (error) { return error instanceof Error ? error.message : '参考不可用'; }
  });
  let references: ReturnType<typeof buildScriptInput>['references'] = [];
  let referenceError = '';
  try { references = JSON.parse(snapshot); } catch { referenceError = snapshot; }
  const changed = task && JSON.stringify(task.input.references) !== snapshot;
  return <>
    <div role="group" aria-label="创作指令" className="mb-3 grid grid-cols-2 gap-2">
      {scriptPresets.map(item => <button key={item.id} type="button" aria-pressed={preset.id === item.id}
        onClick={() => update(id,{scriptPreset:item.id,scriptInstruction:item.instruction})}
        className={`rounded-xl border p-3 text-left transition-colors ${preset.id === item.id ? 'border-violet-400/60 bg-violet-500/15' : 'border-white/5 bg-white/[0.03] hover:bg-white/[0.07]'}`}>
        <span className={`block text-xs font-medium ${preset.id === item.id ? 'text-violet-200' : 'text-zinc-300'}`}>{item.label}</span>
        <span className="mt-1 block text-[11px] leading-5 text-zinc-500">{item.description}</span>
      </button>)}
    </div>
    <button type="button" aria-expanded={instructions} onClick={() => setInstructions(!instructions)} className="mb-3 text-xs text-zinc-400 hover:text-zinc-200">{instructions ? '收起指令' : '查看／调整指令'}{data.scriptInstruction && data.scriptInstruction !== preset.instruction ? ' · 已自定义' : ''}</button>
    {instructions && <label className="mb-3 block text-xs text-zinc-400">本节点任务指令（切换任务将使用新预设指令）
      <textarea aria-label="任务指令" value={data.scriptInstruction ?? preset.instruction} onChange={e => update(id, { scriptInstruction: e.target.value })} className="mt-1 max-h-64 min-h-24 w-full resize-y rounded-xl bg-black/20 p-3 text-sm leading-6 text-zinc-200 outline-none" />
    </label>}
    <details className="mb-3" open><summary className="cursor-pointer text-xs text-zinc-400">参考内容 · {references.length} 项 · 全部参与生成</summary>
      <div className="mt-2 flex max-h-36 gap-2 overflow-auto">{references.map((ref, index) => <div key={`${ref.nodeId}-${index}`} title={ref.type === 'text' ? ref.content : ref.label} className="w-32 shrink-0 rounded-xl border border-white/10 bg-black/20 p-2">
        {ref.type === 'image' ? <CanvasPreview compact src={ref.content} alt={ref.label} className="h-14 w-full rounded object-contain" /> : <p className="line-clamp-3 h-14 whitespace-pre-wrap break-words text-[10px] text-zinc-400">{ref.content || '文本为空'}</p>}
        <p className="mt-1 truncate text-[11px]">{index + 1}. {ref.label}</p>
      </div>)}</div>
      {!references.length && !referenceError && <p className="mt-1 text-xs text-zinc-500">连接文本或图片，在要求中输入 @ 引用节点。</p>}
    </details>
    {referenceError && <p role="alert" className="mb-2 text-xs text-red-300">{referenceError}</p>}
    {changed && <p role="status" className="mb-2 text-xs text-amber-300">参考已更新；本次生成使用原输入，下次生成使用最新内容。</p>}
    <div className={expanded ? 'min-h-32 flex-1 overflow-auto [&_[role=textbox]]:max-h-none [&_[role=textbox]]:min-h-64' : 'min-h-32 [&_[role=textbox]]:max-h-52'}>
      <PromptEditor value={promptSegments(data.prompt)} upstream={upstream} placeholder={references.length ? '已有参考，可直接生成；补充要求选填…' : '描述创作要求，或连接参考文本、图片…'} onChange={prompt => update(id, { prompt })} />
    </div>
  </>;
}
