import { resolveAgentModel } from './models';
import type { AgentTool, StreamFn } from '@mariozechner/pi-agent-core';
import type { UserMessage } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import { agentModels } from './config';
import { AGENT_GUIDE } from './guide';
import { connectAgentMcp } from './mcp';
import { resolveReference } from './references';
import type { AgentService } from './service';
import type { AgentRunTrace, AgentTracer } from './tracing';
import type { AgentRuntime, AgentRuntimeContext, AgentMessage } from './types';
export function createPiRuntime(service: AgentService, options: {
    apiKey?: string;
    streamFn?: StreamFn;
    tracer?: AgentTracer;
} = {}): AgentRuntime {
    const run = async (context: AgentRuntimeContext, trace: AgentRunTrace | undefined) => {
        const [{ Agent }, { streamSimple }] = await Promise.all([import('@mariozechner/pi-agent-core'), import('@mariozechner/pi-ai')]);
        const config = agentModels().find(m => m.id === context.task.modelId);
        if (!config || !(options.apiKey || process.env[config.apiKeyEnv]))
            throw new Error('Agent model unavailable');
        const { model, onPayload } = resolveAgentModel(config);
        const mcp = await connectAgentMcp(service, context.task.id);
        const definitions = await mcp.client.listTools();
        const tools: AgentTool[] = definitions.tools.map(tool => ({ name: tool.name, label: tool.name, description: tool.description ?? '', parameters: Type.Unsafe(tool.inputSchema), execute: async (id, args) => {
                if (context.signal.aborted || !service.isExecuting(context.task))
                    throw new Error('Task paused');
                const result = await mcp.client.callTool({ name: tool.name, arguments: { ...args as Record<string, unknown>, _callId: id } });
                return { content: result.content as {
                        type: 'text';
                        text: string;
                    }[], details: {}, terminate: !service.isExecuting(context.task) };
            } }));
        const agent = new Agent({ initialState: { model, tools, systemPrompt: AGENT_GUIDE }, getApiKey: () => options.apiKey || process.env[config.apiKeyEnv], streamFn: (model, ctx, streamOptions) => { if (!service.isExecuting(context.task))
                throw new Error('Task paused'); trace?.generation(model.id, { system: ctx.systemPrompt, messages: ctx.messages }); return (options.streamFn ?? streamSimple)(model, ctx, { ...streamOptions, ...(onPayload ? { onPayload } : {}) }); }, toolExecution: 'sequential', beforeToolCall: async () => context.signal.aborted || !service.isExecuting(context.task) ? { block: true, reason: 'Task paused', terminate: true } : undefined });
        const convert = async (message: AgentMessage): Promise<UserMessage> => {
            const content: UserMessage['content'] = [{ type: 'text', text: `${message.role === 'assistant' ? '此前助手回复：' : ''}${message.text}` }];
            for (const reference of message.references) {
                const resolved = await resolveReference(service, context.task.projectId, reference, { historical: true });
                content.push({ type: 'text', text: resolved.context });
                if (resolved.image && model.input.includes('image'))
                    content.push(resolved.image);
                else if (resolved.image)
                    content.push({ type: 'text', text: '当前模型不支持查看图片像素；只能使用上述素材信息。需要视觉分析时请用户选择 Doubao Seed 2.1 Pro。' });
            }
            return { role: 'user', content, timestamp: message.createdAt };
        };
        agent.subscribe(async (event) => {
            trace?.observe(event);
            if (event.type === 'message_end' && event.message.role === 'assistant') {
                if (event.message.stopReason === 'error')
                    throw new Error(event.message.errorMessage ?? 'unknown provider error');
                const text = event.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
                if (text)
                    context.reply(text);
            }
            if (event.type === 'turn_end')
                for (const message of context.pendingMessages())
                    agent.steer(await convert(message));
        });
        const abort = () => agent.abort();
        context.signal.addEventListener('abort', abort, { once: true });
        try {
            const history = await Promise.all(context.messages.map(convert));
            history.unshift({ role: 'user', content: `已记录执行步骤（不要重复已成功的操作）：${JSON.stringify(context.task.steps)}；待处理事项：${JSON.stringify(context.task.question ?? null)}`, timestamp: Date.now() });
            if (!context.signal.aborted && service.isExecuting(context.task))
                await agent.prompt(history);
            if (agent.state.errorMessage) throw new Error(`Provider failed: ${agent.state.errorMessage}`);
        }
        finally {
            context.signal.removeEventListener('abort', abort);
            await mcp.close();
        }
    };
    return async (context) => {
        // The trace spans the whole run, so setup failures (model config, MCP) are visible too.
        const trace = options.tracer?.startRun({ taskId: context.task.id, projectId: context.task.projectId, runId: context.task.runId, modelId: context.task.modelId, input: context.messages.filter(m => m.role === 'user').at(-1)?.text ?? '' });
        try {
            await run(context, trace);
            trace?.finish({ stopped: context.signal.aborted || !service.isExecuting(context.task) });
        }
        catch (error) {
            trace?.finish({ error });
            throw error;
        }
    };
}
