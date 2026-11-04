import { NextRequest, NextResponse } from 'next/server';
import { getAgentService } from '@/lib/agent/server';
import { publicAgentModels } from '@/lib/agent/config';
export const runtime='nodejs';
type Context={params:Promise<{projectId:string}>};
export async function GET(_request:NextRequest,context:Context){
  try {const {projectId}=await context.params;return NextResponse.json({...getAgentService().snapshot(projectId),models:publicAgentModels()});}
  catch {return NextResponse.json({error:'无法读取创作助手或项目不存在'},{status:404});}
}
export async function POST(request:NextRequest,context:Context){
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
