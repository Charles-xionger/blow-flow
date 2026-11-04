/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test fixture. */
require('../../scripts/register-typescript.cjs');
const Database=require('better-sqlite3');
const {AgentService}=require('../../lib/agent/service');
process.on('message',async({filename})=>{
 const service=new AgentService(new Database(filename),{leaseMs:400});
 await service.runNext(async c=>{c.reply('已保存的进度');process.send('running');await new Promise(()=>{});});
});
