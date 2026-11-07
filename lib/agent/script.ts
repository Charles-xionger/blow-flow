import { getWorkflowById } from '../db/workflows';
import { getScriptService } from '../script/service';
import { scriptPresets } from '../script/inputs';
import { scriptOutputIds } from '../script/shots';
import type { AgentService } from './service';

/** The script is an input tool; generated content belongs to its separate text node. */
export function registerScriptTools(service: AgentService) {
  service.registerTool({ name:'read_script',idempotent:true,
    description:'Read script generation tasks, live text and output text node IDs. Storyboard generation creates one text node per shot; other presets create one text node. There is no publish step or version editor.',
    inputSchema:{type:'object',properties:{nodeId:{type:'string'}},required:['nodeId'],additionalProperties:false},
    execute:(task,args) => {
      if (!getWorkflowById(task.projectId)?.nodes.some(node => node.id === args.nodeId && node.type === 'script')) throw new Error('Script node not found');
      return { tasks:getScriptService().list(task.projectId,String(args.nodeId)).map(value => ({ ...value, outputNodeIds:scriptOutputIds(value) })),presets:scriptPresets };
    } });
}
