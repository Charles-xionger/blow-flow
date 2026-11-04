import { validReferenceUrl } from '../generation/reference-files';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import type { AgentMessage, AgentRuntime, AgentTask, AgentSnapshot, AgentTool, AgentReference } from './types';
import { redactedFailure } from './redact';
const active = new Set(['queued', 'running', 'waiting', 'interrupted']);
export class AgentService {
    private workerId = randomUUID();
    private leaseMs: number;
    /** Each worker renews only its own lease. Opening a web service never steals live work. */
    private heartbeat() {
        this.db.prepare('INSERT INTO agent_workers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET lease_until=excluded.lease_until').run(this.workerId, Date.now() + this.leaseMs);
    }
    recover() {
        this.db.transaction(() => {
            const rows = this.db.prepare("SELECT data FROM agent_tasks WHERE status IN ('running','queued','waiting')").all() as {data:string}[];
            for (const row of rows) {
                const task: AgentTask = JSON.parse(row.data);
                if (task.status === 'waiting' && !task.awaitingGeneration) continue;
                if (!task.workerId && task.status !== 'running') continue;
                const owner = task.workerId ? this.db.prepare('SELECT lease_until FROM agent_workers WHERE id=?').get(task.workerId) as {lease_until:number}|undefined : undefined;
                if (!owner || owner.lease_until <= Date.now()) { task.status = 'interrupted'; this.save(task); }
            }
        }).immediate();
    }
    isExecuting(task: AgentTask) {
        const current = this.task(task.id);
        const lease = this.db.prepare('SELECT lease_until FROM agent_workers WHERE id=?').get(this.workerId) as {lease_until:number}|undefined;
        return current.status === 'running' && current.runId === task.runId && current.workerId === this.workerId && !!lease && lease.lease_until > Date.now();
    }
    continue(projectId: string, requestId: string) {
        this.recover();
        return this.request(projectId, requestId, {type:'continue'}, () => {
            const task = this.snapshot(projectId).tasks.find(t => active.has(t.status));
            if (!task) throw new Error('No task to continue');
            if (task.status === 'interrupted') {
                task.status = 'queued'; delete task.awaitingGeneration; delete task.workerId; delete task.runId;
                this.save(task);
            }
            return task;
        });
    }

