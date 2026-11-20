import { NextRequest, NextResponse } from 'next/server';
import { getAgentService } from '@/lib/agent/server';
import { publicAgentModels } from '@/lib/agent/config';
import { goCutoverEnabled, goMapped } from '@/lib/go-cutover';
export const runtime='nodejs';
type Context={params:Promise<{projectId:string}>};
type GoTask = {id:string;status:string;stage:string;resultUrl?:string;failureCode?:string;attachmentNote?:string;percent?:number};
type GoSnapshot = { tasks: Array<{id:string;projectId:string;modelId:string;status:string;createdAt:string;legacyImported?:boolean;question?:{id:string;text:string;options:string[];scope?:{kind:string;items?:Array<{nodeId:string;modelId:string;input:{prompt:string;width:number;height:number;duration?:number;references?:{kind:string;url:string;useAudio?:boolean}[]};newNode?:boolean}>};answer?:string;cancelled?:boolean};steps?:Array<{callId:string;runId:string;name:string;arguments:Record<string,unknown>;result?:unknown;status:string;createdAt:string}>}>; messages:Array<{id:string;taskId:string;runId?:string;role:string;text:string;references:unknown[];createdAt:string}>; generationBatches?:Array<{id:string;taskId:string;status:string;items:Array<{nodeId:string;note?:string;task?:GoTask}>}>; legacyGenerationBatches?: Array<{id:string;taskId:string;status:string;items:Array<{request:{nodeId:string};note?:string}>}> };
function generationState(task:GoTask){const status=['completed','saving','save_failed','save_exhausted','save_unavailable'].includes(task.status)?'succeeded':task.status==='needs_review'?'uncertain':task.status==='wait_timeout'?'timed_out':task.status==='canceled'?'cancelled':task.status==='queued'||task.status==='submitting'||task.status==='running'?task.status:'failed';const saveStatus=task.status==='completed'?'saved':task.status==='saving'||task.status==='save_failed'?'saving':task.status==='save_exhausted'||task.status==='save_unavailable'?'failed':'pending';return {...task,status,saveStatus,artifacts:task.resultUrl?[task.resultUrl]:[],error:task.failureCode||null};}
function mapSnapshot(value:GoSnapshot) {
  return { tasks:value.tasks.map(task=>({ ...task,createdAt:Date.parse(task.createdAt),steps:(task.steps??[]).map(step=>({id:step.callId,runId:step.runId,name:step.name,args:step.arguments,result:step.result,status:step.status,createdAt:Date.parse(step.createdAt)})) })),messages:value.messages.map(message=>({...message,createdAt:Date.parse(message.createdAt)})),models:publicAgentModels(),generations:[...(value.generationBatches??[]).map(batch=>({...batch,items:batch.items.map(item=>({...item,task:item.task?generationState(item.task):undefined}))})),...(value.legacyGenerationBatches??[]).map(batch=>({id:batch.id,taskId:batch.taskId,status:'archived',items:batch.items.map(item=>({nodeId:item.request.nodeId,note:item.note??'历史生成记录，已归档'}))}))]};
}
export async function GET(_request:NextRequest,context:Context){
  if(goCutoverEnabled()){const {projectId}=await context.params;return goMapped<GoSnapshot>(_request,`/v1/agent/projects/${encodeURIComponent(projectId)}`,{},mapSnapshot,false);}
  try {const {projectId}=await context.params;return NextResponse.json({...getAgentService().snapshot(projectId),models:publicAgentModels()});}
  catch {return NextResponse.json({error:'无法读取创作助手或项目不存在'},{status:404});}
}
export async function POST(request:NextRequest,context:Context){
  if(goCutoverEnabled()){
    const {projectId}=await context.params;
    let body:Record<string,unknown>;
    try{body=await request.json();}catch{return NextResponse.json({error:'请求格式无效'},{status:400});}
    const requestId=body.requestId;
    if(typeof requestId!=='string')return NextResponse.json({error:'缺少请求编号'},{status:400});
    let command:Record<string,unknown>;
    if(body.action==='send')command={action:'send',requestId,text:body.text,modelId:body.modelId,references:body.references??[],canvasVersion:body.canvasVersion};
    else if(body.action==='answer')command={action:'answer',requestId,text:body.text,questionId:body.questionId};
    else if(body.action==='stop'||body.action==='continue')command={action:body.action,requestId};
    else return NextResponse.json({error:'不支持的操作'},{status:400});
    return goMapped(request,`/v1/agent/projects/${encodeURIComponent(projectId)}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)},value=>value,false);
  }
  try {
    const {projectId}=await context.params;const body=await request.json();const service=getAgentService();
    if(typeof body.requestId!=='string')throw new Error('Request identity required');
    if(body.action==='continue')return NextResponse.json(service.continue(projectId,body.requestId));
    if(body.action==='stop')return NextResponse.json(service.stop(projectId,body.requestId));
    if(body.action==='answer')return NextResponse.json(service.answer(projectId,body));
    if(body.action!=='send' || !publicAgentModels().some(m=>m.id===body.modelId && m.available))throw new Error('Model unavailable');
    return NextResponse.json(service.send(projectId,body));
  }catch{return NextResponse.json({error:'请求无法执行，请检查消息、模型配置或待处理事项。'},{status:400});}
}
