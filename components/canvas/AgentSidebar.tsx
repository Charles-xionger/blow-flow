'use client';
import { ArrowDown, ArrowUp, Check, ChevronDown, ImagePlus, Loader2, Scan, Square, X } from 'lucide-react';
import { AgentMessage } from './AgentMessage';
import { AgentPanelFrame } from './AgentPanelFrame';
import { AgentNodePicker } from './AgentNodePicker';
import styles from './AgentSidebar.module.css';
import { BrandMark } from '@/components/ui/brand-mark';
import { uploadAgentReference } from '@/lib/agent/upload';
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
  return <><button aria-label="创作助手" disabled={opening} onClick={()=>void toggle()} aria-expanded={open} className={styles.launcher}><BrandMark size={20} />创作助手</button>{openError&&<p role="alert" className="fixed right-4 top-32 z-180 bg-background p-2">{openError}</p>}{open && projectId && <AgentConversation key={projectId} projectId={projectId} close={()=>setOpen(false)}/>}</>;
}
function AgentConversation({projectId,close}:{projectId:string;close:()=>void}){
  const [snapshot,setSnapshot]=useState<Snapshot>({tasks:[],messages:[],models:[]});
  const [uploading,setUploading]=useState(false);
  const [pickingNodes,setPickingNodes]=useState(false);
  const [away,setAway]=useState(false);
  const list=useRef<HTMLDivElement>(null);
  const input=useRef<HTMLTextAreaElement>(null);
  const followLatest=useRef(true);
  function toBottom(){if(list.current)list.current.scrollTop=list.current.scrollHeight;followLatest.current=true;setAway(false);}
  useEffect(()=>{if(followLatest.current && list.current)list.current.scrollTop=list.current.scrollHeight;},[snapshot]);

  const [text,setText]=useState('');const [model,setModel]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [references,setReferences]=useState<AgentReference[]>([]);
  const canSend=!busy&&!uploading&&!!text.trim()&&snapshot.models.some(m=>m.available);
  const task=snapshot.tasks.at(-1);const waiting=task?.status==='waiting' && task.question && !task.question.answer && !task.question.cancelled;
  const pendingRequest=useRef<{signature:string;requestId:string}|null>(null);
  const endpoint=`/api/agent/${encodeURIComponent(projectId)}`;
  const [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function refresh() {
      if (!active || inFlight || document.visibilityState === 'hidden') return;
      clearTimeout(timer);
      inFlight = true;
      let delay = 5000;
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), cache: 'no-store' });
        if (!response.ok) throw new Error('加载失败');
        const data: Snapshot = await response.json();
        if (!active) return;
        setSnapshot(data);
        const running = data.tasks.some(task => task.status === 'queued' || task.status === 'running' || task.status === 'waiting' && task.awaitingGeneration) ||
          data.generations?.some(batch => batch.items.some(({ task }) => task &&
            (['queued', 'submitting', 'running'].includes(task.status) ||
              task.status === 'succeeded' && ['pending', 'saving'].includes(task.saveStatus))));
        delay = running ? 1000 : 30_000;
      } catch {
        if (active) setError('无法同步助手，请检查连接。');
      } finally {
        inFlight = false;
        // Schedule after completion so slow responses cannot pile up.
        if (active) timer = setTimeout(() => void refresh(), delay);
      }
    }
    const wake = () => { void refresh(); };
    void refresh();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [endpoint, refreshVersion]);
  async function send(action:string,value=text){
    setBusy(true);setError('');
    try {await canvasAutosave.flush();const signature=JSON.stringify({action,value,model,references,questionId:task?.question?.id});if(pendingRequest.current?.signature!==signature)pendingRequest.current={signature,requestId:crypto.randomUUID()};const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,requestId:pendingRequest.current.requestId,text:value,modelId:model||snapshot.models.find(m=>m.available)?.id,references,questionId:task?.question?.id})});if(!response.ok)throw new Error((await response.json()).error);pendingRequest.current=null;setText('');setReferences([]);followLatest.current=true;setRefreshVersion(version=>version+1);}
    catch(e){setError(e instanceof Error?e.message:'发送失败');}finally{setBusy(false);}
  }
  function referenceSelection(){const nodes=useCanvasStore.getState().nodes.filter(n=>n.selected);if(!nodes.length){setPickingNodes(true);return;}setReferences(old=>[...old,...nodes.filter(n=>!old.some(r=>r.nodeId===n.id)).map(n=>({nodeId:n.id,name:String(n.data.customTitle||n.data.label||n.type)}))].slice(0,8));}
  async function upload(file?:File){
    if(!file || references.length>=8)return;
    setUploading(true);setError('');
    try{const reference=await uploadAgentReference(file);setReferences(old=>[...old,reference].slice(0,8));}
    catch(error){setError(error instanceof Error?error.message:'参考图上传失败，请重试。');}
    finally{setUploading(false);}
  }
  return <AgentPanelFrame close={close}>
    <div className={styles.context}><span><Scan size={13}/> 当前画布</span><span role="status"><i data-active={task?.status==='running'||task?.status==='queued'}/>{task?task.status==='interrupted'?'待继续':task.awaitingGeneration?'等待生成结果':task.question?.scope?.kind==='generation'&&waiting?'等待批准':statusText[task.status]:'可以开始创作'}</span></div>
    <div ref={list} className={styles.messages} aria-label="助手消息" onScroll={()=>{const el=list.current!;const isAway=el.scrollHeight-el.scrollTop-el.clientHeight>64;followLatest.current=!isAway;setAway(isAway);}}>
      {snapshot.messages.length===0&&<div className={styles.empty}>
        <span className={styles.welcomeIcon}><BrandMark size={40}/></span><span className={styles.eyebrow}>你的画布创作伙伴</span><h2>今天，想创作什么？</h2><p>聊聊你的想法，或引用画布中的素材。<br/>我们可以从一个故事、一组分镜开始。</p>
        <div className={styles.starters}>{[{title:'写一个故事',detail:'把灵感展开成完整剧本',prompt:'帮我写一个故事剧本：'},{title:'拆解成分镜',detail:'将故事转化为镜头与画面',prompt:'帮我把画布中的剧本拆解成分镜。'},{title:'构思一组画面',detail:'一起探索主题、风格与构图',prompt:'帮我构思一组画面的主题、风格和构图：'}].map(item=><button key={item.title} onClick={()=>{setText(item.prompt);input.current?.focus();}}><span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowUp size={15}/></button>)}</div>
      </div>}
      {snapshot.messages.map(message=><AgentMessage key={message.id} message={message}/>)}
      {!!task?.steps.length&&<details className={styles.steps}><summary><Check size={14}/><span>执行步骤 · {task.steps.filter(s=>s.status==='completed').length}/{task.steps.length}</span><ChevronDown size={14}/></summary><div>{task.steps.map(s=><p key={s.id}>{s.status==='running'?<Loader2 size={13} className="animate-spin"/>:s.status==='failed'?<X size={13}/>:<Check size={13}/>}<span>{s.name}</span><small>{statusText[s.status]}</small></p>)}</div></details>}
      {snapshot.generations?.filter(batch=>batch.taskId===task?.id).map(batch=><div key={batch.id} aria-label="生成进度" className={styles.progress}>{batch.items.map((item,index)=><p key={index}>{item.nodeId}：{item.task ? ({queued:'等待生成',submitting:'提交中',running:'生成中',succeeded:item.task.saveStatus==='saved'?'已保存':item.task.saveStatus==='failed'?'保存失败，可要求重试保存':'保存中',failed:'生成失败',uncertain:'提交结果待核实，请勿重复生成',cancelled:'已取消，重新生成需要确认',timed_out:'查询超时'}[item.task.status]) : batch.status==='pending'?'等待确认':'已取消'}{item.task?.error ? ` · ${item.task.error}` : ''}{item.note ? ` · ${item.note}` : ''}</p>)}</div>)}{task?.error&&<p role="alert" className={styles.error}>{task.error}</p>}
    {waiting&&<div className={styles.question}><span className={styles.eyebrow}>需要你的确认</span><p>{task.question!.text}</p>{task.question!.scope?.kind==='generation' && <ol aria-label="生成方案" className="max-h-52 overflow-y-auto space-y-2 text-sm">{task.question!.scope.items.map((item,index)=><li key={index} className="rounded border p-2"><strong>{index+1}. {item.modelId} → {item.nodeId}</strong>{item.newNode&&<p>目标已有结果，将新建节点，原结果保留</p>}<p className="whitespace-pre-wrap break-words">{item.input.prompt}</p><p>数量：1 · {item.specification ?? `${item.input.width} × ${item.input.height}`}{item.input.duration ? ` · ${item.input.duration} 秒` : ''}{item.input.instanceType ? ' · 高性能渠道' : ''}</p>{item.input.references?.map((ref,i)=><a key={i} href={ref.url} target="_blank" rel="noreferrer" className="block truncate underline">参考 {i+1} · {ref.kind}{ref.kind==='video' ? ref.useAudio ? '（使用原声）' : '（无原声）' : ''}</a>)}</li>)}</ol>}{task.question!.options.map(option=><button key={option} disabled={busy||uploading} onClick={()=>void send('answer',option)} className={styles.option}>{option}</button>)}<p className="text-xs">也可输入回答或修改要求；停止会取消本次等待。</p></div>}
    </div>
    {away&&<button className={styles.jump} onClick={toBottom}><ArrowDown size={13}/>回到最新消息</button>}
    <footer className={styles.footer}>
      {pickingNodes&&<AgentNodePicker references={references} onChange={setReferences} close={()=>setPickingNodes(false)}/>}
      {task?.status==='interrupted'&&<button disabled={busy||uploading} onClick={()=>void send('continue','')} className={styles.resume}>继续创作 <ArrowUp size={14}/></button>}
      {error&&<p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.composer}>
        {references.length>0&&<div className={styles.references}>{references.map((r,i)=><button key={i} aria-label={`参考：${r.name||r.nodeId} ×`} title="移除参考" onClick={()=>setReferences(old=>old.filter((_,index)=>index!==i))}><ImagePlus size={12}/><span>参考：{r.name||r.nodeId}</span><X size={12}/></button>)}</div>}
        {uploading&&<p role="status" className={styles.hint}>正在保存参考图…</p>}
        <textarea ref={input} aria-label="创作要求" placeholder={waiting?'回答或修改要求…':'描述你的创作想法，或添加参考素材…'} rows={3} value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();if(canSend)void send(waiting?'answer':'send');}}}/>
        <div className={styles.referenceTools}><button aria-expanded={pickingNodes} disabled={busy||uploading} onClick={()=>setPickingNodes(!pickingNodes)}><Scan size={14}/>选择节点</button><button disabled={busy||uploading||references.length>=8} onClick={referenceSelection}><Scan size={14}/>引用选中节点</button><label aria-disabled={busy||uploading||references.length>=8}><ImagePlus size={14}/>添加参考图<input aria-label="添加参考图" type="file" disabled={busy||uploading||references.length>=8} accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e=>{void upload(e.target.files?.[0]);e.target.value='';}}/></label></div>
        <div className={styles.composerBottom}>
          <select aria-label="助手模型" value={model||snapshot.models.find(m=>m.available)?.id||''} onChange={e=>setModel(e.target.value)}><option value="" disabled>选择可用模型</option>{snapshot.models.map(m=><option key={m.id} value={m.id} disabled={!m.available}>{m.name}{!m.available?'（未配置）':''}</option>)}</select>
          <div className={styles.actions}>{task&&['queued','running','waiting','interrupted'].includes(task.status)&&<button aria-label="停止" title="停止" disabled={busy} onClick={()=>void send('stop')}><Square size={14}/></button>}<button aria-label={waiting?'回答 / 修改':'发送'} title={waiting?'回答 / 修改':'发送'} disabled={!canSend} onClick={()=>void send(waiting?'answer':'send')} className={styles.send}>{busy?<Loader2 size={17} className="animate-spin"/>:<ArrowUp size={18}/>}</button></div>
        </div>
      </div>
      <p className={styles.keyboardHint}>Enter 发送 · Shift + Enter 换行</p>
    </footer>
  </AgentPanelFrame>;
}
