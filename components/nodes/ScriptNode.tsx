'use client';
import { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { Maximize2, Minimize2, Feather, ArrowUp } from 'lucide-react';
import type { Node, NodeProps } from '@xyflow/react';
import type { NodeData } from '@/types';
import { NodeShell, NodeToolbarButton } from './NodeShell';
import { nodeContentEqual } from '@/lib/canvas/node-content';
import { getModelsByCategory } from '@/lib/model-registry';
import { promptText } from '@/lib/canvas/prompt';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useScriptTask } from '@/hooks/useScriptTask';
import { scriptActive, scriptStatusLabel } from '@/lib/script/types';

const Particles = dynamic(() => import('./shared/ScriptParticles'),{ ssr:false });
const models = getModelsByCategory('TEXT').filter(model => model.provider === 'ark' || model.provider === 'gemini');
function ScriptNode(props: NodeProps<Node<NodeData>>) {
  const { id,data } = props;
  const update = useCanvasStore(s => s.updateNodeData);
  const { task,submitting,polling,error,start } = useScriptTask(id);
  const [expanded,setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false); } };
    window.addEventListener('keydown',close,true);
    return () => window.removeEventListener('keydown',close,true);
  },[expanded]);
  const requirements = promptText(data.prompt);
  const model = models.find(model => model.id === data.model || model.name === data.model)?.id || models[0].id;
  const active = scriptActive(task?.status);
  const text = task?.text || '';
  const consoleContent = <section aria-label="脚本节点控制台" className={`nokey nodrag nopan nowheel z-70 cursor-auto select-text rounded-[22px] border border-white/10 bg-[#242426] p-4 text-zinc-200 shadow-2xl ${expanded ? 'fixed inset-4 z-[200] flex flex-col' : 'absolute left-1/2 top-full mt-3 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2'}`}>
      <div className="mb-3 flex items-center justify-between text-xs text-zinc-400"><span>脚本创作 · 自由创作</span>
        <button type="button" aria-label={expanded ? '收起输入区' : '展开输入区'} onClick={() => setExpanded(!expanded)} className="rounded-lg p-1.5 hover:bg-white/10">{expanded ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</button>
      </div>
      <textarea aria-label="创作要求" value={requirements} placeholder="描述你想创作的内容、故事方向和表达风格…" onChange={event => update(id,{ prompt:[{ text:event.target.value }] })}
        className={`w-full resize-none rounded-xl bg-transparent p-1 text-sm leading-7 outline-none placeholder:text-zinc-500 ${expanded ? 'min-h-40 flex-1' : 'h-36'}`} />
      <div className="mt-3 flex items-center gap-2">
        <select aria-label="语言模型" value={model} onChange={event => update(id,{ model:event.target.value })} className="min-w-0 max-w-[70%] rounded-xl bg-[#303033] px-3 py-2 text-xs outline-none">
          {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select><div className="flex-1"/>
        <button type="button" disabled={active || submitting || !requirements.trim()} onClick={() => void start({ model,requirements,instruction:'',preset:'free',references:[] })}
          className="flex items-center gap-2 rounded-xl bg-violet-500 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"><ArrowUp size={15}/>{submitting ? '提交中' : active ? '生成中' : data.pendingScript ? '恢复原请求' : task ? '重新生成' : '生成'}</button>
      </div>
      {(error || task?.error) && <p role="alert" className="mt-3 text-xs text-red-300">{error || task?.error}</p>}
      {polling && <p role="status" className="mt-2 text-xs text-amber-300">实时连接暂不可用，每 10 秒同步已保存正文。</p>}
    </section>;
  return <NodeShell {...props} toolbar={<NodeToolbarButton label="展开创作输入" icon={Maximize2} onClick={() => setExpanded(true)} />} console={expanded ? (!props.dragging ? createPortal(consoleContent, document.body) : null) : consoleContent}>
    <div className="flex h-full flex-col p-4">
      <div className={`relative flex shrink-0 items-center justify-center gap-2 text-xs text-violet-200 ${active && !text ? 'flex-1' : 'h-10'}`}>
        {active ? <Particles/> : <Feather size={16}/>}
        <span role="status" className="relative rounded-lg bg-[#1a1a1a]/70 px-2 py-1">{task ? scriptStatusLabel[task.status] : '脚本创作'}</span>
      </div>
      {text ? <div className="nodrag nopan nowheel min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words text-sm leading-7 text-zinc-200">{text}</div> : !active ? <p className="m-auto text-center text-xs leading-6 text-zinc-500">填写创作要求，生成剧本或分镜文稿<br/>结果保留在脚本中，供你继续创作</p> : null}
      {(task?.error || error) && <p role="alert" className="mt-2 shrink-0 text-xs text-red-300">{task?.error || error}</p>}
    </div>
  </NodeShell>;
}
export default memo(ScriptNode,nodeContentEqual);
