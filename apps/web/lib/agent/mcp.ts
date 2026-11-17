import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AgentService } from './service';
import { resolveReference } from './references';
import { discoverSkills, readSkill } from './skills';
import { currentLocalOwner } from '../auth/current-user';
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const questionDefinition = { name: 'ask_question', description: 'Ask only a critical ambiguity. Persist waiting until the user answers or cancels.', inputSchema: object({ text: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['text']) };
export function registerReadTools(service: AgentService) {
    service.registerTool({ idempotent: true, name: 'read_canvas', description: 'Read current project nodes, content, parameters and edges.', inputSchema: object({}), execute: task => { const { nodes, edges } = service.canvas(task.projectId); return { nodes, edges }; } });
    service.registerTool({ idempotent: true, name: 'read_reference', description: 'Read a project node and visually inspect its image content.', inputSchema: object({ nodeId: { type: 'string' } }, ['nodeId']), execute: (task, args) => resolveReference(service, task.projectId, { nodeId: String(args.nodeId) }) });
    service.registerTool({ idempotent: true, name: 'discover_skills', description: 'Discover optional creative skills before loading their instructions.', inputSchema: object({}), execute: () => discoverSkills(currentLocalOwner) });
    service.registerTool({ idempotent: true, name: 'read_skill', description: 'Load a discovered skill or one of its resources when needed.', inputSchema: object({ id: { type: 'string' }, resource: { type: 'string' } }, ['id']), execute: (_task, args) => readSkill(String(args.id), args.resource === undefined ? undefined : String(args.resource), currentLocalOwner) });
}
/** In-process MCP transport: no listening port or external project selector. */
export async function connectAgentMcp(service: AgentService, taskId: string) {
    const run = service.task(taskId);
    const server = new Server({ name: 'blow-flow-internal', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...service.toolDefinitions(), questionDefinition] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (!service.isExecuting(run)) throw new Error('Task paused');
        const args = { ...request.params.arguments };
        const callId = args._callId;
        delete args._callId;
        if (typeof callId !== 'string')
            throw new Error('Tool identity required');
        const result = await service.executeTool(taskId, callId, request.params.name, args);
        const visual = result as {
            context?: string;
            image?: {
                type: 'image';
                data: string;
                mimeType: string;
            };
        };
        if (visual?.image)
            return { content: [{ type: 'text', text: visual.context ?? '' }, visual.image] };
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
    const client = new Client({ name: 'blow-flow-agent', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, close: async () => { await client.close(); await server.close(); } };
}
