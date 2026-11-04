/* eslint-disable @typescript-eslint/no-require-imports */
require('../scripts/register-typescript.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');const {fork}=require('node:child_process');const {once}=require('node:events');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
test('a process killed after the canvas commit reconciles its real receipt without another history entry',{timeout:15000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-canvas-crash-'));const filename=path.join(dir,'db');process.env.DATABASE_PATH=filename;
 const {getDatabase,closeDatabase}=require('../lib/db');const {saveWorkflow}=require('../lib/db/workflows');const {AgentService}=require('../lib/agent/service');const {CanvasAgentService}=require('../lib/agent/canvas');
 saveWorkflow({id:'p',requestId:'seed',baseVersion:0,snapshot:{name:'p',nodes:[{id:'text',type:'text',position:{x:0,y:0},data:{type:'text',prompt:'原始故事'}}],edges:[],viewport:{x:0,y:0,zoom:1}}});
 const service=new AgentService(getDatabase());const task=service.send('p',{requestId:'send',text:'改写故事',modelId:'test'});const child=fork(path.join(__dirname,'helpers/agent-canvas-crash-worker.cjs'),[],{stdio:['ignore','pipe','pipe','ipc']});
 try{child.send({filename});await once(child,'message');const before=service.canvas('p');assert.equal(before.nodes[0].data.prompt,'已写入的故事');assert.equal(service.task(task.id).steps[0].status,'running');child.kill('SIGKILL');await once(child,'exit');await new Promise(r=>setTimeout(r,600));
 const canvas=new CanvasAgentService();service.registerTool({name:'durable_canvas',idempotent:true,description:'reconcile persisted canvas operation',inputSchema:{type:'object'},execute:(task,args,callId)=>canvas.apply(task.projectId,`${task.id}:${callId}`,args.operations,'恢复创作')});
 service.continue('p','continue');await service.runNext(async c=>{assert.equal(c.task.steps[0].status,'completed');await c.tool('saved-edit','durable_canvas',{operations:[{kind:'update',id:'text',data:{prompt:'已写入的故事'}}]});c.reply('恢复完成');});
 assert.equal(service.task(task.id).status,'completed');assert.equal(service.canvas('p').history.undo.length,1);assert.equal(service.canvas('p').nodes[0].data.prompt,'已写入的故事');assert.deepEqual(service.canvas('p').history,before.history);
 }finally{child.kill('SIGKILL');closeDatabase();fs.rmSync(dir,{recursive:true,force:true});}
});
