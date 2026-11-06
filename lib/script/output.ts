import { randomUUID } from 'node:crypto';
import { CanvasAgentService } from '../agent/canvas';
import { getWorkflowById } from '../db/workflows';
import { promptSegments } from '../canvas/prompt';
import { NodeType, type CanvasNode } from '../../types';
import type { ScriptTask } from './types';
import type { TextPurpose } from './publishing-types';

const purposes: Record<string, TextPurpose> = { free:'idea', screenplay:'script', storyboard:'storyboard', extract:'material' };
const titles: Record<string,string> = { free:'创意文本',screenplay:'剧本',storyboard:'分镜文稿',extract:'角色／场景／道具' };

/** One visible text result per request. Creation and task insertion share the caller's transaction. */
export function createScriptOutput(task: ScriptTask): string {
  const graph = getWorkflowById(task.canvasId);
  const source = (graph?.nodes as CanvasNode[] | undefined)?.find(node => node.id === task.nodeId);
  if (!source) throw new Error('脚本节点不存在');
  const id = randomUUID();
  const previous = graph!.nodes.filter(node => node.data.scriptOutputSource === task.nodeId).length;
  new CanvasAgentService().apply(task.canvasId,`script-output:${task.id}`, [
    {kind:'create',node:{id,type:NodeType.TEXT,position:{x:source.position.x + (source.data.displaySize?.width || 320) + 100,y:source.position.y + previous * 280},
      ...(source.parentId ? {parentId:source.parentId} : {}),data:{type:NodeType.TEXT,label:'文本',customTitle:titles[task.input.preset] || '生成文本',prompt:[],
        textPurpose:purposes[task.input.preset] || 'idea',scriptOutputTaskId:task.id,scriptOutputSource:source.id}}},
    {kind:'connect',edge:{id:`script-output-edge:${task.id}`,source:source.id,target:id}},
  ],'生成文本');
  return id;
}

/** Terminal content becomes ordinary editable text; never revive deleted nodes or replace manual edits. */
export function finishScriptOutput(task: ScriptTask) {
  if (!task.outputNodeId) return;
  const graph = getWorkflowById(task.canvasId);
  const target = (graph?.nodes as CanvasNode[] | undefined)?.find(node => node.id === task.outputNodeId);
  if (!target || target.data.scriptOutputTaskId !== task.id || promptSegments(target.data.prompt).some(segment => 'ref' in segment || segment.text.length > 0)) return;
  if (!task.text) return;
  new CanvasAgentService().apply(task.canvasId,`script-output-finish:${task.id}`, [
    {kind:'update',id:target.id,data:{prompt:[{text:task.text}]}},
  ],'保存生成文本');
}
