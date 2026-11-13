import assert from 'node:assert/strict';
import sharp from 'sharp';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import { getDatabase, closeDatabase } from '../../lib/db';
import { saveWorkflow } from '../../lib/db/workflows';
import { AgentService } from '../../lib/agent/service';
import { registerReadTools } from '../../lib/agent/mcp';
import { createPiRuntime } from '../../lib/agent/runtime';
import { createLangfuseTracer } from '../../lib/agent/tracing';
const usage={input:120,output:30,cacheRead:0,cacheWrite:0,totalTokens:150,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
async function main(){
const {createAssistantMessageEventStream}=await import('@mariozechner/pi-ai');
const pixel=(await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer()).toString('base64');
process.env.DATABASE_PATH=':memory:';
const db=getDatabase();saveWorkflow({id:'project',requestId:'seed',baseVersion:0,snapshot:{name:'project',nodes:[{id:'hero',type:'text',position:{x:0,y:0},data:{type:'text',text:'阿青',imageSrc:`data:image/png;base64,${pixel}`}}],edges:[],viewport:{x:0,y:0,zoom:1}}});
const exporter=new InMemorySpanExporter();
// Real Langfuse processor; only the network export is replaced.
const tracer=createLangfuseTracer(new LangfuseSpanProcessor({exporter,exportMode:'immediate',publicKey:'pk-lf-test',secretKey:'sk-lf-test',baseUrl:'http://127.0.0.1:9'}));
const service=new AgentService(db);registerReadTools(service);
const task=service.send('project',{requestId:'traced',text:'读取画布中的主角',modelId:'gemini-flash',references:[{nodeId:'hero'}]});
let turn=0;
await service.runNext(createPiRuntime(service,{apiKey:'test-only',tracer,streamFn:model=>{
 const stream=createAssistantMessageEventStream();turn++;
 const message:AssistantMessage={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:turn===1?[{type:'toolCall',id:'read-1',name:'read_canvas',arguments:{}}]:[{type:'text',text:'主角是阿青。'}],stopReason:turn===1?'toolUse':'stop',timestamp:Date.now(),usage};
 stream.push({type:'done',reason:turn===1?'toolUse':'stop',message});return stream;
}}));
assert.equal(service.task(task.id).status,'completed');
const spans=exporter.getFinishedSpans();
const attr=(span:typeof spans[number],key:string)=>span.attributes[key];
const typed=(type:string)=>spans.filter(span=>attr(span,'langfuse.observation.type')===type);
const [root]=typed('agent');
assert.ok(root,'one agent observation per task run');
// Langfuse v4 filters observations individually, so every observation carries the session.
for(const span of spans)assert.equal(attr(span,'session.id'),'project',`${span.name} lacks the project session`);
assert.equal(attr(root,'langfuse.observation.metadata.taskId'),JSON.stringify(task.id));
assert.match(String(attr(root,'langfuse.observation.output')),/主角是阿青/);
const generations=typed('generation');
assert.equal(generations.length,2,'one generation per model call');
for(const generation of generations){
 assert.equal(generation.parentSpanContext?.spanId,root.spanContext().spanId);
 assert.equal(attr(generation,'langfuse.observation.model.name'),'gemini-flash-latest');
 assert.match(String(attr(generation,'langfuse.observation.input')),/读取画布中的主角/);
}
assert.match(String(attr(generations[1],'langfuse.observation.usage_details')),/"input":120/);
const [tool]=typed('tool');
assert.equal(tool?.name,'read_canvas');
assert.match(String(attr(tool,'langfuse.observation.output')),/阿青/);
// Reference images reach the model but are summarised, not shipped, in traces.
for(const span of spans)for(const value of Object.values(span.attributes))assert.ok(!String(value).includes(pixel),`image bytes leaked into ${span.name}`);
exporter.reset();
const failed=service.send('project',{requestId:'traced-failure',text:'再来',modelId:'gemini-flash'});
await service.runNext(createPiRuntime(service,{apiKey:'test-only',tracer,streamFn:model=>{
 const stream=createAssistantMessageEventStream();
 stream.push({type:'error',reason:'error',error:{role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'error',errorMessage:'models/gemini-retired not found key=AIzaSyFakeKey123',timestamp:Date.now(),usage}});
 return stream;
}}));
assert.equal(service.task(failed.id).status,'failed');
const failedSpans=exporter.getFinishedSpans();
const failedRoot=failedSpans.find(span=>span.attributes['langfuse.observation.type']==='agent');
assert.equal(failedRoot?.attributes['langfuse.observation.level'],'ERROR');
assert.match(String(failedRoot?.attributes['langfuse.observation.status_message']),/gemini-retired not found/);
for(const span of failedSpans)for(const value of Object.values(span.attributes))assert.ok(!String(value).includes('AIzaSyFakeKey123'),`credential leaked into ${span.name}`);
exporter.reset();
// A stream that throws never emits message_end; its generation still records the failure.
const thrown=service.send('project',{requestId:'traced-throw',text:'断流',modelId:'gemini-flash'});
await service.runNext(createPiRuntime(service,{apiKey:'test-only',tracer,streamFn:()=>{throw new Error('socket hang up');}}));
assert.equal(service.task(thrown.id).status,'failed');
const thrownGeneration=exporter.getFinishedSpans().find(span=>span.attributes['langfuse.observation.type']==='generation');
assert.equal(thrownGeneration?.attributes['langfuse.observation.level'],'ERROR');
exporter.reset();
// Setup failures (no model credentials) happen before any model call and are still traced.
delete process.env.GEMINI_API_KEY;
const unconfigured=service.send('project',{requestId:'traced-setup',text:'你好',modelId:'gemini-flash'});
await service.runNext(createPiRuntime(service,{tracer}));
assert.equal(service.task(unconfigured.id).status,'failed');
const setupRoot=exporter.getFinishedSpans().find(span=>span.attributes['langfuse.observation.type']==='agent');
assert.equal(setupRoot?.attributes['langfuse.observation.level'],'ERROR');
assert.match(String(setupRoot?.attributes['langfuse.observation.status_message']),/Agent model unavailable/);
// Only one tracer may be live: Langfuse routes observations through a global provider.
assert.throws(()=>createLangfuseTracer(new LangfuseSpanProcessor({exporter})),/already active/);
await tracer.shutdown();
// Tracing must never decide a task's outcome.
const broken=createLangfuseTracer({onStart(){throw new Error('exporter down');},onEnd(){throw new Error('exporter down');},forceFlush:async()=>{throw new Error('exporter down');},shutdown:async()=>{}});
const resilient=service.send('project',{requestId:'tracer-down',text:'你好',modelId:'gemini-flash'});
await service.runNext(createPiRuntime(service,{apiKey:'test-only',tracer:broken,streamFn:model=>{
 const stream=createAssistantMessageEventStream();
 stream.push({type:'done',reason:'stop',message:{role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:'你好'}],stopReason:'stop',timestamp:Date.now(),usage}});return stream;
}}));
assert.equal(service.task(resilient.id).status,'completed');
await broken.shutdown();
closeDatabase();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
