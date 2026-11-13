import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { LangfuseOtelSpanAttributes, setLangfuseTracerProvider, startObservation } from '@langfuse/tracing';
import type { LangfuseGeneration, LangfuseTool } from '@langfuse/tracing';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import type { AgentEvent } from '@mariozechner/pi-agent-core';
import { redactedFailure } from './redact';
export interface AgentRunInfo {
    taskId: string;
    projectId: string;
    runId?: string;
    modelId: string;
    input: string;
}
/** One task run as seen by the operator: model calls, tool calls, outcome. */
export interface AgentRunTrace {
    generation(model: string, input: unknown): void;
    observe(event: AgentEvent): void;
    /** `stopped`: the user stopped or paused the run; not a failure, not a success. */
    finish(outcome?: { error?: unknown; stopped?: boolean }): void;
}
export interface AgentTracer {
    startRun(run: AgentRunInfo): AgentRunTrace;
    shutdown(): Promise<void>;
}
/** Tracing is optional: configured only when all three LANGFUSE_* variables are present. */
export function langfuseTracerFromEnv(): AgentTracer | undefined {
    const { LANGFUSE_BASE_URL: baseUrl, LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey } = process.env;
    if (!baseUrl || !publicKey || !secretKey)
        return undefined;
    return createLangfuseTracer(new LangfuseSpanProcessor({ baseUrl, publicKey, secretKey }));
}
const dataUrl = /data:([\w.+-]+)\/[\w.+-]+(?:;[\w.+-]+=[^;,]*)*;base64,[A-Za-z0-9+/=]+/g;
/** What leaves the worker: media summarised (it reaches the model, not the trace), credentials masked. */
function scrub(value: unknown): unknown {
    if (typeof value === 'string')
        return redactedFailure(value.replace(dataUrl, (match, kind) => `data:${kind};base64,<${match.length} chars omitted>`));
    if (Array.isArray(value))
        return value.map(scrub);
    if (value && typeof value === 'object') {
        const entries = Object.entries(value).map(([key, item]) => [key, key === 'data' && typeof item === 'string' && ['image', 'audio', 'video'].includes(String((value as { type?: unknown }).type)) ? `<${item.length} base64 chars omitted>` : scrub(item)]);
        return Object.fromEntries(entries);
    }
    return value;
}
/** Tracing never reaches the task: every failure is logged and swallowed. */
function guard<T>(label: string, fn: () => T): T | undefined {
    try {
        return fn();
    }
    catch (error) {
        console.error(`[agent] tracing ${label} failed: ${redactedFailure(error)}`);
        return undefined;
    }
}
async function guardAsync(label: string, fn: () => Promise<unknown>) {
    try {
        await fn();
    }
    catch (error) {
        console.error(`[agent] tracing ${label} failed: ${redactedFailure(error)}`);
    }
}
let activeProvider: BasicTracerProvider | undefined;
/** Langfuse resolves its tracer provider globally, so only one tracer may be live per process. */
export function createLangfuseTracer(processor: SpanProcessor): AgentTracer {
    if (activeProvider)
        throw new Error('A Langfuse tracer is already active; shut it down first');
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    activeProvider = provider;
    setLangfuseTracerProvider(provider);
    return {
        startRun(run) {
            // Langfuse v4 filters observations individually, so each one carries the trace attributes.
            const traced = <T extends { otelSpan: { setAttributes(attributes: Record<string, string>): unknown } }>(observation: T) => {
                observation.otelSpan.setAttributes({ [LangfuseOtelSpanAttributes.TRACE_NAME]: '创作助手', [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: run.projectId });
                return observation;
            };
            const root = guard('start', () => traced(startObservation('创作助手', { input: scrub(run.input), metadata: { taskId: run.taskId, runId: run.runId, modelId: run.modelId } }, { asType: 'agent' })));
            let generation: LangfuseGeneration | undefined;
            const tools = new Map<string, LangfuseTool>();
            let output = '';
            return {
                generation(model, input) {
                    guard('generation', () => {
                        generation?.end();
                        const started = root?.startObservation('model call', { model, input: scrub(input) }, { asType: 'generation' });
                        generation = started && traced(started);
                    });
                },
                observe(event) {
                    guard(event.type, () => {
                        if (event.type === 'message_end' && event.message.role === 'assistant') {
                            const { message } = event;
                            const text = message.content.filter(c => c.type === 'text').map(c => c.text).join('');
                            if (text)
                                output = text;
                            generation?.update({
                                output: scrub(message.content),
                                usageDetails: { input: message.usage.input, output: message.usage.output, cache_read: message.usage.cacheRead, cache_write: message.usage.cacheWrite, total: message.usage.totalTokens },
                                ...(message.stopReason === 'error' ? { level: 'ERROR' as const, statusMessage: redactedFailure(message.errorMessage ?? 'unknown provider error') } : {}),
                            }).end();
                            generation = undefined;
                        }
                        if (event.type === 'tool_execution_start' && root)
                            tools.set(event.toolCallId, traced(root.startObservation(event.toolName, { input: scrub(event.args) }, { asType: 'tool' })));
                        if (event.type === 'tool_execution_end') {
                            tools.get(event.toolCallId)?.update({ output: scrub(event.result), ...(event.isError ? { level: 'ERROR' as const } : {}) }).end();
                            tools.delete(event.toolCallId);
                        }
                    });
                },
                finish({ error, stopped } = {}) {
                    guard('finish', () => {
                        const outcome = error !== undefined
                            ? { level: 'ERROR' as const, statusMessage: redactedFailure(error) }
                            : stopped ? { level: 'WARNING' as const, statusMessage: 'stopped or paused before completion' } : {};
                        // A stream that throws never emits message_end, so its generation carries the failure.
                        if (error !== undefined)
                            generation?.update(outcome);
                        generation?.end();
                        tools.forEach(tool => tool.end());
                        tools.clear();
                        root?.update({ output: scrub(output), ...outcome }).end();
                    });
                    // Export now so a trace is visible while debugging; never hold the task (and its lease) for it.
                    void guardAsync('flush', () => provider.forceFlush());
                },
            };
        },
        async shutdown() {
            await guardAsync('shutdown', () => provider.shutdown());
            if (activeProvider === provider)
                activeProvider = undefined;
        },
    };
}
