import assert from 'node:assert/strict';
import sharp from 'sharp';
import { getDatabase, closeDatabase } from '../../lib/db';
import { saveWorkflow } from '../../lib/db/workflows';
import { AgentService } from '../../lib/agent/service';
import { registerGenerationTools } from '../../lib/agent/generation';
import { GenerationService } from '../../lib/generation/service';
import { defaultConfig } from '../../lib/generation/config';
import { geminiImageConfig } from '../../lib/generation/gemini-image';
import { createPiRuntime } from '../../lib/agent/runtime';
import { uploadAgentReference } from '../../lib/agent/upload';

async function main() {
 const {createAssistantMessageEventStream}=await import('@mariozechner/pi-ai');
 process.env.DATABASE_PATH=':memory:';process.env.GEMINI_API_KEY='controlled';process.env.RUNNINGHUB_API_KEY='controlled';
 process.env.OSS_BUCKET_NAME='references';process.env.OSS_REGION='oss-test';
 const url='https://references.oss-test.aliyuncs.com/images/original.png';
 const original=await sharp({create:{width:2048,height:1700,channels:4,background:'#ff000080'}}).png().toBuffer();
 const nativeFetch=global.fetch;
 let uploads=0;
 global.fetch=async(input,init)=>{
  if(input==='/api/upload/image') {
   uploads++;const file=(init!.body as FormData).get('file') as File;
   assert.deepEqual(Buffer.from(await file.arrayBuffer()),original);
   return Response.json({success:true,data:{url,objectKey:'images/original.png',contentType:'image/png'}});
  }
  assert.equal(input,url);return new Response(new Uint8Array(original),{headers:{'content-type':'image/png'}});
 };
 try {
  const reference=await uploadAgentReference(new File([new Uint8Array(original)],'character.png',{type:'image/png'}));
  const db=getDatabase();saveWorkflow({id:'upload',requestId:'seed',baseVersion:0,snapshot:{name:'upload',nodes:[{id:'image',type:'textToImage',position:{x:0,y:0},data:{type:'textToImage'}},{id:'video',type:'textToVideo',position:{x:500,y:0},data:{type:'textToVideo'}}],edges:[],viewport:{x:0,y:0,zoom:1}}});
  const config=structuredClone(defaultConfig),gemini=geminiImageConfig();config.connections[0].baseUrl='https://controlled.invalid';config.connections.push(...gemini.connections);config.models.push(...gemini.models);
  const generation=new GenerationService(db,config),service=new AgentService(db);registerGenerationTools(service,generation);
  const task=service.send('upload',{requestId:'send',text:'用参考图生成图片和视频',modelId:'gemini-flash',references:[reference]});
  let turns=0,toolResults='';
  await service.runNext(createPiRuntime(service,{apiKey:'controlled',streamFn:(model,context)=>{
   toolResults=JSON.stringify(context.messages.filter(m=>m.role==='toolResult'));turns++;assert.equal(turns,1,JSON.stringify(context.messages));assert.match(JSON.stringify(context.messages),/https:\/\/references\.oss-test\.aliyuncs\.com\/images\/original.png/);
   assert.ok(context.messages.some(message=>message.role==='user'&&Array.isArray(message.content)&&message.content.some(part=>part.type==='image')));
   const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'toolUse',message:{role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'toolCall',id:'prepare-upload',name:'prepare_generation',arguments:{items:[{nodeId:'image',modelId:'gemini-3-pro-image-preview',input:{prompt:'portrait',width:1024,height:1024,references:[{kind:'image',url}]}},{nodeId:'video',modelId:'runninghub-h3',input:{prompt:'animate',width:1280,height:736,duration:7,references:[{kind:'image',url}]}}]}}],stopReason:'toolUse',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});return stream;
  }}));
  assert.equal(turns,1,toolResults);assert.equal(service.task(task.id).status,'waiting');
  const question=service.task(task.id).question!;assert.equal(question.scope?.kind,'generation');
  service.answer('upload',{requestId:'approve',questionId:question.id,text:'确认生成'});
  const reopened=new AgentService(db);registerGenerationTools(reopened,generation);
  assert.deepEqual(reopened.snapshot('upload').messages[0].references,[{url,assetId:'images/original.png',name:'character.png',mimeType:'image/png'}]);
  const requests=reopened.snapshot('upload').generations![0].items.map(item=>item.task!);
  assert.equal(requests.length,2);assert.deepEqual(requests.map(item=>item.input.references),[[{kind:'image',url}],[{kind:'image',url}]]);
  assert.equal(uploads,1);assert.equal(requests[1].outputType,'video');
 } finally {global.fetch=nativeFetch;closeDatabase();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
