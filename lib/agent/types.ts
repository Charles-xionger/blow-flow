export type AgentStatus = 'queued' | 'running' | 'waiting' | 'interrupted' | 'completed' | 'stopped' | 'failed';
export interface AgentReference {
    nodeId?: string;
    data?: string;
    mimeType?: string;
    name?: string;
}
export interface AgentMessage {
    id: string;
    taskId: string;
    role: 'user' | 'assistant';
    text: string;
    references: AgentReference[];
    createdAt: number;
}
export interface AgentQuestion {
    id: string;
    text: string;
    options: string[];
    scope?: { kind: 'delete'; ids: string[] } | { kind: 'generation'; items: { nodeId: string; modelId: string; specification?: string; input: import('../generation/types').GenerationInput }[] };
    answer?: string;
    cancelled?: boolean;
}
export interface AgentStep {
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    status: 'running' | 'completed' | 'failed';
}
export interface AgentTask {
    id: string;
    projectId: string;
    modelId: string;
    status: AgentStatus;
    question?: AgentQuestion;
    awaitingGeneration?: boolean;
    steps: AgentStep[];
    error?: string;
    createdAt: number;
}
export interface AgentSnapshot {
    generations?: { id: string; taskId: string; status: string; items: { nodeId: string; note?: string; task?: import('../generation/types').GenerationTask }[] }[];
    tasks: AgentTask[];
    messages: AgentMessage[];
}
export interface AgentRuntimeContext {
    task: AgentTask;
    messages: AgentMessage[];
    signal: AbortSignal;
    tool: (id: string, name: string, args: Record<string, unknown>) => Promise<unknown>;
    reply: (text: string) => void;
    pendingMessages: () => AgentMessage[];
}
export type AgentRuntime = (context: AgentRuntimeContext) => Promise<void>;
export interface AgentTool {
    idempotent?: boolean;
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (task: AgentTask, args: Record<string, unknown>, callId: string) => Promise<unknown> | unknown;
}
