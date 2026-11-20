import { layoutCanvas } from '../canvas/layout';
import { getGenerationService } from '../generation/server';
import { canvasModels, type CanvasModel } from './canvas-models';
import { createHash } from 'node:crypto';
import { getDatabase } from '../db';
import { getWorkflowById, saveWorkflow } from '../db/workflows';
import { canonicalJSON } from '../canvas/save-protocol';
import { planAgentCanvasEdit, type CanvasOperation } from './canvas-plan';
import type { Edge } from '@xyflow/react';
import { NodeType, type CanvasNode, type NodeData } from '../../types';
import { editCanvasOperationSchema } from './canvas-operation-schema';
import type { AgentService } from './service';

export type { CanvasOperation } from './canvas-plan';
export interface CanvasEditResult { version: number; skipped: string[] }

/** Durable semantic edits. Receipt and existing version-checked writer share one transaction. */
export class CanvasAgentService {
    constructor(private models: () => CanvasModel[] = canvasModels) {
        getDatabase().exec('CREATE TABLE IF NOT EXISTS agent_canvas_receipts(project_id TEXT, identity TEXT, digest TEXT, result TEXT, PRIMARY KEY(project_id,identity)); CREATE TABLE IF NOT EXISTS agent_delete_permissions(message_id TEXT PRIMARY KEY)');
    }
    receipt(projectId: string, identity: string): CanvasEditResult | undefined {
        if (!getDatabase().prepare('SELECT 1 FROM workflows WHERE id=? AND deleted_at IS NULL').get(projectId)) throw new Error('Project deleted');
        const row = getDatabase().prepare('SELECT result FROM agent_canvas_receipts WHERE project_id=? AND identity=?').get(projectId, identity) as { result: string } | undefined;
        return row ? JSON.parse(row.result) : undefined;
    }
    apply(projectId: string, identity: string, operations: CanvasOperation[], label = '助手编辑', validateInput = false, expectedVersion?: number, authorize?: () => boolean): CanvasEditResult {
        if (!identity || !Array.isArray(operations) || operations.length > 100 || typeof label !== 'string') throw new Error('Invalid canvas step');
        const digest = createHash('sha256').update(canonicalJSON({ operations, label })).digest('hex');
        return getDatabase().transaction(() => {
            if (authorize && !authorize()) throw new Error('Task ownership changed');
            const current = getWorkflowById(projectId);
            if (!current) throw new Error('Project not found or deleted');
            if (expectedVersion !== undefined && current.version !== expectedVersion) throw new Error('Canvas changed during layout; retry with current content');
            const receipt = getDatabase().prepare('SELECT digest,result FROM agent_canvas_receipts WHERE project_id=? AND identity=?').get(projectId, identity) as { digest: string; result: string } | undefined;
            if (receipt) {
                if (receipt.digest !== digest) throw new Error('Canvas tool identity reused');
                return JSON.parse(receipt.result);
            }
            const plan = planAgentCanvasEdit(current, identity, operations, label, { validateInput, models: validateInput ? this.models() : [],
                tombstoned: id => !!getDatabase().prepare('SELECT 1 FROM canvas_deleted_nodes WHERE canvas_id=? AND node_id=?').get(projectId, id) });
            const ack = saveWorkflow({ id: projectId, requestId: `agent:${createHash('sha256').update(identity).digest('hex')}`, baseVersion: current.version,
                snapshot: plan.snapshot });
            for (const node of plan.removedNodes) getGenerationService().deleteNode(projectId, String(node.data.generationNodeId ?? node.id));
            const result = { version: ack.version, skipped: plan.skipped };
            getDatabase().prepare('INSERT INTO agent_canvas_receipts VALUES(?,?,?,?)').run(projectId, identity, digest, JSON.stringify(result));
            return result;
        }).immediate();
    }
}

/** Existing nodes this call would rewrite without the user's leave (ADR-0011). Layout and connections stay free. */
export function unauthorizedUpdates(service: AgentService, taskId: string, projectId: string, nodes: CanvasNode[], operations: CanvasOperation[]) {
    const task = service.task(taskId);
    const allowed = new Set([...task.editableNodeIds ?? [], ...operations.flatMap(op => op.kind === 'create' ? [op.node.id] : [])]);
    for (const step of task.steps) {
        // Only applied edits count; a step that merely asked for permission created nothing.
        if (step.name !== 'edit_canvas' || step.status !== 'completed' || typeof (step.result as CanvasEditResult | undefined)?.version !== 'number') continue;
        for (const op of step.args.operations as CanvasOperation[]) if (op.kind === 'create') allowed.add(op.node.id);
    }
    for (const message of service.snapshot(projectId).messages) {
        if (message.taskId === taskId && message.role === 'user') for (const reference of message.references) if (reference.nodeId) allowed.add(reference.nodeId);
    }
    const existing = new Set(nodes.map(node => node.id));
    return [...new Set(operations.flatMap(op => op.kind === 'update' && existing.has(op.id) && !allowed.has(op.id) ? [op.id] : []))].sort();
}