    generationSummary?: (projectId: string) => AgentSnapshot['generations'];
    generationPending?: (taskId: string) => boolean;
    wakeAfterGeneration(taskId: string) {
        this.db.transaction(() => {
            const task = this.task(taskId);
            if (task.status === 'waiting' && task.awaitingGeneration && !this.generationPending?.(taskId)) {
                task.status = 'queued'; delete task.awaitingGeneration; this.save(task);
            }
        }).immediate();
    }
    private tools = new Map<string, AgentTool>();
    private validator = new AjvJsonSchemaValidator();
    private lifecycle: { send?: (task: AgentTask) => void; answer?: (task: AgentTask, text: string) => void; stop?: (task: AgentTask) => void; tick?: () => void }[] = [];
    registerLifecycle(hooks: typeof this.lifecycle[number]) { this.lifecycle.push(hooks); }
    constructor(private db: Database.Database, options: {leaseMs?: number} = {}) {
        this.leaseMs = options.leaseMs ?? 15000;
        db.exec(`CREATE TABLE IF NOT EXISTS agent_workers(id TEXT PRIMARY KEY, lease_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS agent_project_active ON agent_tasks(project_id) WHERE status IN ('queued','running','waiting','interrupted');
      CREATE TABLE IF NOT EXISTS agent_messages(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_receipts(project_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(project_id,request_id));`);
    }
    registerTool(tool: AgentTool) {
        const validate = this.validator.getValidator(tool.inputSchema);
        this.tools.set(tool.name, {...tool, execute:(task,args,callId) => {
            if (!validate(args).valid) throw new Error('Invalid tool parameters');
            return tool.execute(task,args,callId);
        }});
    }
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
    snapshot(projectId: string): AgentSnapshot { this.recover(); this.canvas(projectId); return { generations: this.generationSummary?.(projectId), tasks: (this.db.prepare('SELECT data FROM agent_tasks WHERE project_id=? ORDER BY rowid').all(projectId) as {
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
            if (reference.url && (!validReferenceUrl(reference.url) || !/^image\/(png|jpeg|webp)$/.test(reference.mimeType ?? '')))
                throw new Error('Invalid image reference');
            if (!reference.nodeId && !reference.url && (!/^image\/(png|jpeg|webp)$/.test(reference.mimeType ?? '') || !reference.data || reference.data.length > 14000000 || !/^[a-zA-Z0-9+/=]+$/.test(reference.data)))
                throw new Error('Invalid image reference');
        }
        return this.request(projectId, input.requestId, { type: 'send', ...input }, () => { for (const reference of input.references ?? []) { if (reference.nodeId && !this.canvas(projectId).nodes.some((node: {id:string}) => node.id === reference.nodeId)) throw new Error('Reference node not found'); } const prior = this.snapshot(projectId).tasks.find(t => active.has(t.status)); const task = prior ?? { id: randomUUID(), projectId, modelId: input.modelId, status: 'queued' as const, steps: [], createdAt: Date.now() }; const interrupted = task.status === 'interrupted'; if (prior) this.lifecycle.forEach(h => h.send?.(task)); if (task.status === 'waiting' && task.question && !task.question.answer) { task.question.cancelled = true; task.status = 'queued'; delete task.workerId; delete task.runId; } if (interrupted) task.status = 'interrupted'; if (task.awaitingGeneration && task.status !== 'interrupted') { task.status = 'queued'; delete task.awaitingGeneration; } this.save(task); this.message(task, 'user', input.text, input.references); return task; });
    }
    stop(projectId: string, requestId: string) {
        return this.request(projectId, requestId, { type: 'stop' }, () => { const task = this.snapshot(projectId).tasks.find(t => active.has(t.status)) ?? this.snapshot(projectId).tasks.at(-1); if (!task)
            throw new Error('No task'); if (active.has(task.status)) {
            task.status = 'stopped';
            this.lifecycle.forEach(h => h.stop?.(task));
            delete task.awaitingGeneration;
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
            throw new Error('Question is no longer pending'); this.lifecycle.forEach(h => h.answer?.(task, input.text)); task.question.answer = input.text; task.status = 'queued';
            const owner = task.workerId ? this.db.prepare('SELECT lease_until FROM agent_workers WHERE id=?').get(task.workerId) as {lease_until:number}|undefined : undefined;
            if (!owner || owner.lease_until <= Date.now()) { delete task.workerId; delete task.runId; } this.message(task, 'user', input.text); this.save(task); return task; });
    }
    consumeQuestion(taskId: string, questionId: string) {
        this.db.transaction(() => {
        const task = this.task(taskId);
        if (task.question?.id === questionId) { task.question.cancelled = true; this.save(task); }
        }).immediate();
    }
    grantEdit(taskId: string, questionId: string, ids: string[]) {
        this.db.transaction(() => {
        const task = this.task(taskId);
        if (task.question?.id === questionId) task.question.cancelled = true;
        task.editableNodeIds = [...new Set([...(task.editableNodeIds ?? []), ...ids])];
        this.save(task);
        }).immediate();
    }
    requestQuestion(taskId: string, id: string, text: string, options: string[], scope?: import('./types').AgentQuestion['scope']) {
        return this.db.transaction(() => {
        const task = this.task(taskId);
        if (!this.isExecuting(task)) throw new Error('Task is not running');
        task.question = { id, text, options, scope };
        task.status = 'waiting';
        this.save(task);
        return { waiting: true, questionId: id };
        }).immediate();
    }
    async executeTool(taskId: string, callId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
        const claimed = this.db.transaction(() => {
            const task = this.task(taskId);
            const existing = task.steps.find(step => step.id === callId);
            if (existing) {
                if (existing.name !== name || JSON.stringify(existing.args) !== JSON.stringify(args)) throw new Error('Tool identity reused');
                if (existing.status === 'completed') return {task, completed:true, result:existing.result};
                if (name !== 'ask_question' && !this.tools.get(name)?.idempotent) throw new Error('Tool execution requires reconciliation');
            }
            if (!this.isExecuting(task)) throw new Error('Task is not running');
            if (existing) existing.status = 'running';
            else task.steps.push({id:callId, name, args, status:'running'});
            this.save(task);
            return {task, completed:false};
        }).immediate();
        if (claimed.completed) return claimed.result;
        const executing = claimed.task;
        const finish = (status: 'completed' | 'failed', result: unknown) => this.db.transaction(() => {
            const task = this.task(taskId);
            if (task.runId !== executing.runId) throw new Error('Run ownership changed');
            const step = task.steps.find(step => step.id === callId)!;
            step.status = status; step.result = result;
            this.save(task);
        }).immediate();
        try {
            let result: unknown;
            if (name === 'ask_question') {
                if (typeof args.text !== 'string' || !args.text.trim() || Object.keys(args).some(key => !['text','options'].includes(key)) || (args.options !== undefined && (!Array.isArray(args.options) || !args.options.every(x => typeof x === 'string')))) throw new Error('Invalid question');
                const question = executing.question;
                result = question?.id === callId
                    ? {questionId:callId, answer:question.answer, cancelled:question.cancelled}
                    : this.requestQuestion(taskId, callId, args.text, (args.options as string[]) ?? []);
            } else {
                const tool = this.tools.get(name);
                if (!tool) throw new Error('Unknown tool');
                result = await tool.execute(executing, args, callId);
            }
            finish('completed', result);
            return result;
        } catch (error) {
            // The planner needs the cause to correct its call; a bare failure pushed it into rewriting existing nodes.
            const message = `Tool failed: ${redactedFailure(error)}. Fix the parameters and retry; do not repurpose existing nodes.`;
            finish('failed', {error: message});
            throw new Error(message);
        }
    }
    async runNext(runtime: AgentRuntime): Promise<boolean> {
        this.recover();
        this.heartbeat();
        this.lifecycle.forEach(h => h.tick?.());
        const task = this.db.transaction(() => { const row = this.db.prepare("SELECT data FROM agent_tasks WHERE status='queued' ORDER BY rowid LIMIT 1").get() as {
            data: string;
        } | undefined; if (!row)
            return; const t: AgentTask = JSON.parse(row.data); t.status = 'running'; t.workerId = this.workerId; t.runId = randomUUID(); this.save(t); return t; }).immediate();
        if (!task)
            return false;
        const controller = new AbortController();
        const messages = this.snapshot(task.projectId).messages;
        const seen = new Set(messages.map(m => m.id));
        const poll = setInterval(() => { this.recover(); this.heartbeat(); if (!this.isExecuting(task)) controller.abort(); }, Math.min(50, this.leaseMs / 3));
        try {
            // User continuation reconciles receipts before exposing history to the planner.
            for (const step of task.steps.filter(step => step.status === 'running')) {
                if (step.name === 'ask_question' || this.tools.get(step.name)?.idempotent) {
                    try { await this.executeTool(task.id, step.id, step.name, step.args); } catch { /* Persisted failure remains visible to the planner. */ }
                } else {
                    const current = this.task(task.id);
                    const interrupted = current.steps.find(value => value.id === step.id)!;
                    interrupted.status = 'failed';
                    interrupted.result = {error:'中断操作结果不明；先核实项目状态，不要盲目重复副作用。'};
                    this.save(current);
                }
                if (!this.isExecuting(task)) return true;
            }
            await runtime({ task: this.task(task.id), messages, signal: controller.signal, tool: (id, name, args) => { if (!this.isExecuting(task)) return Promise.reject(new Error('Task paused')); return this.executeTool(task.id, id, name, args); }, reply: text => { this.db.transaction(() => { if (this.isExecuting(task) && text.trim()) this.message(task, 'assistant', text); }).immediate(); }, pendingMessages: () => this.snapshot(task.projectId).messages.filter(m => m.taskId === task.id && m.role === 'user' && !seen.has(m.id)).map(m => { seen.add(m.id); return m; }) });
            this.db.transaction(() => {
            const current = this.task(task.id);
            if (this.isExecuting(task)) {
                const hasMessages = this.snapshot(task.projectId).messages.some(m => m.taskId === task.id && m.role === 'user' && !seen.has(m.id));
                const pendingGeneration = this.generationPending?.(task.id);
                current.status = hasMessages ? 'queued' : pendingGeneration ? 'waiting' : 'completed';
                if (!hasMessages && pendingGeneration) current.awaitingGeneration = true;
                this.save(current);
            }
            }).immediate();
        }
        catch (error) {
            this.db.transaction(() => {
            const current = this.task(task.id);
            if (this.isExecuting(task)) {
                // Users see a generic message; operators need the provider's cause.
                console.error(`[agent] task ${task.id} (project ${task.projectId}) failed: ${redactedFailure(error)}`);
                current.status = 'failed';
                current.error = '助手执行失败，请检查平台配置或稍后重试。';
                this.save(current);
            }
            }).immediate();
        }
        finally {
            clearInterval(poll);
        }
        return true;
    }
}
