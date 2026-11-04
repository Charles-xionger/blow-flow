import { layoutCanvas } from '../canvas/layout';
import { versionContent } from '../canvas/content-version';
import { validateCanvasParameters } from './canvas-parameters';
import { getGenerationService } from '../generation/server';
import { canvasModels, type CanvasModel } from './canvas-models';
import { createHash } from 'node:crypto';
import { getDatabase } from '../db';
import { getWorkflowById, saveWorkflow } from '../db/workflows';
import { createCanvasHistory, type CanvasHistory } from '../canvas/history';
import { canonicalJSON } from '../canvas/save-protocol';
import { assertCanvasGraph, descendants } from '../canvas/graph';
import { isValidCanvasConnection } from '../canvas/connections';
import { promptSegments, syncReferences } from '../canvas/prompt';
import { assertOriginalMedia } from '../canvas/original-media';
import type { Edge } from '@xyflow/react';
import { NodeType, type CanvasNode, type NodeData } from '../../types';
import type { AgentService } from './service';

export type CanvasOperation =
    | { kind: 'create'; node: CanvasNode }
    | { kind: 'update'; id: string; data: Partial<NodeData> }
    | { kind: 'move'; id: string; position: { x: number; y: number } }
    | { kind: 'delete'; id: string }
    | { kind: 'connect'; edge: Edge }
    | { kind: 'disconnect'; id: string };
export interface CanvasEditResult { version: number; skipped: string[] }

/** Durable semantic edits. Receipt and existing version-checked writer share one transaction. */
export class CanvasAgentService {
    constructor(private models: () => CanvasModel[] = canvasModels) {
        getDatabase().exec('CREATE TABLE IF NOT EXISTS agent_canvas_receipts(project_id TEXT, identity TEXT, digest TEXT, result TEXT, PRIMARY KEY(project_id,identity)); CREATE TABLE IF NOT EXISTS agent_delete_permissions(message_id TEXT PRIMARY KEY)');
    }
    receipt(projectId: string, identity: string): CanvasEditResult | undefined {
        if (!getWorkflowById(projectId)) throw new Error('Project deleted');
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
            let state = { nodes: current.nodes as CanvasNode[], edges: current.edges, projectName: current.name, canvasSession: 0, history: current.history as CanvasHistory | undefined };
            const history = createCanvasHistory(() => state, update => { state = { ...state, ...update } as typeof state; });
            const skipped: string[] = [];
            history.begin(identity);
            operations.forEach((operation, index) => {
                let { nodes, edges } = state;
                const beforeEdges = edges;
                if (operation.kind === 'create') {
                    if (nodes.some(node => node.id === operation.node?.id)) throw new Error('Node already exists');
                    if (getDatabase().prepare('SELECT 1 FROM canvas_deleted_nodes WHERE canvas_id=? AND node_id=?').get(projectId, operation.node?.id)) throw new Error('Node identity was deleted');
                    assertOriginalMedia(operation.node.data);
                    const node = validateInput ? { ...operation.node, data: { ...operation.node.data, ...validateCanvasParameters(operation.node.data, operation.node.data, this.models()) } } : operation.node;
                    nodes = [...nodes, node];
                } else if (operation.kind === 'connect') {
                    if (!isValidCanvasConnection(operation.edge, nodes, edges)) throw new Error('Invalid connection');
                    edges = [...edges, operation.edge];
                } else if (operation.kind === 'disconnect') {
                    edges = edges.filter(edge => edge.id !== operation.id);
                } else {
                    const node = nodes.find(node => node.id === operation.id);
                    if (!node) { skipped.push(`${operation.id}: target deleted or absent`); return; }
                    if (operation.kind === 'update') {
                        assertOriginalMedia(operation.data);
                        const data = validateInput ? validateCanvasParameters(node.data, operation.data, this.models()) : operation.data;
                        nodes = nodes.map(value => value.id === node.id ? { ...value, data: { ...value.data, ...data }, ...(operation.data.type ? { type: operation.data.type } : {}) } : value);
                        edges = edges.filter(edge => isValidCanvasConnection(edge, nodes, edges.filter(other => other.id !== edge.id)));
                    } else if (operation.kind === 'move') {
                        nodes = nodes.map(value => value.id === node.id ? { ...value, position: operation.position } : value);
                    } else if (operation.kind === 'delete') {
                        const removed = descendants(nodes, [node.id]);
                        edges = edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target));
                        nodes = syncReferences(nodes, beforeEdges, edges).filter(value => !removed.has(value.id));
                    } else throw new Error('Unknown canvas operation');
                }
                nodes = syncReferences(nodes, beforeEdges, edges);
                assertCanvasGraph(nodes, edges);
                nodes = versionContent(state.nodes, nodes, edges, undefined, state.edges);
                history.change({ nodes, edges }, { record: true, id: `${identity}:${index}`, source: 'agent', label });
            });
            history.end();
            if (validateInput) for (const node of state.nodes) for (const segment of promptSegments(node.data.prompt)) {
                if ('ref' in segment && !state.edges.some(edge => edge.target === node.id && edge.source === segment.ref)) throw new Error('Prompt reference requires an upstream connection');
            }
            const ack = saveWorkflow({ id: projectId, requestId: `agent:${createHash('sha256').update(identity).digest('hex')}`, baseVersion: current.version,
                snapshot: { name: current.name, nodes: state.nodes, edges: state.edges, viewport: current.viewport, history: state.history } });
            const remaining = new Set(state.nodes.map(node => node.id));
            for (const node of current.nodes) if (!remaining.has(node.id)) getGenerationService().deleteNode(projectId, String(node.data.generationNodeId ?? node.id));
            const result = { version: ack.version, skipped };
            getDatabase().prepare('INSERT INTO agent_canvas_receipts VALUES(?,?,?,?)').run(projectId, identity, digest, JSON.stringify(result));
            return result;
        }).immediate();
    }
}