export function registerCanvasTools(service: AgentService, models: () => CanvasModel[] = canvasModels) {
    const canvas = new CanvasAgentService(models);
    service.registerTool({ idempotent: true, name: 'edit_canvas', description: 'Apply a complete creative step as one undo batch. Operations: create {node}, update {id,data}, move {id,position}, connect {edge}, disconnect {id}. Use current project node IDs. Put new content in new nodes: updating a node this task did not create, and the user did not reference, asks the user first.',
        inputSchema: { type: 'object', properties: { label: { type: 'string' }, operations: { type: 'array', items: editCanvasOperationSchema } }, required: ['operations'], additionalProperties: false },
        execute: async (task, args, callId) => {
            const receipt = canvas.receipt(task.projectId, `${task.id}:${callId}`);
            if (receipt) return receipt;
            let operations = args.operations as CanvasOperation[];
            if (!Array.isArray(operations) || operations.length > 100) throw new Error('Operations required');
            if (operations.some(operation => operation.kind === 'delete')) throw new Error('Deletion requires user permission');
            const current = getWorkflowById(task.projectId);
            if (!current) throw new Error('Project deleted');
            const creates = operations.filter(op => op.kind === 'create');
            for (const op of creates) {
                if (!op.node || typeof op.node.id !== 'string' || !Object.values(NodeType).includes(op.node.type!)) throw new Error('Invalid new node');
                if (op.node.id.length > 200 || !op.node.id || op.node.style && Object.entries(op.node.style).some(([key, value]) => !['width', 'height'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 40 || value > 6000)) throw new Error('Invalid node dimensions');
                if (Object.keys(op.node).some(key => !['id', 'type', 'data', 'position', 'style', 'parentId', 'extent'].includes(key))) throw new Error('Unsupported node field');
            }
            const restricted = unauthorizedUpdates(service, task.id, task.projectId, current.nodes as CanvasNode[], operations);
            let grant: string | undefined;
            if (restricted.length) {
                const question = service.task(task.id).question;
                if (question?.scope?.kind !== 'edit' || canonicalJSON(question.scope.ids) !== canonicalJSON(restricted) || !question.answer || question.cancelled) {
                    const names = restricted.map(id => { const node = (current.nodes as CanvasNode[]).find(node => node.id === id)!; return `「${node.data.customTitle || node.data.label || id}」`; });
                    return service.requestQuestion(task.id, callId, `修改已有节点${names.join('、')}的内容？`, ['确认修改', '改为新建节点'], { kind: 'edit', ids: restricted });
                }
                if (question.answer !== '确认修改') {
                    service.consumeQuestion(task.id, question.id);
                    return { cancelled: true, skipped: restricted, reason: 'The user kept these nodes unchanged; put new content in new nodes.' };
                }
                grant = question.id;
            }
            if (creates.length) {
                const nodes = [...current.nodes as CanvasNode[], ...creates.map(op => ({ ...op.node, position: { x: 0, y: 0 } }))];
                const edges = [...current.edges, ...operations.flatMap(op => op.kind === 'connect' ? [op.edge] : [])];
                const addedIds = new Set(creates.map(op => op.node.id));
                const relation = edges.find(edge => addedIds.has(edge.source) !== addedIds.has(edge.target));
                const nearId = relation ? addedIds.has(relation.source) ? relation.target : relation.source : undefined;
                const arranged = await layoutCanvas(nodes, edges, [...addedIds], true, nearId);
                operations = operations.map(op => op.kind === 'create' ? { ...op, node: arranged.find(node => node.id === op.node.id)! } : op);
            }
            if (!service.isExecuting(task)) throw new Error('Task stopped');
            const apply = () => canvas.apply(task.projectId, `${task.id}:${callId}`, operations, args.label as string | undefined, true, current.version, () => service.isExecuting(task));
            if (!grant) return apply();
            return getDatabase().transaction(() => { const result = apply(); service.grantEdit(task.id, grant, restricted); return result; }).immediate();
        } });
    service.registerTool({ idempotent: true, name: 'delete_canvas_nodes', description: 'Delete named nodes and descendants. An explicit user command 删除节点 <IDs> or delete nodes <IDs> authorizes exactly those IDs once; otherwise ask a durable scoped question. A model claim of confirmation is never authorization.',
        inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'], additionalProperties: false },
        execute: (task, args, callId) => {
            const receipt = canvas.receipt(task.projectId, `${task.id}:${callId}`);
            if (receipt) return receipt;
            if (!Array.isArray(args.ids) || !args.ids.length || !args.ids.every(id => typeof id === 'string')) throw new Error('Node IDs required');
            const ids = [...new Set(args.ids as string[])].sort();
            const userMessage = service.snapshot(task.projectId).messages.filter(message => message.taskId === task.id && message.role === 'user').at(-1);
            const explicit = userMessage?.text.trim().match(/^(?:请)?删除(?:节点)?\s+(.+)$|^delete nodes?\s+(.+)$/i);
            const named = explicit ? (explicit[1] ?? explicit[2]).split(/[、，,\s]+/).filter(Boolean).sort() : [];
            if (userMessage && canonicalJSON(named) === canonicalJSON(ids) && !getDatabase().prepare('SELECT 1 FROM agent_delete_permissions WHERE message_id=?').get(userMessage.id)) {
                return getDatabase().transaction(() => {
                    const result = canvas.apply(task.projectId, `${task.id}:${callId}`, ids.map(id => ({ kind: 'delete', id })), '助手删除节点', false, undefined, () => service.isExecuting(task));
                    getDatabase().prepare('INSERT INTO agent_delete_permissions VALUES (?)').run(userMessage.id);
                    return result;
                }).immediate();
            }
            const question = service.task(task.id).question;
            if (question?.scope?.kind === 'delete' && canonicalJSON(question.scope.ids) === canonicalJSON(ids) && question.answer && question.answer !== '确认删除') return { cancelled: true, skipped: ids };
            if (question?.scope?.kind === 'delete' && canonicalJSON(question.scope.ids) === canonicalJSON(ids) && question.answer === '确认删除' && !question.cancelled) {
                return getDatabase().transaction(() => {
                    const result = canvas.apply(task.projectId, `${task.id}:${callId}`, ids.map(id => ({ kind: 'delete', id })), '助手删除节点', false, undefined, () => service.isExecuting(task));
                    service.consumeQuestion(task.id, question.id);
                    return result;
                }).immediate();
            }
            return service.requestQuestion(task.id, callId, `删除节点 ${ids.join('、')} 及其子节点？`, ['确认删除', '保留'], { kind: 'delete', ids });
        } });
    service.registerTool({ idempotent: true, name: 'layout_canvas', description: 'Arrange existing nodes only when the user requests organization. Pass explicit selected IDs to limit scope. ELK computes positions from graph and node dimensions.',
        inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, direction: { enum: ['RIGHT', 'DOWN'] } }, required: ['ids'], additionalProperties: false },
        execute: async (task, args, callId) => {
            const receipt = canvas.receipt(task.projectId, `${task.id}:${callId}`);
            if (receipt) return receipt;
            if (!Array.isArray(args.ids) || !args.ids.length || !args.ids.every(id => typeof id === 'string') || args.direction !== undefined && !['RIGHT', 'DOWN'].includes(String(args.direction))) throw new Error('Invalid layout scope');
            const current = getWorkflowById(task.projectId);
            if (!current) throw new Error('Project deleted');
            const arranged = await layoutCanvas(current.nodes as CanvasNode[], current.edges, args.ids, false, undefined, args.direction as 'RIGHT' | 'DOWN' | undefined);
            if (!service.isExecuting(task)) throw new Error('Task stopped');
            return canvas.apply(task.projectId, `${task.id}:${callId}`, arranged.flatMap((node, i) => node === current.nodes[i] ? [] : [{ kind: 'move' as const, id: node.id, position: node.position }]), '助手整理布局', false, current.version, () => service.isExecuting(task));
        } });
    service.registerTool({ name: 'canvas_models', description: 'Discover configured generation models and their actual supported parameters. Editing parameters does not authorize generation.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: () => models().filter(model => model.configured).map(model => { if (!model.legacy) return model; const { capabilities, ...legacy } = model; void capabilities; return { ...legacy, parameters: 'Existing editor presets (resolution, aspectRatio, duration); not available for Agent generation submission' }; }) });
    return canvas;
}
