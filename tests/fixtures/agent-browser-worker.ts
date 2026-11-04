// Controlled model boundary for browser tests only; application persistence/tools stay real.
import { getAgentService } from '../../lib/agent/server';
const service=getAgentService();
async function main(){for(;;){const worked=await service.runNext(async c=>{
  const input=c.messages.filter(m=>m.taskId===c.task.id && m.role==='user').at(-1)!;
  if(input.text.includes('提问') && !c.task.question?.answer){await c.tool('question','ask_question',{text:'故事面向谁？',options:['儿童','成人']});return;}
  if(input.text.includes('后台'))await new Promise(resolve=>setTimeout(resolve,1500));
  if(c.signal.aborted)return;
  const canvas=await c.tool(`canvas-${c.task.steps.length}`,'read_canvas',{}) as {nodes:unknown[]};
  c.reply(`已读取 ${canvas.nodes.length} 个节点；收到：${input.text}`);
});if(!worked)await new Promise(resolve=>setTimeout(resolve,100));}}
main().catch(()=>process.exit(1));
