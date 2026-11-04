import type Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import type { AgentMessage, AgentRuntime, AgentTask, AgentSnapshot, AgentTool, AgentReference } from './types';
const active = new Set(['queued', 'running', 'waiting', 'interrupted']);
export class AgentService {
    private tools = new Map<string, AgentTool>();
    constructor(private db: Database.Database) {
        db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS agent_project_active ON agent_tasks(project_id) WHERE status IN ('queued','running','waiting','interrupted');
      CREATE TABLE IF NOT EXISTS agent_messages(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_receipts(project_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(project_id,request_id));`);
    }
    registerTool(tool: AgentTool) { this.tools.set(tool.name, tool); }
    toolDefinitions() { return [...this.tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })); }
    private save(task: AgentTask) { this.db.prepare('INSERT INTO agent_tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(task.id, task.projectId, task.status, JSON.stringify(task)); }
    task(id: string): AgentTask { const row = this.db.prepare('SELECT data FROM agent_tasks WHERE id=?').get(id) as {
        data: string;
    } | undefined; if (!row)
        throw new Error('Task not found'); return JSON.parse(row.data); }
    canvas(projectId: string) { const row = this.db.prepare('SELECT data FROM workflows WHERE id=? AND deleted_at IS NULL').get(projectId) as {
        data: string;
    } | undefined; if (!row)
        throw new Error('Project not found'); return JSON.parse(row.data); }
    snapshot(projectId: string): AgentSnapshot { this.canvas(projectId); return { tasks: (this.db.prepare('SELECT data FROM agent_tasks WHERE project_id=? ORDER BY rowid').all(projectId) as {
            data: string;
        }[]).map(r => JSON.parse(r.data)), messages: (this.db.prepare('SELECT data FROM agent_messages WHERE project_id=? ORDER BY rowid').all(projectId) as {
            data: string;
        }[]).map(r => JSON.parse(r.data)) }; }
    private message(task: AgentTask, role: 'user' | 'assistant', text: string, references: AgentReference[] = []) { const message: AgentMessage = { id: randomUUID(), taskId: task.id, role, text, references, createdAt: Date.now() }; this.db.prepare('INSERT INTO agent_messages VALUES(?,?,?,?)').run(message.id, task.projectId, task.id, JSON.stringify(message)); return message; }
    private request(projectId: string, requestId: string, input: unknown, apply: () => AgentTask) {
        if (!requestId || requestId.length > 200)
            throw new Error('Request identity required');
        const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        return this.db.transaction(() => {
            this.canvas(projectId);
            const receipt = this.db.prepare('SELECT digest,task_id FROM agent_receipts WHERE project_id=? AND request_id=?').get(projectId, requestId) as {
                digest: string;
                task_id: string;
            } | undefined;
            if (receipt) {
                if (receipt.digest !== digest)
                    throw new Error('Request identity reused');
                return this.task(receipt.task_id);
            }
            const task = apply();
            this.db.prepare('INSERT INTO agent_receipts VALUES(?,?,?,?)').run(projectId, requestId, digest, task.id);
            return task;
        }).immediate();
    }
    send(projectId: string, input: {
        requestId: string;
        text: string;
        modelId: string;
        references?: AgentReference[];
    }) {
        if (!input.text.trim() || input.text.length > 30000)
            throw new Error('Message required (maximum 30000 characters)');
        if ((input.references?.length ?? 0) > 8)
            throw new Error('Maximum eight references');
        for (const reference of input.references ?? []) {
            if (!reference.nodeId && (!/^image\/(png|jpeg|webp)$/.test(reference.mimeType ?? '') || !reference.data || reference.data.length > 14000000 || !/^[a-zA-Z0-9+/=]+$/.test(reference.data)))
                throw new Error('Invalid image reference');
        }
        return this.request(projectId, input.requestId, { type: 'send', ...input }, () => { const prior = this.snapshot(projectId).tasks.find(t => active.has(t.status)); const task = prior ?? { id: randomUUID(), projectId, modelId: input.modelId, status: 'queued' as const, steps: [], createdAt: Date.now() }; this.save(task); this.message(task, 'user', input.text, input.references); return task; });
    }
    stop(projectId: string, requestId: string) {
        return this.request(projectId, requestId, { type: 'stop' }, () => { const task = this.snapshot(projectId).tasks.find(t => active.has(t.status)) ?? this.snapshot(projectId).tasks.at(-1); if (!task)
            throw new Error('No task'); if (active.has(task.status)) {
            task.status = 'stopped';
            if (task.question && !task.question.answer)
                task.question.cancelled = true;
            this.save(task);
        } return task; });
    }
    answer(projectId: string, input: {
        requestId: string;
        questionId: string;
        text: string;
    }) {
        if (!input.text.trim())
            throw new Error('Answer required');
        return this.request(projectId, input.requestId, { type: 'answer', ...input }, () => { const task = this.snapshot(projectId).tasks.find(t => t.status === 'waiting' && t.question?.id === input.questionId); if (!task?.question)
            throw new Error('Question is no longer pending'); task.question.answer = input.text; task.status = 'queued'; this.message(task, 'user', input.text); this.save(task); return task; });
    }
    async executeTool(taskId: string, callId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
        let task = this.task(taskId);
        const existing = task.steps.find(s => s.id === callId);
        if (existing) {
            if (existing.name !== name || JSON.stringify(existing.args) !== JSON.stringify(args))
                throw new Error('Tool identity reused');
            if (existing.status === 'completed')
                return existing.result;
            throw new Error('Tool execution requires reconciliation');
        }
        if (task.status !== 'running')
            throw new Error('Task is not running');
        task.steps.push({ id: callId, name, args, status: 'running' });
        this.save(task);
        try {
            let result: unknown;
            if (name === 'ask_question') {
                if (typeof args.text !== 'string' || !args.text.trim() || (args.options !== undefined && (!Array.isArray(args.options) || !args.options.every(x => typeof x === 'string'))))
                    throw new Error('Invalid question');
                task.question = { id: callId, text: args.text, options: (args.options as string[]) ?? [] };
                task.status = 'waiting';
                this.save(task);
                result = { waiting: true, questionId: callId };
            }
            else {
                const tool = this.tools.get(name);
                if (!tool)
                    throw new Error('Unknown tool');
                result = await tool.execute(task, args, callId);
            }
            task = this.task(taskId);
            const step = task.steps.find(s => s.id === callId)!;
            step.status = 'completed';
            step.result = result;
            this.save(task);
            return result;
        }
        catch {
            task = this.task(taskId);
            const step = task.steps.find(s => s.id === callId)!;
            step.status = 'failed';
            step.result = { error: 'Tool failed; inspect parameters and project state' };
            this.save(task);
            throw new Error('Tool failed; inspect parameters and project state');
        }
    }
    async runNext(runtime: AgentRuntime): Promise<boolean> {
        const task = this.db.transaction(() => { const row = this.db.prepare("SELECT data FROM agent_tasks WHERE status='queued' ORDER BY rowid LIMIT 1").get() as {
            data: string;
        } | undefined; if (!row)
            return; const t: AgentTask = JSON.parse(row.data); t.status = 'running'; this.save(t); return t; }).immediate();
        if (!task)
            return false;
        const controller = new AbortController();
        const messages = this.snapshot(task.projectId).messages;
        const seen = new Set(messages.map(m => m.id));
        const poll = setInterval(() => { if (this.task(task.id).status !== 'running')
            controller.abort(); }, 50);
        try {
            await runtime({ task, messages, signal: controller.signal, tool: (id, name, args) => this.executeTool(task.id, id, name, args), reply: text => { if (this.task(task.id).status === 'running' && text.trim())
                    this.message(task, 'assistant', text); }, pendingMessages: () => this.snapshot(task.projectId).messages.filter(m => m.taskId === task.id && m.role === 'user' && !seen.has(m.id)).map(m => { seen.add(m.id); return m; }) });
            const current = this.task(task.id);
            if (current.status === 'running') {
                current.status = this.snapshot(task.projectId).messages.some(m => m.taskId === task.id && m.role === 'user' && !seen.has(m.id)) ? 'queued' : 'completed';
                this.save(current);
            }
        }
        catch {
            const current = this.task(task.id);
            if (current.status === 'running') {
                current.status = 'failed';
                current.error = '助手执行失败，请检查平台配置或稍后重试。';
                this.save(current);
            }
        }
        finally {
            clearInterval(poll);
        }
        return true;
    }
}
