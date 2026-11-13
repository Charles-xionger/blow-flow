/* eslint-disable @typescript-eslint/no-require-imports */
require('../scripts/register-typescript.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {fork}=require('node:child_process');const {once}=require('node:events');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const Database=require('better-sqlite3');
const {AgentService}=require('../lib/agent/service');
test('a killed worker retains progress, live workers do not interrupt it, and only user continue resumes once',{timeout:15000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-restart-'));const filename=path.join(dir,'db');const db=new Database(filename);db.pragma('journal_mode=WAL');db.exec('CREATE TABLE workflows(id TEXT PRIMARY KEY,data TEXT,deleted_at INTEGER)');db.prepare('INSERT INTO workflows VALUES(?,?,NULL)').run('project',JSON.stringify({nodes:[],edges:[]}));
 const service=new AgentService(db,{leaseMs:400});const task=service.send('project',{requestId:'send',text:'创作',modelId:'test'});const child=fork(path.join(__dirname,'helpers/agent-recovery-worker.cjs'),[],{stdio:['ignore','pipe','pipe','ipc']});
 try{child.send({filename});await once(child,'message');assert.equal(await service.runNext(async()=>assert.fail('same project was claimed twice')),false);assert.equal(service.task(task.id).status,'running');child.kill('SIGKILL');await once(child,'exit');await new Promise(r=>setTimeout(r,600));
 assert.equal(await service.runNext(async()=>assert.fail('restart automatically planned')),false);assert.equal(service.snapshot('project').tasks[0].status,'interrupted');assert.equal(service.snapshot('project').messages.at(-1).text,'已保存的进度');
 service.continue('project','resume');service.continue('project','resume');service.continue('project','another-click');await service.runNext(async c=>{assert.equal(c.messages.at(-1).text,'已保存的进度');c.reply('完成');});assert.equal(service.task(task.id).status,'completed');assert.equal(service.snapshot('project').tasks.length,1);
 }finally{child.kill('SIGKILL');db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('continuation reconciles an interrupted tool from its durable receipt before planning again',async()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE workflows(id TEXT PRIMARY KEY,data TEXT,deleted_at INTEGER)');db.prepare('INSERT INTO workflows VALUES(?,?,NULL)').run('p',JSON.stringify({nodes:[],edges:[]}));
 const service=new AgentService(db,{leaseMs:20});const task=service.send('p',{requestId:'send',text:'创作',modelId:'test'});
 let release;const pending=new Promise(r=>release=r);let calls=0;
 service.registerTool({name:'durable_edit',idempotent:true,description:'controlled durable application boundary',inputSchema:{},execute:async()=>{calls++;if(calls===1)await pending;return {receipt:'saved'};}});
 const first=service.runNext(c=>c.tool('edit','durable_edit',{}));
 const realNow=Date.now;Date.now=()=>realNow()+1000;
 try{const reopened=new AgentService(db);reopened.registerTool({name:'durable_edit',idempotent:true,description:'read receipt',inputSchema:{},execute:()=>({receipt:'saved'})});reopened.continue('p','resume');await reopened.runNext(async c=>{assert.equal(c.task.steps[0].status,'completed');assert.deepEqual(c.task.steps[0].result,{receipt:'saved'});});release();await first;assert.equal(reopened.task(task.id).status,'completed');}finally{Date.now=realNow;release();db.close();}
});
