import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { layoutCanvas } from '../canvas/layout';
import { createHash } from 'node:crypto';
import { resolveReferenceFromCanvas } from './references';
import { GoCanvasEditor } from './go-canvas';
import { goCanvasModels } from './go-canvas-models';
import { editCanvasOperationSchema } from './canvas-operation-schema';
import { GoAgentRun, GoAgentRunClient, type GoGenerationItem } from './go-runner-client';
import { createPiRuntimeForHost, type PiRuntimeHost } from './runtime';
import { listBuiltInSkills, readBuiltInSkill } from './skills';
import type { AgentReference, AgentTask } from './types';
import type { CanvasOperation } from './canvas-plan';
import { NodeType, type CanvasNode } from '../../types';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const definitions = [
  { name: 'read_canvas', description: 'Read the current project canvas.', inputSchema: object({}) },
  { name: 'read_reference', description: 'Read a node and inspect its image content.', inputSchema: object({ nodeId: { type: 'string' } }, ['nodeId']) },
  { name: 'discover_skills', description: 'Discover current creative skills by ID and description before loading their instructions.', inputSchema: object({}) },
  { name: 'read_skill', description: 'Load one discovered creative skill or a named resource only when needed.', inputSchema: object({ id: { type: 'string' }, resource: { type: 'string' } }, ['id']) },
  { name: 'edit_canvas', description: 'Edit the project canvas as one undoable batch. Create new nodes for new content. Existing node content needs user permission.',
    inputSchema: object({ label: { type: 'string' }, operations: { type: 'array', items: editCanvasOperationSchema, maxItems: 100 } }, ['operations']) },
  { name: 'delete_canvas_nodes', description: 'Delete named nodes and descendants after exact user authorization.', inputSchema: object({ ids: { type: 'array', minItems: 1, items: { type: 'string' } } }, ['ids']) },
  { name: 'layout_canvas', description: 'Arrange existing nodes on the canvas.', inputSchema: object({ ids: { type: 'array', minItems: 1, items: { type: 'string' } }, direction: { enum: ['RIGHT', 'DOWN'] } }, ['ids']) },
  { name: 'canvas_models', description: 'Discover configured canvas models and parameters.', inputSchema: object({}) },
  { name: 'generation_models', description: 'Discover image and video models supported by Go generation, including reference and size capabilities.', inputSchema: object({}) },
  { name: 'ask_question', description: 'Ask the user a critical question and wait for an answer.', inputSchema: object({ text: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['text']) },
  { name: 'prepare_generation', description: 'Freeze an image or video batch and wait for explicit approval. A target with an existing result receives a sibling node. References and options are part of the frozen request.', inputSchema: object({ items: { type: 'array', minItems: 1, maxItems: 20, items: object({ nodeId: { type: 'string' }, modelId: { type: 'string' }, input: object({ prompt: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, duration: { type: 'integer' }, references: { type: 'array', items: object({ kind: { enum: ['image','video','audio'] }, url: { type: 'string' }, useAudio: { type: 'boolean' } }, ['kind','url']) }, instanceType: { enum: ['plus'] }, imageOptions: object({ outputFormat: { enum: ['png','jpeg'] }, watermark: { type: 'boolean' }, promptOptimization: { enum: ['standard','fast'] }, background: { enum: ['opaque','transparent'] } }) }, ['prompt','width','height']) }, ['nodeId','modelId','input']) } }, ['items']) },
  { name: 'generation_results', description: 'Read a previously approved batch. wait polls durable status through missed notifications. retrySave resumes saving the same provider output; it never submits generation again.', inputSchema: object({ batchId: { type: 'string' }, wait: { type: 'boolean' }, retrySave: { type: 'boolean' } }, ['batchId']) },
] as const;

export class GoPiHost implements PiRuntimeHost {
  constructor(private run: GoAgentRun, private task: AgentTask, private flushReplies: () => Promise<unknown> = async () => {}) {}
  isExecuting = (task: AgentTask) => this.run.isAlive() && task.id === this.task.id;
  listSkillDescriptions = async () => [...listBuiltInSkills(), ...await this.run.skills()];
  resolveReference = async (projectId: string, reference: AgentReference, options: { historical?: boolean }) => {
    if (projectId !== this.task.projectId) throw new Error('Run project mismatch');
    const canvas = await this.run.canvas(projectId).read(projectId);
    return resolveReferenceFromCanvas(canvas.snapshot as Parameters<typeof resolveReferenceFromCanvas>[0], reference, options);
  };

  private async execute(name: string, args: Record<string, unknown>, callId: string) {
    const projectId = this.task.projectId;
    const scope = this.task.question?.scope;
    const matchingQuestion = (kind: 'edit' | 'delete', ids: string[]) => scope?.kind === kind && JSON.stringify(scope.ids) === JSON.stringify(ids) ? this.task.question : undefined;
    if (name === 'ask_question') {
      if (typeof args.text !== 'string' || !args.text.trim() || args.options !== undefined && (!Array.isArray(args.options) || !args.options.every(value => typeof value === 'string'))) throw new Error('Invalid question');
      await this.flushReplies();
      await this.run.question({ id: callId, text: args.text, options: args.options as string[] ?? [] });
      return { waiting: true, questionId: callId };
    }
    if (name === 'prepare_generation') {
      if (!Array.isArray(args.items) || !args.items.length || args.items.length > 20) throw new Error('Generation items required');
      await this.flushReplies();
      const step = await this.run.startStep(callId, name, args);
      if (step.status === 'completed') return step.result;
      if (step.status !== 'running' || step.runId !== this.task.runId) throw new Error('Previous generation preparation requires reconciliation');
      const batch = await this.run.prepareGeneration(callId, args.items as GoGenerationItem[]);
      return { waiting: true, batchId: batch.id, digest: batch.digest };
    }
    const step = await this.run.startStep(callId, name, args);
    if (step.status === 'completed') return step.result;
    if (step.status === 'failed') throw new Error('Previous tool attempt failed');
    if (step.runId !== this.task.runId) throw new Error('Previous tool outcome requires reconciliation');
    let intended: { operations: CanvasOperation[]; label: string } | undefined;
    try {
      let result: unknown;
      switch (name) {
        case 'canvas_models': {
          result = goCanvasModels().filter(model => model.configured).map(model => { if (!model.legacy) return model; const { capabilities, ...legacy } = model; void capabilities; return { ...legacy, parameters: 'Existing editor presets (resolution, aspectRatio, duration); not available for Agent generation submission' }; });
          break;
        }
        case 'generation_models': {
          const names: Record<string,string> = { 'runninghub-krea2': 'runninghub/krea2', 'runninghub-h3': 'runninghub/h3' };
          result = goCanvasModels().filter(model => model.configured && !model.legacy).map(model => ({ ...model, id: names[model.id] ?? model.id }));
          break;
        }
        case 'discover_skills': {
          result = (await this.listSkillDescriptions()).map(({ id, name, description }) => ({ id, name, description }));
          break;
        }
        case 'read_skill': {
          if (typeof args.id !== 'string' || !args.id || args.resource !== undefined && typeof args.resource !== 'string') throw new Error('Skill ID or resource invalid');
          result = readBuiltInSkill(args.id, args.resource as string | undefined) ?? await this.run.readSkill(args.id, args.resource as string | undefined);
          break;
        }
        case 'read_canvas': {
          const store = this.run.canvas(projectId);
          const canvas = await store.read(projectId);
          result = { nodes: canvas.snapshot.nodes, edges: canvas.snapshot.edges };
          break;
        }
        case 'read_reference': {
          if (typeof args.nodeId !== 'string') throw new Error('Node ID required');
          result = await this.resolveReference(projectId, { nodeId: args.nodeId }, {});
          break;
        }
        case 'generation_results': {
          if (typeof args.batchId !== 'string') throw new Error('Batch ID required');
          if (args.retrySave) await this.run.retryGenerationSave(args.batchId);
          let batch = await this.run.generationResults(args.batchId);
          while (args.wait && this.run.isAlive() && batch.status === 'approved' && batch.tasks.some(task => !['completed','failed','canceled','needs_review','query_failed','save_exhausted','save_unavailable','wait_timeout'].includes((task as {status:string}).status))) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            batch = await this.run.generationResults(args.batchId);
          }
          result = batch;
          break;
        }
        case 'edit_canvas': {
          const store = this.run.canvas(projectId);
          if (!Array.isArray(args.operations) || args.operations.length > 100) throw new Error('Operations required');
          let operations = args.operations as CanvasOperation[];
          if (operations.some(op => op.kind === 'delete')) throw new Error('Deletion needs scoped confirmation');
          const current = await store.read(projectId);
          const existing = new Set(current.snapshot.nodes.map(node => node.id));
          const created = new Set(operations.flatMap(op => op.kind === 'create' ? [op.node.id] : []));
          const referenced = new Set(this.task.editableNodeIds ?? []);
          const restricted = [...new Set(operations.flatMap(op => op.kind === 'update' && existing.has(op.id) && !created.has(op.id) && !referenced.has(op.id) ? [op.id] : []))].sort();
          if (restricted.length) {
            const question = matchingQuestion('edit', restricted);
            if (question?.answer && question.answer !== '确认修改') { result = { cancelled: true, skipped: restricted, reason: 'The user kept these nodes unchanged; put new content in new nodes.' }; break; }
            if (question?.answer !== '确认修改') {
              await this.flushReplies();
              await this.run.question({ id: callId, text: `修改已有节点 ${restricted.join('、')} 的内容？`, options: ['确认修改', '改为新建节点'], scope: { kind: 'edit', ids: restricted } });
              return { waiting: true, questionId: callId };
            }
          }
          const creates = operations.filter(op => op.kind === 'create');
          if (creates.length) {
            for (const op of creates) {
              if (!op.node || typeof op.node.id !== 'string' || !Object.values(NodeType).includes(op.node.type!)) throw new Error('Invalid new node');
              if (op.node.id.length > 200 || !op.node.id || op.node.style && Object.entries(op.node.style).some(([key, value]) => !['width', 'height'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 40 || value > 6000)) throw new Error('Invalid node dimensions');
              if (Object.keys(op.node).some(key => !['id', 'type', 'data', 'position', 'style', 'parentId', 'extent'].includes(key))) throw new Error('Unsupported node field');
            }
            const nodes = [...current.snapshot.nodes as CanvasNode[], ...creates.map(op => ({ ...op.node, position: { x: 0, y: 0 } }))];
            const edges = [...current.snapshot.edges, ...operations.flatMap(op => op.kind === 'connect' ? [op.edge] : [])];
            const added = new Set(creates.map(op => op.node.id));
            const relation = edges.find(edge => added.has(edge.source) !== added.has(edge.target));
            const nearId = relation ? added.has(relation.source) ? relation.target : relation.source : undefined;
            const arranged = await layoutCanvas(nodes, edges, [...added], true, nearId);
            operations = operations.map(op => op.kind === 'create' ? { ...op, node: arranged.find(node => node.id === op.node.id)! } : op);
          }
          intended = { operations, label: typeof args.label === 'string' ? args.label : '助手编辑' };
          result = await new GoCanvasEditor(store, goCanvasModels).apply(projectId, callId, operations, intended.label);
          break;
        }
        case 'delete_canvas_nodes': {
          const store = this.run.canvas(projectId);
          if (!Array.isArray(args.ids) || !args.ids.length || !args.ids.every(id => typeof id === 'string' && id)) throw new Error('Node IDs required');
          const ids = [...new Set(args.ids as string[])].sort();
          const question = matchingQuestion('delete', ids);
          if (question?.answer && question.answer !== '确认删除') { result = { cancelled: true, skipped: ids }; break; }
          if (!question?.answer && JSON.stringify(ids) !== JSON.stringify([...(this.task.deleteGrants ?? [])].sort())) {
            await this.flushReplies();
            await this.run.question({ id: callId, text: `删除节点 ${ids.join('、')} 及其子节点？`, options: ['确认删除', '保留'], scope: { kind: 'delete', ids } });
            return { waiting: true, questionId: callId };
          }
          intended = { operations: ids.map(id => ({ kind: 'delete', id })), label: '助手删除节点' };
          result = await new GoCanvasEditor(store, goCanvasModels).apply(projectId, callId, intended.operations, intended.label);
          break;
        }
        case 'layout_canvas': {
          const store = this.run.canvas(projectId);
          if (!Array.isArray(args.ids) || !args.ids.length || !args.ids.every(id => typeof id === 'string') || args.direction !== undefined && !['RIGHT', 'DOWN'].includes(String(args.direction))) throw new Error('Invalid layout scope');
          const current = await store.read(projectId);
          const ids = args.ids as string[];
          const arranged = await layoutCanvas(current.snapshot.nodes as CanvasNode[], current.snapshot.edges, ids, false, undefined, args.direction as 'RIGHT' | 'DOWN' | undefined);
          const operations: CanvasOperation[] = arranged.flatMap((node, index) => node === current.snapshot.nodes[index] ? [] : [{ kind: 'move', id: node.id, position: node.position }]);
          intended = { operations, label: '助手整理布局' };
          result = await new GoCanvasEditor(store, goCanvasModels).apply(projectId, callId, operations, intended.label);
          break;
        }
        default: throw new Error('Unknown tool');
      }
      await this.run.finishStep(callId, 'completed', result);
      return result;
    } catch (error) {
      // A committed canvas edit can be reconciled through its Go receipt.
      if (name === 'edit_canvas' || name === 'layout_canvas' || name === 'delete_canvas_nodes') {
        const requestId = `agent:${createHash('sha256').update(callId).digest('hex')}`;
        const receipt = await this.run.receipt(projectId, requestId).catch(() => undefined);
        if (receipt && intended && receipt.label === intended.label && JSON.stringify(receipt.operations) === JSON.stringify(intended.operations)) {
          const result = { version: receipt.version, skipped: receipt.skipped, removedNodes: receipt.removedNodes };
          await this.run.finishStep(callId, 'completed', result);
          return result;
        }
      }
      await this.run.finishStep(callId, 'failed', { error: error instanceof Error ? error.message : 'Tool failed' }).catch(() => undefined);
      throw error;
    }
  }

  connectMcp = async (taskId: string) => {
    if (taskId !== this.task.id) throw new Error('Run task mismatch');
    const server = new Server({ name: 'blow-flow-go-runner', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...definitions] }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      if (!this.run.isAlive()) throw new Error('Task paused');
      const args = { ...request.params.arguments } as Record<string, unknown>;
      const callId = args._callId; delete args._callId;
      if (typeof callId !== 'string') throw new Error('Tool identity required');
      const result = await this.execute(request.params.name, args, callId);
      const visual = result as { context?: string; image?: { type: 'image'; data: string; mimeType: string } };
      if (visual?.image) return { content: [{ type: 'text' as const, text: visual.context ?? '' }, visual.image] };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    });
    const client = new Client({ name: 'blow-flow-go-agent', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    return { client, close: async () => { await client.close(); await server.close(); } };
  };
}

export async function runGoAgentTask(client: GoAgentRunClient, taskId: string, signal?: AbortSignal, onClaim?: () => void) {
  const claim = await client.claim(taskId);
  onClaim?.();
  const run = client.run(claim.token);
  const context = await run.context();
  context.task.runId = claim.runId;
  const controller = new AbortController();
  const replies: Promise<void>[] = [];
  const host = new GoPiHost(run, context.task, () => Promise.all(replies));
  let replyIndex = 0;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const heartbeat = setInterval(() => { void run.heartbeat().catch(() => controller.abort()); }, 20_000);
  try {
    const runtime = createPiRuntimeForHost(host);
    await runtime({ task: context.task, messages: context.messages, signal: controller.signal,
      tool: () => Promise.reject(new Error('Use in-process MCP tools')),
      reply: text => {
        const id = `${claim.runId}:${++replyIndex}`;
        replies.push(run.reply(id, text).catch(() => run.reply(id, text)));
      }, pendingMessages: () => [] });
    await Promise.all(replies);
    if (run.isAlive() && !controller.signal.aborted) await run.finish('completed');
  } catch (error) {
    await Promise.allSettled(replies);
    if (run.isAlive() && !controller.signal.aborted) await run.finish('failed').catch(() => undefined);
    throw error;
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', onAbort);
  }
}
