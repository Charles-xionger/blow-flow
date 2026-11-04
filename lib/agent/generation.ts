import { geminiImageParameters } from '../generation/gemini-image';
import { getDatabase } from '../db';
import { getAgentGenerationService } from '../generation/server';
import type { GenerationService } from '../generation/service';
import type { CreateGeneration, GenerationInput } from '../generation/types';
import type { AgentService } from './service';
import { CanvasAgentService } from './canvas';
import type { CanvasNode } from '../../types';

type Item = { nodeId: string; modelId: string; input: GenerationInput };
type Batch = { id: string; taskId: string; projectId: string; status: 'pending' | 'approved' | 'cancelled'; items: { request: CreateGeneration; taskId?: string; attached?: boolean; saveRetries?: number; nextSaveRetry?: number; note?: string }[] };
/** The persisted batch, not the model transcript, authorizes exact normalized requests. */
export function registerGenerationTools(service: AgentService, generation: GenerationService = getAgentGenerationService()) {
    const db = generation.db;
    const canvas = new CanvasAgentService();
    db.exec('CREATE TABLE IF NOT EXISTS agent_generation_batches(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL)');
    const save = (batch: Batch) => db.prepare('INSERT INTO agent_generation_batches VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(batch.id, batch.taskId, JSON.stringify(batch));
    const batches = (taskId?: string): Batch[] => (taskId ? db.prepare('SELECT data FROM agent_generation_batches WHERE task_id=?').all(taskId) : db.prepare('SELECT data FROM agent_generation_batches').all() as unknown[]).map(row => JSON.parse((row as {data:string}).data));
    service.generationSummary = projectId => batches().filter(batch => batch.projectId === projectId).map(batch => ({ id:batch.id, taskId:batch.taskId, status:batch.status, items:batch.items.map(item => ({nodeId:item.request.nodeId,note:item.note,task:item.taskId ? generation.get(item.taskId) : undefined})) }));
    service.generationPending = taskId => batches(taskId).some(batch => batch.items.some(item => {
        if (!item.taskId) return false;
        const task = generation.get(item.taskId);
        return !!item.nextSaveRetry || ['queued','submitting','running'].includes(task.status) || task.status === 'succeeded' && ['pending','saving'].includes(task.saveStatus);
    }));
    function revoke(taskId: string) {
        for (const batch of batches(taskId)) {
            generation.cancelRequests(batch.items.map(item => item.request.requestId));
            batch.status = 'cancelled'; save(batch);
        }
    }
    function reconcile() {
        db.transaction(() => {
        for (const batch of batches()) {
            let changed = false;
            for (const item of batch.items) {
                if (!item.taskId || item.attached) continue;
                const task = generation.get(item.taskId);
                if (task.status === 'succeeded' && task.saveStatus === 'failed' && (item.saveRetries ?? 0) < 3) {
                    if (!item.nextSaveRetry) { item.nextSaveRetry = Date.now() + 5000 * 2 ** (item.saveRetries ?? 0); changed = true; }
                    else if (item.nextSaveRetry <= Date.now()) { generation.retrySave(task.id); item.saveRetries = (item.saveRetries ?? 0) + 1; delete item.nextSaveRetry; changed = true; }
                }
                if (task.saveStatus === 'saved' && item.nextSaveRetry) { delete item.nextSaveRetry; changed = true; }
                if (task.saveStatus !== 'saved' || !task.artifacts.length) continue;
                if (!generation.isLatestForTarget(task.id)) {
                    item.attached = true; item.note = '已有较新的生成任务；产物保留在生成任务中。'; changed = true; continue;
                }
                // Do not register browser generation recovery: this receipt is the sole attachment owner.
                try {
                    const result = db.transaction(() => {
                        const before = (service.canvas(batch.projectId).nodes as CanvasNode[]).find(node => node.id === item.request.nodeId)?.data.generationContentVersion ?? 0;
                        const result = canvas.apply(batch.projectId, `generation-output:${task.id}`, [{ kind: 'update', id: item.request.nodeId,
                            data: { [task.outputType === 'video' ? 'videoSrc' : 'imageSrc']: task.artifacts[0], outputArtifacts: task.artifacts } }], '助手生成结果');
                        const after = (service.canvas(batch.projectId).nodes as CanvasNode[]).find(node => node.id === item.request.nodeId)?.data.generationContentVersion ?? 0;
                        // Own output attachment cannot revoke sibling items whose approved inputs stay frozen.
                        // Only advance a matching baseline; an intervening human edit must still invalidate approval.
                        if (after !== before) for (const sibling of batch.items) {
                            generation.permissions.advanceBinding(sibling.request.requestId, item.request.nodeId, before, after);
                        }
                        return result;
                    }).immediate();
                    item.note = result.skipped.length ? '目标节点已删除；产物保留在生成任务中。' : '结果已写回画布';
                    item.attached = true; changed = true;
                } catch {
                    // A deleted project cannot be resurrected. Transient persistence failures retry this same receipt.
                    const row = getDatabase().prepare('SELECT 1 FROM workflows WHERE id=? AND deleted_at IS NULL').get(batch.projectId);
                    if (!row) { item.attached = true; item.note = '项目已删除；产物保留在生成任务中。'; changed = true; }
                }
            }
            if (changed) save(batch);
            service.wakeAfterGeneration(batch.taskId);
        }
        }).immediate();
    }
    service.registerLifecycle({
        send(task) { revoke(task.id); if (task.question?.scope?.kind === 'generation' && !task.question.answer) { task.question.cancelled = true; task.status = 'queued'; } },
        stop(task) { revoke(task.id); },
        answer(task, text) {
            if (task.question?.scope?.kind !== 'generation') return;
            const batch = batches(task.id).find(batch => batch.id === task.question!.id);
            if (!batch || batch.status !== 'pending') throw new Error('生成方案已失效，请重新准备');
            if (text !== '确认生成') { revoke(task.id); return; }
            for (const item of batch.items) {
                // Queue and grant permission atomically with the user's persisted answer.
                generation.permissions.approve(item.request.requestId);
                item.taskId = generation.create(item.request).id;
            }
            batch.status = 'approved'; save(batch);
        },
        tick: reconcile,
    });
    service.registerTool({ name: 'generation_models', description: 'Discover available image/video generation models and exact supported capabilities.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: () => generation.models().filter(model => model.configured) });
    service.registerTool({ idempotent: true, name: 'prepare_generation', description: 'Prepare an explicit batch of image/video operations for user approval. Each item produces one generation task. Inputs are frozen and validated. Always request a new approval for changed requirements or retries; never claim user approval.',
        inputSchema: { type: 'object', properties: { items: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { nodeId: { type: 'string' }, modelId: { type: 'string' }, input: { type: 'object', properties: { prompt: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, duration: { type: 'number' }, instanceType: { enum: ['plus'] }, references: { type: 'array', items: { type: 'object', properties: { kind: { enum: ['image','video','audio'] }, url: { type: 'string' }, useAudio: { type: 'boolean' } }, required: ['kind','url'], additionalProperties: false } } }, required: ['prompt','width','height'], additionalProperties: false } }, required: ['nodeId','modelId','input'], additionalProperties: false } } }, required: ['items'], additionalProperties: false },
        execute(task, args, callId) {
            const id = `${task.id}:${callId}`;
            const existing = batches(task.id).find(batch => batch.id === id);
            if (existing) return { batchId: id, status: existing.status };
            if (Object.keys(args).some(key => key !== 'items') || !Array.isArray(args.items) || !args.items.length || args.items.length > 20) throw new Error('Explicit generation items required');
            const graph = service.canvas(task.projectId) as {nodes:CanvasNode[];edges:{source:string;target:string}[]};
            const items = (args.items as Item[]).map((item, index) => {
                if (!item || Object.keys(item).some(key => !['nodeId','modelId','input'].includes(key))) throw new Error('Invalid generation item');
                const node = graph.nodes.find(node => node.id === item.nodeId);
                const model = generation.models().find(model => model.id === item.modelId);
                if (!node || !model || (model.category === 'IMAGE' ? !['textToImage','imageToImage','image'].includes(node.data.type) : !['textToVideo','imageToVideo','startEndToVideo','video'].includes(node.data.type))) throw new Error('Invalid generation target');
                const request = generation.validate({ ...item, requestId: `agent-generation:${id}:${index}`, canvasId: task.projectId });
                const related = new Set([item.nodeId]);
                let size = 0;
                while (size !== related.size) { size = related.size; for (const edge of graph.edges) if (related.has(edge.target)) related.add(edge.source); }
                return { request, bindings: graph.nodes.filter(node => related.has(node.id)).map(node => ({id:node.id,version:node.data.generationContentVersion ?? 0})) };
            });
            return db.transaction(() => {
                if (!service.isExecuting(task)) throw new Error('Task ownership changed');
                revoke(task.id);
                for (const item of items) generation.permissions.prepare(task.id, item.request, item.bindings);
                const batch: Batch = { id, taskId: task.id, projectId: task.projectId, status: 'pending', items: items.map(item => ({request:item.request})) };
                save(batch);
                const scope = items.map(({request}) => { const model = generation.config.models.find(model => model.id === request.modelId)!; const preset = model.adapter === 'gemini-image' ? geminiImageParameters(request.input) : undefined; return {nodeId:request.nodeId,modelId:request.modelId,input:request.input,specification:preset ? `${preset.size} · ${preset.aspectRatio}（实际像素尺寸由模型决定）` : `${request.input.width} × ${request.input.height}`}; });
                return { ...service.requestQuestion(task.id, id, `确认生成这 ${items.length} 项内容？`, ['确认生成','取消生成'], {kind:'generation',items:scope}), batchId:id };
            }).immediate();
        } });
    service.registerTool({ idempotent: true, name: 'generation_results', description: 'Read generation results including saved original artifacts and failures. Set wait=true to continue after this batch finishes in the background. Uncertain submissions are never resubmitted. retrySave retries only saving existing successful output.',
        inputSchema: { type: 'object', properties: { batchId: { type: 'string' }, wait: { type: 'boolean' }, retrySave: { type: 'boolean' } }, required: ['batchId'], additionalProperties: false },
        async execute(task,args) {
            while (true) {
                reconcile();
                const batch = batches(task.id).find(batch => batch.id === args.batchId);
                if (!batch) throw new Error('Batch not found in this task');
                const items = batch.items.map(item => ({nodeId:item.request.nodeId,note:item.note,task:item.taskId ? generation.get(item.taskId) : undefined}));
                if (args.retrySave) for (const item of items) if (item.task?.status === 'succeeded' && item.task.saveStatus === 'failed') generation.retrySave(item.task.id);
                if (!args.wait || batch.status !== 'approved' || items.every(item => item.task && (['failed','uncertain','timed_out','cancelled'].includes(item.task.status) || item.task.status === 'succeeded' && ['saved','failed'].includes(item.task.saveStatus)))) return {batchId:batch.id,status:batch.status,items};
                if (!service.isExecuting(task)) return {stopped:true,items};
                await new Promise(resolve => setTimeout(resolve,250));
            }
        } });
    return { reconcile };
}
