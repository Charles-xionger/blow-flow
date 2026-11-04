/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test fixture. */
require('../../scripts/register-typescript.cjs');
process.on('message',async({filename})=>{
 process.env.DATABASE_PATH=filename;
 const {getDatabase}=require('../../lib/db');const {AgentService}=require('../../lib/agent/service');const {CanvasAgentService}=require('../../lib/agent/canvas');
 const service=new AgentService(getDatabase(),{leaseMs:400});const canvas=new CanvasAgentService();
 service.registerTool({name:'durable_canvas',idempotent:true,description:'persist canvas before interrupted response',inputSchema:{type:'object'},execute:async(task,args,callId)=>{
  canvas.apply(task.projectId,`${task.id}:${callId}`,args.operations,'恢复创作');
  process.send('canvas-saved');await new Promise(()=>{});
 }});
 await service.runNext(c=>c.tool('saved-edit','durable_canvas',{operations:[{kind:'update',id:'text',data:{prompt:'已写入的故事'}}]}));
});
