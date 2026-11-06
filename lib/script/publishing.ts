import { createHash, randomUUID } from 'node:crypto';
import { CanvasAgentService } from '../agent/canvas';
import { getDatabase } from '../db';
import { getWorkflowById } from '../db/workflows';
import { canonicalJSON } from '../canvas/save-protocol';
import { expandPrompt } from '../canvas/prompt';
import { NodeType, type CanvasNode } from '../../types';
import { ScriptError } from './service';
import { getScriptVersionService } from './versions';
import { textPurposes, type PublishScript, type PublishTarget, type PublishResult } from './publishing-types';

type Link = { target_id: string; revision: string };
const revision = (node: CanvasNode) => createHash('sha256').update(canonicalJSON({ data:node.data })).digest('hex');
export class ScriptPublishConflict extends ScriptError {
  constructor(public target: PublishTarget) { super(target.deleted ? '原文本已删除，请创建新文本' : '原文本已修改，请查看当前内容；推荐创建新文本',409); }
}
/** Shared UI/assistant boundary. Assistant callers must supply an in-transaction ownership/lease guard. */
export class ScriptPublishingService {
  private db = getDatabase();
  private canvas = new CanvasAgentService();
  private versions = getScriptVersionService();
  constructor() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS script_publish_links (
      canvas_id TEXT NOT NULL,node_id TEXT NOT NULL,target_id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(canvas_id,node_id));
      CREATE TABLE IF NOT EXISTS script_publish_receipts (
      canvas_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(canvas_id,request_id));`);
  }
  target(canvasId: string,nodeId: string): PublishTarget | null {
    const graph = getWorkflowById(canvasId);
    if (!graph) throw new ScriptError('项目不存在或已删除',404);
    const link = this.db.prepare('SELECT target_id,revision FROM script_publish_links WHERE canvas_id=? AND node_id=?').get(canvasId,nodeId) as Link | undefined;
    if (!link) return null;
    const node = (graph.nodes as CanvasNode[]).find(n => n.id === link.target_id && n.type === NodeType.TEXT);
    return { id:link.target_id,text:node ? expandPrompt(node.id,{nodes:graph.nodes as CanvasNode[],edges:graph.edges}) : '',revision:node ? revision(node) : '',changed:!node || revision(node) !== link.revision,deleted:!node };
  }
  publish(request: PublishScript, authorize?: (targetId: string | undefined) => boolean): PublishResult {
    if (!request || ['requestId','canvasId','nodeId','versionId'].some(key => typeof request[key as keyof PublishScript] !== 'string' || !(request[key as keyof PublishScript] as string).length || (request[key as keyof PublishScript] as string).length > 200) ||
      !Number.isSafeInteger(request.expectedDraftRevision) || request.expectedDraftRevision < 0 || !Object.hasOwn(textPurposes,request.purpose) || !['new','update'].includes(request.mode) ||
      (request.mode === 'update' && typeof request.targetId !== 'string') || (request.reviewedTargetRevision !== undefined && typeof request.reviewedTargetRevision !== 'string')) throw new ScriptError('发布请求无效');
    const digest = createHash('sha256').update(canonicalJSON(request)).digest('hex');
    return this.db.transaction(() => {
      if (authorize && !authorize(request.mode === 'update' ? request.targetId : undefined)) throw new ScriptError('没有修改该节点的权限，或助手任务已停止',403);
      const graph = getWorkflowById(request.canvasId);
      if (!graph) throw new ScriptError('项目不存在或已删除',404);
      const receipt = this.db.prepare('SELECT digest,result FROM script_publish_receipts WHERE canvas_id=? AND request_id=?').get(request.canvasId,request.requestId) as {digest:string;result:string} | undefined;
      if (receipt) { if (receipt.digest !== digest) throw new ScriptError('发布请求身份已用于其他内容',409); return JSON.parse(receipt.result); }
      const source = (graph.nodes as CanvasNode[]).find(node => node.id === request.nodeId && node.type === NodeType.SCRIPT);
      if (!source) throw new ScriptError('脚本节点已删除',409);
      const draft = this.versions.getPublishableDraft(request.canvasId,request.nodeId,request.versionId,request.expectedDraftRevision);
      const target = this.target(request.canvasId,request.nodeId);
      if (request.mode === 'update') {
        if (!target || target.id !== request.targetId) throw new ScriptError('发布目标已变化，请重新查看原文本',409);
        if (target.deleted || (request.reviewedTargetRevision !== undefined ? target.revision !== request.reviewedTargetRevision : target.changed)) throw new ScriptPublishConflict(target);
      }
      const targetId = request.mode === 'new' ? randomUUID() : request.targetId!;
      const data = { prompt:[{text:draft.draft}],textPurpose:request.purpose,scriptSource:{nodeId:request.nodeId,versionId:request.versionId,draftRevision:request.expectedDraftRevision} };
      const applied = this.canvas.apply(request.canvasId,`script-publish:${request.requestId}`,request.mode === 'new' ? [{ kind:'create',node:{id:targetId,type:NodeType.TEXT,position:{x:source.position.x+440,y:source.position.y},...(source.parentId ? {parentId:source.parentId} : {}),data:{type:NodeType.TEXT,label:textPurposes[request.purpose],...data}} }] : [{kind:'update',id:targetId,data}],`发布${textPurposes[request.purpose]}`);
      const published = (getWorkflowById(request.canvasId)!.nodes as CanvasNode[]).find(n => n.id === targetId)!;
      this.db.prepare('INSERT INTO script_publish_links VALUES(?,?,?,?) ON CONFLICT(canvas_id,node_id) DO UPDATE SET target_id=excluded.target_id,revision=excluded.revision').run(request.canvasId,request.nodeId,targetId,revision(published));
      const result = {targetId,version:applied.version};
      this.db.prepare('INSERT INTO script_publish_receipts VALUES(?,?,?,?)').run(request.canvasId,request.requestId,digest,JSON.stringify(result));
      return result;
    }).immediate();
  }
}
