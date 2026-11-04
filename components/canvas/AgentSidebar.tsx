'use client';
import { useEffect, useState, useRef } from 'react';
import { useCanvasStore, canvasAutosave } from '@/store/useCanvasStore';
import { useRouter, useSearchParams } from 'next/navigation';
import { createWorkspaceProject } from '@/lib/workspace/client';
import type { AgentSnapshot, AgentReference } from '@/lib/agent/types';
type Snapshot=AgentSnapshot & {models:{id:string;name:string;available:boolean}[]};
const statusText:Record<string,string>={queued:'等待执行',running:'执行中',waiting:'等待回答',interrupted:'待继续',completed:'完成',stopped:'已停止',failed:'失败'};
export function AgentSidebar(){
  const projectId=useCanvasStore(s=>s.currentWorkflowId);
  const router=useRouter();
  const search=useSearchParams();
  const [open,setOpen]=useState(search.get('assistant')==='1');
  const [opening,setOpening]=useState(false);
  const [openError,setOpenError]=useState('');
  async function toggle(){if(open){setOpen(false);return;}setOpening(true);setOpenError('');try{await canvasAutosave.flush();if(!useCanvasStore.getState().currentWorkflowId){const id=await createWorkspaceProject(null);router.replace(`/canvas?project=${encodeURIComponent(id)}&assistant=1`);return;}setOpen(true);}catch{setOpenError('无法打开助手，请等待画布同步后重试。');}finally{setOpening(false);}}
  return <><button aria-label="创作助手" disabled={opening} onClick={()=>void toggle()} className="fixed right-4 top-20 z-180 rounded-xl border bg-background px-4 py-2 shadow">创作助手</button>{openError&&<p role="alert" className="fixed right-4 top-32 z-180 bg-background p-2">{openError}</p>}{open && projectId && <AgentConversation key={projectId} projectId={projectId} close={()=>setOpen(false)}/>}</>;
}
function AgentConversation({projectId,close}:{projectId:string;close:()=>void}){
  const [snapshot,setSnapshot]=useState<Snapshot>({tasks:[],messages:[],models:[]});
  const [text,setText]=useState('');const [model,setModel]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [references,setReferences]=useState<AgentReference[]>([]);
  const task=snapshot.tasks.at(-1);const waiting=task?.status==='waiting' && task.question && !task.question.answer && !task.question.cancelled;
  const pendingRequest=useRef<{signature:string;requestId:string}|null>(null);
  const endpoint=`/api/agent/${encodeURIComponent(projectId)}`;
  useEffect(()=>{let active=true;const controller=new AbortController();async function refresh(){try{const response=await fetch(endpoint,{signal:controller.signal,cache:'no-store'});if(!response.ok)throw new Error('加载失败');const data:Snapshot=await response.json();if(active)setSnapshot(data);}catch{if(active)setError('无法同步助手，请检查连接。');}}
    void refresh();const interval=setInterval(()=>void refresh(),1000);return()=>{active=false;controller.abort();clearInterval(interval);};},[endpoint]);
  async function send(action:string,value=text){
    setBusy(true);setError('');
    try {await canvasAutosave.flush();const signature=JSON.stringify({action,value,model,references,questionId:task?.question?.id});if(pendingRequest.current?.signature!==signature)pendingRequest.current={signature,requestId:crypto.randomUUID()};const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,requestId:pendingRequest.current.requestId,text:value,modelId:model||snapshot.models.find(m=>m.available)?.id,references,questionId:task?.question?.id})});if(!response.ok)throw new Error((await response.json()).error);pendingRequest.current=null;setText('');setReferences([]);const updated=await fetch(endpoint,{cache:'no-store'});if(updated.ok)setSnapshot(await updated.json());}
    catch(e){setError(e instanceof Error?e.message:'发送失败');}finally{setBusy(false);}
  }
  function referenceSelection(){const nodes=useCanvasStore.getState().nodes.filter(n=>n.selected);setReferences(old=>[...old,...nodes.filter(n=>!old.some(r=>r.nodeId===n.id)).map(n=>({nodeId:n.id,name:String(n.data.label??n.type)}))].slice(0,8));}
  async function upload(file?:File){if(!file)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>10_000_000){setError('请选择不超过 10 MB 的 PNG、JPEG 或 WebP 图片。');return;}const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});setReferences(old=>[...old,{data,mimeType:file.type,name:file.name}].slice(0,8));}
  return <aside aria-label="创作助手对话" className="fixed right-4 top-32 bottom-4 z-180 flex w-[360px] max-w-[calc(100vw-32px)] flex-col rounded-xl border bg-background p-4 shadow-xl">
    <div className="flex justify-between"><strong>创作助手</strong><button aria-label="关闭创作助手" onClick={close}>关闭</button></div>
    <select aria-label="助手模型" className="my-2 rounded border p-2" value={model||snapshot.models.find(m=>m.available)?.id||''} onChange={e=>setModel(e.target.value)}><option value="" disabled>选择可用模型</option>{snapshot.models.map(m=><option key={m.id} value={m.id} disabled={!m.available}>{m.name}{!m.available?'（未配置）':''}</option>)}</select>
    <p role="status">{task?task.status==='interrupted'?'待继续':task.awaitingGeneration?'等待生成结果':task.question?.scope?.kind==='generation'&&waiting?'等待批准':statusText[task.status]:'可以开始创作'}</p>
    <div className="my-3 flex-1 space-y-3 overflow-y-auto" aria-label="助手消息">{snapshot.messages.map(m=><article key={m.id} className="rounded border p-2"><strong>{m.role==='user'?'你':'助手'}</strong><p className="whitespace-pre-wrap break-words text-sm">{m.text}</p>{m.references.map((r,i)=><span className="block text-xs" key={i}>参考：{r.name||r.nodeId||'图片'}</span>)}</article>)}{task?.steps.map(s=><p key={s.id} className="text-xs opacity-70">{s.name} · {s.status}</p>)}{snapshot.generations?.filter(batch=>batch.taskId===task?.id).map(batch=><div key={batch.id} aria-label="生成进度" className="text-xs">{batch.items.map((item,index)=><p key={index}>{item.nodeId}：{item.task ? ({queued:'等待生成',submitting:'提交中',running:'生成中',succeeded:item.task.saveStatus==='saved'?'已保存':item.task.saveStatus==='failed'?'保存失败，可要求重试保存':'保存中',failed:'生成失败',uncertain:'提交结果待核实，请勿重复生成',cancelled:'已取消，重新生成需要确认',timed_out:'查询超时'}[item.task.status]) : batch.status==='pending'?'等待确认':'已取消'}{item.task?.error ? ` · ${item.task.error}` : ''}{item.note ? ` · ${item.note}` : ''}</p>)}</div>)}{task?.error&&<p role="alert">{task.error}</p>}</div>
    {waiting&&<div className="mb-2 rounded border p-2"><p>{task.question!.text}</p>{task.question!.scope?.kind==='generation' && <ol aria-label="生成方案" className="max-h-52 overflow-y-auto space-y-2 text-sm">{task.question!.scope.items.map((item,index)=><li key={index} className="rounded border p-2"><strong>{index+1}. {item.modelId} → {item.nodeId}</strong><p className="whitespace-pre-wrap break-words">{item.input.prompt}</p><p>数量：1 · {item.specification ?? `${item.input.width} × ${item.input.height}`}{item.input.duration ? ` · ${item.input.duration} 秒` : ''}{item.input.instanceType ? ' · 高性能渠道' : ''}</p>{item.input.references?.map((ref,i)=><a key={i} href={ref.url} target="_blank" rel="noreferrer" className="block truncate underline">参考 {i+1} · {ref.kind}{ref.kind==='video' ? ref.useAudio ? '（使用原声）' : '（无原声）' : ''}</a>)}</li>)}</ol>}{task.question!.options.map(option=><button key={option} disabled={busy} onClick={()=>void send('answer',option)} className="m-1 rounded border px-2">{option}</button>)}<p className="text-xs">也可输入回答或修改要求；停止会取消本次等待。</p></div>}
    <div className="flex gap-2 text-xs"><button onClick={referenceSelection}>引用选中节点</button><label className="cursor-pointer">添加参考图<input aria-label="添加参考图" type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e=>void upload(e.target.files?.[0])}/></label></div>
    {references.map((r,i)=><button key={i} className="text-left text-xs" onClick={()=>setReferences(old=>old.filter((_,index)=>index!==i))}>参考：{r.name||r.nodeId} ×</button>)}
    <textarea aria-label="创作要求" placeholder={waiting?'回答或修改要求':'描述创作要求，运行时可补充'} className="my-2 min-h-20 rounded border p-2" value={text} onChange={e=>setText(e.target.value)}/>
    {error&&<p role="alert" className="text-sm text-red-500">{error}</p>}
    {task?.status==='interrupted'&&<button disabled={busy} onClick={()=>void send('continue','')} className="rounded border px-3 py-2">继续创作</button>}
    <div className="flex justify-between"><button disabled={busy||!text.trim()||!snapshot.models.some(m=>m.available)} onClick={()=>void send(waiting?'answer':'send')} className="rounded border px-3 py-2">{waiting?'回答 / 修改':'发送'}</button><button disabled={busy||!task||!['queued','running','waiting','interrupted'].includes(task.status)} onClick={()=>void send('stop')} className="rounded border px-3 py-2">停止</button></div>
  </aside>;
}