export function registerCanvasTools(service: AgentService, models: () => CanvasModel[] = canvasModels) {
    const canvas = new CanvasAgentService(models);
    service.registerTool({ idempotent: true, name: 'edit_canvas', description: 'Apply a complete creative step as one undo batch. Operations: create {node}, update {id,data}, move {id,position}, connect {edge}, disconnect {id}. Use current project node IDs.',
        inputSchema: { type: 'object', properties: { label: { type: 'string' }, operations: { type: 'array', items: { type: 'object', properties: { kind: { enum: ['create', 'update', 'move', 'connect', 'disconnect'] }, id: { type: 'string' }, node: { type: 'object', properties: { id: { type: 'string' }, type: { enum: Object.values(NodeType) }, data: { type: 'object' }, parentId: { type: 'string' }, style: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, additionalProperties: false } }, required: ['id', 'type', 'data'], additionalProperties: false }, data: { type: 'object', description: 'Editable node fields: label, customTitle, type, prompt (text or [{text},{ref}]), model, generationWidth/Height/SizePreset, aspectRatio, videoResolution/AspectRatio/Duration/InstanceType, storyboardShots, optimizedPrompt. Discover model capabilities first.' }, position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false }, edge: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' }, target: { type: 'string' } }, required: ['id', 'source', 'target'], additionalProperties: false } }, required: ['kind'], additionalProperties: false } } }, required: ['operations'], additionalProperties: false },
        execute: async (task, args, callId) => {
            const receipt = canvas.receipt(task.projectId, `${task.id}:${callId}`);
            if (receipt) return receipt;
            let operations = args.operations as CanvasOperation[];
            if (!Array.isArray(operations) || operations.length > 100) throw new Error('Operations required');
            if (operations.some(operation => operation.kind === 'delete')) throw new Error('Deletion requires user permission');
            const current = getWorkflowById(task.projectId);
            if (!current) throw new Error('Project deleted');
            const creates = operations.filter(op => op.kind === 'create');
            if (creates.length) {
                for (const op of creates) {
                    if (!op.node || typeof op.node.id !== 'string' || !Object.values(NodeType).includes(op.node.type!)) throw new Error('Invalid new node');
                    if (op.node.id.length > 200 || !op.node.id || op.node.style && Object.entries(op.node.style).some(([key, value]) => !['width', 'height'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 40 || value > 6000)) throw new Error('Invalid node dimensions');
                    if (Object.keys(op.node).some(key => !['id', 'type', 'data', 'position', 'style', 'parentId', 'extent'].includes(key))) throw new Error('Unsupported node field');
                }
                const nodes = [...current.nodes as CanvasNode[], ...creates.map(op => ({ ...op.node, position: { x: 0, y: 0 } }))];
                const edges = [...current.edges, ...operations.flatMap(op => op.kind === 'connect' ? [op.edge] : [])];
                const addedIds = new Set(creates.map(op => op.node.id));
                const relation = edges.find(edge => addedIds.has(edge.source) !== addedIds.has(edge.target));
                const nearId = relation ? addedIds.has(relation.source) ? relation.target : relation.source : undefined;
                const arranged = await layoutCanvas(nodes, edges, [...addedIds], true, nearId);
                operations = operations.map(op => op.kind === 'create' ? { ...op, node: arranged.find(node => node.id === op.node.id)! } : op);
            }
            if (!service.isExecuting(task)) throw new Error('Task stopped');
            return canvas.apply(task.projectId, `${task.id}:${callId}`, operations, args.label as string | undefined, true, current.version, () => service.isExecuting(task));
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
