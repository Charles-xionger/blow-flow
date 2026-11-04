import assert from 'node:assert/strict';
import sharp from 'sharp';
import { getDatabase, closeDatabase } from '../../lib/db';
import { saveWorkflow } from '../../lib/db/workflows';
import { CanvasAgentService } from '../../lib/agent/canvas';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import { AgentService } from '../../lib/agent/service';
import { registerReadTools } from '../../lib/agent/mcp';
import { createPiRuntime } from '../../lib/agent/runtime';
async function main(){
const {createAssistantMessageEventStream}=await import('@mariozechner/pi-ai');
const pixel=(await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer()).toString('base64');
process.env.DATABASE_PATH=':memory:';
const db=getDatabase();saveWorkflow({id:'project',requestId:'seed',baseVersion:0,snapshot:{name:'project',nodes:[{id:'hero',type:'text',position:{x:0,y:0},data:{type:'text',text:'阿青',imageSrc:`data:image/png;base64,${pixel}`}}],edges:[],viewport:{x:0,y:0,zoom:1}}});
const service=new AgentService(db);registerReadTools(service);const task=service.send('project',{requestId:'message',text:'读取画布中的主角',modelId:'gemini-flash',references:[{nodeId:'hero'}]});
let turn=0;
await service.runNext(createPiRuntime(service,{apiKey:'test-only',streamFn:(model,context)=>{
  const stream=createAssistantMessageEventStream();turn++;
  if(turn===1)assert.ok(context.messages.some(m=>m.role==='user' && Array.isArray(m.content) && m.content.some(c=>c.type==='image' && c.data.length>0)));
  if(turn===2){assert.ok(context.messages.some(m=>m.role==='toolResult' && JSON.stringify(m.content).includes('阿青')));}
  const message:AssistantMessage={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:turn===1?[{type:'toolCall',id:'read-1',name:'read_canvas',arguments:{}}]:[{type:'text',text:'主角是阿青。'}],stopReason:turn===1?'toolUse':'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  stream.push({type:'done',reason:turn===1?'toolUse':'stop',message});return stream;
}}));
assert.equal(service.task(task.id).status,'completed');assert.equal(service.task(task.id).steps[0].status,'completed');assert.equal(service.snapshot('project').messages.at(-1)?.text,'主角是阿青。');const failed = service.send('project',{requestId:'failure',text:'再次创作',modelId:'gemini-flash'});
await service.runNext(createPiRuntime(service,{apiKey:'test-only',streamFn:()=>{throw new Error('controlled provider failure');}}));
assert.equal(service.task(failed.id).status,'failed');
const streamFailure=service.send('project',{requestId:'stream-failure',text:'流中断',modelId:'gemini-flash'});
const logged:string[]=[];const consoleError=console.error;console.error=(...args:unknown[])=>{logged.push(args.map(String).join(' '));};
try{
await service.runNext(createPiRuntime(service,{apiKey:'test-only',streamFn:model=>{
 const stream=createAssistantMessageEventStream();
 stream.push({type:'error',reason:'error',error:{role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'error',errorMessage:'controlled stream error: models/gemini-retired not found for key=AIzaSyFakeKey123 {"apiKey":"sk-proxy-secret"} x-api-key: proxy-header-secret',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});
 return stream;
}}));
}finally{console.error=consoleError;}
assert.equal(service.task(streamFailure.id).status,'failed');
// Workers must leave the provider's cause in server logs; the UI keeps the generic message.
assert.equal(service.task(streamFailure.id).error,'助手执行失败，请检查平台配置或稍后重试。');
const failureLog=logged.find(line=>line.includes(streamFailure.id));
assert.ok(failureLog,`expected a failure log for the task, got ${JSON.stringify(logged)}`);
assert.match(failureLog,/models\/gemini-retired not found/);
assert.doesNotMatch(failureLog,/AIzaSyFakeKey123|sk-proxy-secret|proxy-header-secret/);
new CanvasAgentService().apply('project','delete-hero',[{kind:'delete',id:'hero'}]);
const unrelated=service.send('project',{requestId:'unrelated',text:'写一个新的故事',modelId:'gemini-flash'});
let calls=0;
await service.runNext(createPiRuntime(service,{apiKey:'test-only',streamFn:(model,context)=>{
 calls++;assert.match(JSON.stringify(context.messages),/hero/);
 const stream=createAssistantMessageEventStream();
 stream.push({type:'done',reason:'stop',message:{role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:'新故事'}],stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});return stream;
}}));
assert.equal(service.task(unrelated.id).status,'completed');assert.equal(calls,1);
assert.throws(()=>service.send('project',{requestId:'invalid-ref',text:'看看',modelId:'gemini-flash',references:[{nodeId:'hero'}]}),/Reference node not found/);
closeDatabase();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
