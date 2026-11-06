import { createHash } from 'node:crypto';
import { getWorkflowById } from '../db/workflows';
import { canonicalJSON } from '../canvas/save-protocol';
import { ScriptPublishingService } from '../script/publishing';
import { textPurposes, type PublishScript } from '../script/publishing-types';
import { getScriptVersionService } from '../script/versions';
import { scriptPresets } from '../script/inputs';
import type { AgentService } from './service';

/** Script creation/connection uses edit_canvas; publishing uses the same service as the console. */
export function registerScriptTools(service: AgentService) {
  const publishing = new ScriptPublishingService();
  const versions = getScriptVersionService();
  service.registerTool({ name: 'read_script', idempotent: true,
    description: 'Read saved script versions, drafts, input snapshots and published target. Generation and editing happen in the script console; never copy a draft through edit_canvas to bypass publishing.',
    inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } }, required: ['nodeId'], additionalProperties: false },
    execute: (task, args) => {
      if (!getWorkflowById(task.projectId)?.nodes.some(node => node.id === args.nodeId && node.type === 'script')) throw new Error('Script node not found');
      return { ...versions.list(task.projectId, String(args.nodeId)), target: publishing.target(task.projectId, String(args.nodeId)), presets: scriptPresets };
    } });
  service.registerTool({ name: 'publish_script', idempotent: true,
    description: 'Explicitly publish a completed selected script draft to a new text node (recommended), or update its linked text. Always asks the user to confirm the exact version and target; changed target requires its reviewed revision. Never starts another creative stage.',
    inputSchema: { type: 'object', properties: {
      nodeId: { type: 'string' }, versionId: { type: 'string' }, expectedDraftRevision: { type: 'integer' },
      purpose: { enum: Object.keys(textPurposes) }, mode: { enum: ['new', 'update'] },
      targetId: { type: 'string' }, reviewedTargetRevision: { type: 'string' },
    }, required: ['nodeId','versionId','expectedDraftRevision','purpose','mode'], additionalProperties: false },
    execute: (task, args, callId) => {
      const request: PublishScript = { ...args as unknown as PublishScript, canvasId: task.projectId,
        requestId: createHash('sha256').update(`${task.id}:${callId}`).digest('hex') };
      const digest = createHash('sha256').update(canonicalJSON({ ...request, requestId: undefined })).digest('hex');
      const question = service.task(task.id).question;
      const confirmed = question?.scope?.kind === 'scriptPublish' && question.scope.digest === digest && !question.cancelled;
      if (confirmed && question.answer && question.answer !== '确认发布') return { cancelled: true };
      if (!confirmed || question.answer !== '确认发布') {
        const draft = versions.getPublishableDraft(task.projectId, request.nodeId, request.versionId, request.expectedDraftRevision);
        const target = publishing.target(task.projectId, request.nodeId);
        if (request.mode === 'update' && (!target || target.id !== request.targetId || target.deleted ||
          (target.changed && request.reviewedTargetRevision !== target.revision))) return { conflict: true, target, recommendation: 'Create a new text node; review the current target before choosing overwrite.' };
        return service.requestQuestion(task.id, callId,
          `发布脚本版本 ${request.versionId}（编辑稿修订 ${request.expectedDraftRevision}）为${textPurposes[request.purpose]}？\n${request.mode === 'new' ? '创建新文本节点。' : `更新已有文本 ${request.targetId}；这将修改该节点的内容。当前文本：\n${target?.text}`}\n待发布正文：\n${draft.draft}`,
          ['取消', '确认发布'], { kind: 'scriptPublish', digest, targetId: request.mode === 'update' ? request.targetId : undefined });
      }
      // A resumed planner may use a new tool call ID. The confirmed question owns
      // one durable publication identity, so replays cannot create another text.
      request.requestId = createHash('sha256').update(`${task.id}:${question.id}`).digest('hex');
      return publishing.publish(request, targetId => {
        // This scoped human confirmation grants only this publication, not general
        // ownership of another user's node. Check both the lease and grant INSIDE the transaction.
        const latest = service.task(task.id).question;
        return service.isExecuting(task) && latest?.scope?.kind === 'scriptPublish' && latest.scope.digest === digest &&
          latest.scope.targetId === targetId && latest.answer === '确认发布' && !latest.cancelled;
      });
    } });
}
