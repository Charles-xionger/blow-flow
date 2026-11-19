import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { layoutCanvas } from '../canvas/layout';
import { createHash } from 'node:crypto';
import { resolveReferenceFromCanvas } from './references';
import { GoCanvasEditor } from './go-canvas';
import { GoAgentRun, GoAgentRunClient } from './go-runner-client';
import { createPiRuntimeForHost, type PiRuntimeHost } from './runtime';
import type { AgentReference, AgentTask } from './types';
import type { CanvasOperation } from './canvas-plan';
import type { CanvasNode } from '../../types';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const definitions = [
  { name: 'read_canvas', description: 'Read the current project canvas.', inputSchema: object({}) },
  { name: 'read_reference', description: 'Read a node and inspect its image content.', inputSchema: object({ nodeId: { type: 'string' } }, ['nodeId']) },
  { name: 'edit_canvas', description: 'Edit the project canvas as one undoable batch. Create new nodes for new content. Existing node content needs user permission.',
    inputSchema: object({ label: { type: 'string' }, operations: { type: 'array', items: { type: 'object' }, maxItems: 100 } }, ['operations']) },
  { name: 'layout_canvas', description: 'Arrange existing nodes on the canvas.', inputSchema: object({ ids: { type: 'array', items: { type: 'string' } } }, ['ids']) },
  { name: 'ask_question', description: 'Ask the user a critical question and wait for an answer.', inputSchema: object({ text: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['text']) },
  { name: 'prepare_generation', description: 'Freeze a RunningHub Krea2 image batch for explicit user approval. Only empty image nodes are supported. This tool waits for the user and never submits a provider request.', inputSchema: object({ items: { type: 'array', minItems: 1, maxItems: 20, items: object({ nodeId: { type: 'string' }, model: { const: 'runninghub/krea2' }, prompt: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' } }, ['nodeId','model','prompt','width','height']) } }, ['items']) },
  { name: 'generation_results', description: 'Read the status of a previously approved Go generation batch. Never resubmit failed or uncertain items.', inputSchema: object({ batchId: { type: 'string' } }, ['batchId']) },
] as const;

export class GoPiHost implements PiRuntimeHost {
  constructor(private run: GoAgentRun, private task: AgentTask, private flushReplies: () => Promise<unknown> = async () => {}) {}
  isExecuting = (task: AgentTask) => this.run.isAlive() && task.id === this.task.id;
  resolveReference = async (projectId: string, reference: AgentReference, options: { historical?: boolean }) => {
    if (projectId !== this.task.projectId) throw new Error('Run project mismatch');
    const canvas = await this.run.canvas(projectId).read(projectId);
    return resolveReferenceFromCanvas(canvas.snapshot as Parameters<typeof resolveReferenceFromCanvas>[0], reference, options);
  };

  private async execute(name: string, args: Record<string, unknown>, callId: string) {
    const projectId = this.task.projectId;
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
      const batch = await this.run.prepareGeneration(callId, args.items as { nodeId: string; model: string; prompt: string; width: number; height: number }[]);
      return { waiting: true, batchId: batch.id, digest: batch.digest };
    }
    const step = await this.run.startStep(callId, name, args);
    if (step.status === 'completed') return step.result;
    if (step.status === 'failed') throw new Error('Previous tool attempt failed');
    if (step.runId !== this.task.runId) throw new Error('Previous tool outcome requires reconciliation');
    try {
      let result: unknown;
      const store = this.run.canvas(projectId);
      switch (name) {
        case 'read_canvas': {
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
          result = await this.run.generationResults(args.batchId);
          break;
        }
        case 'edit_canvas': {
          if (!Array.isArray(args.operations) || args.operations.length > 100) throw new Error('Operations required');
          let operations = args.operations as CanvasOperation[];
          if (operations.some(op => op.kind === 'delete')) throw new Error('Deletion needs scoped confirmation');
          const creates = operations.filter(op => op.kind === 'create');
          if (creates.length) {
            const current = await store.read(projectId);
            const nodes = [...current.snapshot.nodes as CanvasNode[], ...creates.map(op => ({ ...op.node, position: { x: 0, y: 0 } }))];
            const edges = [...current.snapshot.edges, ...operations.flatMap(op => op.kind === 'connect' ? [op.edge] : [])];
            const added = new Set(creates.map(op => op.node.id));
            const relation = edges.find(edge => added.has(edge.source) !== added.has(edge.target));
            const nearId = relation ? added.has(relation.source) ? relation.target : relation.source : undefined;
            const arranged = await layoutCanvas(nodes, edges, [...added], true, nearId);
            operations = operations.map(op => op.kind === 'create' ? { ...op, node: arranged.find(node => node.id === op.node.id)! } : op);
          }
          result = await new GoCanvasEditor(store).apply(projectId, callId, operations, typeof args.label === 'string' ? args.label : '助手编辑');
          break;
        }
        case 'layout_canvas': {
          if (!Array.isArray(args.ids) || !args.ids.every(id => typeof id === 'string')) throw new Error('Node IDs required');
          const current = await store.read(projectId);
          const ids = args.ids as string[];
          const arranged = await layoutCanvas(current.snapshot.nodes as CanvasNode[], current.snapshot.edges, ids, true);
          const operations: CanvasOperation[] = arranged.flatMap((node, index) => node.position.x === current.snapshot.nodes[index]?.position.x && node.position.y === current.snapshot.nodes[index]?.position.y ? [] : [{ kind: 'move', id: node.id, position: node.position }]);
          result = await new GoCanvasEditor(store).apply(projectId, callId, operations, '助手整理布局');
          break;
        }
        default: throw new Error('Unknown tool');
      }
      await this.run.finishStep(callId, 'completed', result);
      return result;
    } catch (error) {
      // A committed canvas edit can be reconciled through its Go receipt.
      if (name === 'edit_canvas' || name === 'layout_canvas') {
        const requestId = `agent:${createHash('sha256').update(callId).digest('hex')}`;
        const receipt = await this.run.receipt(projectId, requestId).catch(() => undefined);
        if (receipt) {
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
