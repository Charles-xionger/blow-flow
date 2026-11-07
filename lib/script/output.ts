import { randomUUID } from 'node:crypto';
import { CanvasAgentService } from '../agent/canvas';
import { getWorkflowById } from '../db/workflows';
import { promptSegments } from '../canvas/prompt';
import { NodeType, type CanvasNode } from '../../types';
import type { ScriptTask } from './types';
import { scriptOutputIds, scriptOutputText } from './shots';
import type { TextPurpose } from './publishing-types';

const purposes: Record<string, TextPurpose> = { free:'idea', screenplay:'script', storyboard:'storyboard', extract:'material' };
const titles: Record<string,string> = { free:'创意文本',screenplay:'剧本',storyboard:'分镜文稿',extract:'角色／场景／道具' };

/** The first visible text result per request. Creation and task insertion share the caller's transaction. */
export function createScriptOutput(task: ScriptTask): string {
  const graph = getWorkflowById(task.canvasId);
  const source = (graph?.nodes as CanvasNode[] | undefined)?.find(node => node.id === task.nodeId);
  if (!source) throw new Error('脚本节点不存在');
  const id = randomUUID();
  const position = outputPosition(source, graph!.nodes as CanvasNode[]);
  new CanvasAgentService().apply(task.canvasId,`script-output:${task.id}`, [
    {kind:'create',node:{id,type:NodeType.TEXT,position,
      ...(source.parentId ? {parentId:source.parentId} : {}),data:{type:NodeType.TEXT,label:'文本',customTitle:task.input.outputMode === 'shots' ? '镜头 001' : titles[task.input.preset] || '生成文本',prompt:[],
        textPurpose:purposes[task.input.preset] || 'idea',scriptOutputTaskId:task.id,scriptOutputSource:source.id}}},
    {kind:'connect',edge:{id:`script-output-edge:${task.id}`,source:source.id,target:id}},
  ],'生成文本');
  return id;
}

/** New outputs occupy free rows beside the script without moving existing canvas content. */
function outputPosition(source: CanvasNode, nodes: CanvasNode[]) {
  const x = source.position.x + (source.data.displaySize?.width || 320) + 100;
  let y = source.position.y;
  const occupied = nodes.filter(node => node.parentId === source.parentId && node.position.x < x + 320 + 40 && node.position.x + (node.data.displaySize?.width || 320) + 40 > x)
    .sort((a, b) => a.position.y - b.position.y);
  for (const node of occupied) {
    const bottom = node.position.y + (node.data.displaySize?.height || 240) + 60;
    if (bottom > y && node.position.y < y + 240 + 60) y = bottom;
  }
  return { x, y };
}

/** Stable operation identities prevent replay from recreating a user-deleted shot. */
export function ensureScriptShotOutputs(task: ScriptTask) {
  if (task.input.outputMode !== 'shots') return;
  const ids = scriptOutputIds(task);
  const graph = getWorkflowById(task.canvasId);
  const nodes = graph?.nodes as CanvasNode[] | undefined;
  const source = nodes?.find(node => node.id === task.nodeId);
  if (!source || !nodes) return;
  const canvas = new CanvasAgentService();
  for (let index = 1; index < ids.length; index++) {
    const id = ids[index];
    if (nodes.some(node => node.id === id) || canvas.receipt(task.canvasId, `script-output-shot:${task.id}:${index}`)) continue;
    const node: CanvasNode = { id, type: NodeType.TEXT, position: outputPosition(source, nodes),
      ...(source.parentId ? { parentId: source.parentId } : {}),
      data: { type: NodeType.TEXT, label: '文本', customTitle: `镜头 ${String(index + 1).padStart(3, '0')}`,
        prompt: [], textPurpose: 'storyboard', scriptOutputTaskId: task.id, scriptOutputSource: source.id } };
    canvas.apply(task.canvasId, `script-output-shot:${task.id}:${index}`, [
      { kind: 'create', node },
      { kind: 'connect', edge: { id: `script-output-edge:${task.id}:${index}`, source: source.id, target: id } },
    ], '生成分镜文本');
    nodes.push(node);
  }
}

/** Terminal content becomes ordinary editable text; never revive deleted nodes or replace manual edits. */
export function finishScriptOutput(task: ScriptTask) {
  ensureScriptShotOutputs(task);
  const graph = getWorkflowById(task.canvasId);
  for (const id of scriptOutputIds(task)) {
    const target = (graph?.nodes as CanvasNode[] | undefined)?.find(node => node.id === id);
    if (!target || target.data.scriptOutputTaskId !== task.id || promptSegments(target.data.prompt).some(segment => 'ref' in segment || segment.text.length > 0)) continue;
    const text = scriptOutputText(task, id);
    if (!text) continue;
    new CanvasAgentService().apply(task.canvasId, `script-output-finish:${task.id}:${id}`, [
      {kind:'update',id,data:{prompt:[{text}]}},
    ], '保存生成文本');
  }
}
