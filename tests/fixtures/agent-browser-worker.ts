// Controlled model boundary for browser tests only; application persistence/tools stay real.
import { getAgentService } from '../../lib/agent/server';
import { registerCanvasTools } from '../../lib/agent/canvas';
import { getGenerationService } from '../../lib/generation/server';
const service=getAgentService();
registerCanvasTools(service, () => getGenerationService().models().map(model => ({ ...model, configured: true })));
async function main(){for(;;){const worked=await service.runNext(async c=>{
  const input=c.messages.filter(m=>m.taskId===c.task.id && m.role==='user').at(-1)!;
  if(input.text.includes('提问') && !c.task.question?.answer){await c.tool('question','ask_question',{text:'故事面向谁？',options:['儿童','成人']});return;}
  if(input.text.includes('后台'))await new Promise(resolve=>setTimeout(resolve,1500));
  if(c.signal.aborted)return;
  if(input.text.startsWith('测试画布编辑')) {
    await c.tool('canvas-edit', 'edit_canvas', { label: '助手修改参数', operations: [{ kind: 'update', id: 'image', data: { generationWidth: 1024, generationHeight: 1024, generationSizePreset: 'custom', customTitle: '助手结果' } }] });
  }
  if(input.text.startsWith('测试新建节点')) {
    await c.tool('canvas-create', 'edit_canvas', { label: '助手分镜', operations: [1, 2].map(i => ({ kind: 'create', node: { id: `shot-${i}`, type: 'text', data: { type: 'text', label: `分镜${i}`, prompt: `场景${i}` } } })) });
  }
  if(input.text.startsWith('测试局部整理')) await c.tool('canvas-layout', 'layout_canvas', { ids: ['shot-1', 'shot-2'], direction: 'DOWN' });

  const canvas=await c.tool(`canvas-${c.task.steps.length}`,'read_canvas',{}) as {nodes:unknown[]};
  c.reply(`已读取 ${canvas.nodes.length} 个节点；收到：${input.text}`);
});if(!worked)await new Promise(resolve=>setTimeout(resolve,100));}}
main().catch(()=>process.exit(1));
