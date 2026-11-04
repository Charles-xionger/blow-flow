import assert from 'node:assert/strict';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import { AgentService } from '../../lib/agent/service';
import { registerReadTools } from '../../lib/agent/mcp';
import { createPiRuntime } from '../../lib/agent/runtime';
async function main(){
const {createAssistantMessageEventStream}=await import('@mariozechner/pi-ai');
const pixel=(await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer()).toString('base64');
const db=new Database(':memory:');db.exec('CREATE TABLE workflows(id TEXT PRIMARY KEY,data TEXT,deleted_at INTEGER)');db.prepare('INSERT INTO workflows VALUES(?,?,NULL)').run('project',JSON.stringify({nodes:[{id:'hero',type:'text',data:{text:'阿青',imageSrc:`data:image/png;base64,${pixel}`}}],edges:[]}));
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
await service.runNext(createPiRuntime(service,{apiKey:'test-only',streamFn:model=>{
 const stream=createAssistantMessageEventStream();
 stream.push({type:'error',reason:'error',error:{role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'error',errorMessage:'controlled stream error',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});
 return stream;
}}));
assert.equal(service.task(streamFailure.id).status,'failed');
db.close();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
