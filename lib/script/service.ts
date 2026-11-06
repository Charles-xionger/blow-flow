import { migrateScriptSnapshot } from '../canvas/script-migration';
import { scriptPrompt } from './inputs';
import { prepareScriptImages, ScriptPreflightError } from './preflight';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db';
import { getModelDefinition } from '../model-registry';
import { validateTextConfiguration, streamText, type TextGenerationInput } from '../ai-services/text';
import type { CreateScriptTask, ScriptInput, ScriptTask, ScriptStatus } from './types';

export class ScriptError extends Error { constructor(message: string, public status = 400) { super(message); } }
type Row = { id: string; request_id: string; canvas_id: string; node_id: string; input: string; status: ScriptStatus;
  text: string; revision: number; created_at: number; updated_at: number; error: string | null; lease: string | null; lease_until: number | null };
const publicTask = (r: Row): ScriptTask => ({ id: r.id, requestId: r.request_id, canvasId: r.canvas_id, nodeId: r.node_id,
  input: JSON.parse(r.input), status: r.status, text: r.text, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at, error: r.error || undefined });
export type ScriptStream = (input: TextGenerationInput) => AsyncIterable<string>;

/** SQLite is authoritative. All executor writes are fenced by a renewable lease. */
export class ScriptService {
  constructor(public db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS script_tasks (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, canvas_id TEXT NOT NULL, node_id TEXT NOT NULL,
      input TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT, lease TEXT, lease_until INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS script_one_active ON script_tasks(canvas_id,node_id) WHERE status IN ('queued','running','stopping');
      CREATE INDEX IF NOT EXISTS script_canvas ON script_tasks(canvas_id,created_at);`);
  }
  get(id: string) { this.recoverExpired(); const row = this.row(id); if (!row) throw new ScriptError('脚本任务不存在', 404); return publicTask(row); }
  list(canvasId: string, nodeId?: string): ScriptTask[] {
    this.recoverExpired();
    const rows = nodeId ? this.db.prepare('SELECT * FROM script_tasks WHERE canvas_id=? AND node_id=? ORDER BY created_at DESC, rowid DESC').all(canvasId, nodeId)
      : this.db.prepare('SELECT * FROM script_tasks WHERE canvas_id=? ORDER BY created_at DESC, rowid DESC').all(canvasId);
    return (rows as Row[]).map(publicTask);
  }
  create(value: unknown): ScriptTask {
    this.recoverExpired();
    const request = value as CreateScriptTask;
    if (!request || ['requestId','canvasId','nodeId'].some(key => typeof request[key as keyof CreateScriptTask] !== 'string' || !(request[key as keyof CreateScriptTask] as string).length || (request[key as keyof CreateScriptTask] as string).length > 200)) throw new ScriptError('任务身份无效');
    const input = this.validateInput(request.input);
    const serialized = JSON.stringify(input);
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM script_tasks WHERE request_id=?').get(request.requestId) as Row | undefined;
      if (prior) {
        if (prior.canvas_id !== request.canvasId || prior.node_id !== request.nodeId || prior.input !== serialized) throw new ScriptError('请求身份已用于其他输入', 409);
        return publicTask(prior);
      }
      try { validateTextConfiguration(input.model, input.references.some(ref => ref.type === 'image')); } catch (error) { throw new ScriptError(error instanceof Error ? error.message : '模型配置不可用'); }
      if (!this.nodeExists(request.canvasId, request.nodeId)) throw new ScriptError('请先保存脚本节点；节点可能已被删除', 409);
      const active = this.db.prepare("SELECT id FROM script_tasks WHERE canvas_id=? AND node_id=? AND status IN ('queued','running','stopping')").get(request.canvasId, request.nodeId);
      if (active) throw new ScriptError('该节点已有活动任务', 409);
      const id = randomUUID(); const now = Date.now();
      this.db.prepare('INSERT INTO script_tasks(id,request_id,canvas_id,node_id,input,status,created_at,updated_at) VALUES(?,?,?,?,?,\'queued\',?,?)')
        .run(id, request.requestId, request.canvasId, request.nodeId, serialized, now, now);
      return this.get(id);
    }).immediate();
  }
  /** Extend input preparation here; serialized snapshots must never contain credentials. */
  validateInput(value: ScriptInput): ScriptInput {
    if (!value || typeof value.requirements !== 'string' || !value.requirements.trim() || value.requirements.length > 100_000) throw new ScriptError('请填写有效的创作要求');
    if (typeof value.model !== 'string') throw new ScriptError('请选择语言模型');
    const model = getModelDefinition(value.model);
    if (!model || model.category !== 'TEXT' || !['ark','gemini'].includes(model.provider || '')) throw new ScriptError('请选择支持流式生成的语言模型');
    if (!Array.isArray(value.references) || value.references.length > 100) throw new ScriptError('参考列表无效或超过 100 项');
    const references = value.references.map((ref, index) => {
      if (!ref || typeof ref.nodeId !== 'string' || typeof ref.label !== 'string' || !['text','image'].includes(ref.type) || typeof ref.content !== 'string' || !ref.content.trim() || ref.content.length > 200_000) throw new ScriptError(`参考 ${index + 1} 内容为空或无效`);
      return { nodeId: ref.nodeId.slice(0,200), label: ref.label.slice(0,200), type: ref.type, content: ref.content };
    });
    const image = references.find(ref => ref.type === 'image');
    if (image && !model.vision) throw new ScriptError(`参考「${image.label}」是图片；模型 ${model.name} 不支持图片，请选择视觉模型`);
    return { model: model.id, requirements: value.requirements, instruction: typeof value.instruction === 'string' ? value.instruction.slice(0,100_000) : '', preset: typeof value.preset === 'string' ? value.preset.slice(0,100) : 'free', references };
  }
  nodeExists(canvasId: string, nodeId: string) {
    const row = this.db.prepare('SELECT data FROM workflows WHERE id=? AND deleted_at IS NULL').get(canvasId) as { data: string } | undefined;
    return !!row && migrateScriptSnapshot(JSON.parse(row.data)).nodes.some((n: { id: string; type: string }) => n.id === nodeId && n.type === 'script');
  }
  /** Queued work has no provider to cancel; running work holds the slot until acknowledged. */
  stop(id: string): ScriptTask {
    this.recoverExpired();
    this.db.prepare("UPDATE script_tasks SET status=CASE WHEN status='queued' THEN 'stopped' ELSE 'stopping' END,revision=revision+1,updated_at=? WHERE id=? AND status IN ('queued','running')").run(Date.now(), id);
    return this.get(id);
  }
  recoverExpired() {
    this.db.prepare("UPDATE script_tasks SET status=CASE WHEN status='stopping' THEN 'stopped' ELSE 'interrupted' END,error='后台执行中断，已保存正文保留；请主动重新生成',revision=revision+1,updated_at=?,lease=NULL,lease_until=NULL WHERE status IN ('running','stopping') AND (lease_until IS NULL OR lease_until<=?)").run(Date.now(), Date.now());
  }
  async runNext(stream: ScriptStream = streamText): Promise<boolean> {
    this.recoverExpired();
    const claimed = this.db.transaction(() => {
      const limit = Math.max(1, Math.min(20, Number(process.env.SCRIPT_CONCURRENCY) || 5));
      const count = this.db.prepare("SELECT count(*) AS count FROM script_tasks WHERE status IN ('running','stopping')").get() as { count: number };
      if (count.count >= limit) return;
      const row = this.db.prepare("SELECT * FROM script_tasks WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").get() as Row | undefined;
      if (!row) return;
      if (!this.nodeExists(row.canvas_id, row.node_id)) {
        this.db.prepare("UPDATE script_tasks SET status='stopped',error='节点已删除',revision=revision+1,updated_at=? WHERE id=?").run(Date.now(), row.id);
        return;
      }
      const lease = randomUUID();
      this.db.prepare("UPDATE script_tasks SET status='running',lease=?,lease_until=?,revision=revision+1,updated_at=? WHERE id=?").run(lease, Date.now()+30_000, Date.now(), row.id);
      return { task: this.get(row.id), lease };
    }).immediate();
    if (!claimed) return false;
    const { task, lease } = claimed; const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('生成超时，已保存正文保留')), 180_000);
    const cancellation = setInterval(() => {
      try {
        const row = this.row(task.id);
        if (!row || row.status !== 'running' || row.lease !== lease || (row.lease_until || 0) <= Date.now()) controller.abort();
      } catch { controller.abort(); }
    }, 250);
    const heartbeat = setInterval(() => {
      try {
        const result = this.db.prepare("UPDATE script_tasks SET lease_until=? WHERE id=? AND lease=? AND lease_until>? AND status='running'").run(Date.now()+30_000, task.id, lease, Date.now());
        if (!result.changes) controller.abort();
      } catch { controller.abort(); }
    }, 5_000);
    try {
      const input = task.input;
      const images = await prepareScriptImages(input, controller.signal);
      for await (const delta of abortableStream(stream({ model: input.model, prompt: scriptPrompt(input), images, signal: controller.signal }), controller.signal)) {
        controller.signal.throwIfAborted();
        if (!delta) continue;
        const changed = this.db.prepare("UPDATE script_tasks SET text=text||?,revision=revision+1,updated_at=? WHERE id=? AND lease=? AND lease_until>? AND status='running'").run(delta, Date.now(), task.id, lease, Date.now());
        if (!changed.changes) { controller.abort(); break; }
      }
      if (!controller.signal.aborted) this.finish(task.id, lease, this.get(task.id).text.trim() ? 'completed' : 'failed', this.get(task.id).text.trim() ? null : '模型未返回正文');
    } catch (error) {
      this.finish(task.id, lease, 'failed', error instanceof ScriptPreflightError ? error.message : '生成失败或模型连接中断；已保存正文保留，请检查服务端模型配置与配额');
    } finally {
      clearInterval(heartbeat); clearInterval(cancellation); clearTimeout(timeout); controller.abort();
      // Stop wins over completion once its persisted transition has happened.
      this.db.prepare("UPDATE script_tasks SET status='stopped',error=NULL,revision=revision+1,updated_at=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=? AND status='stopping'").run(Date.now(), task.id, lease);
      this.recoverExpired();
    }
    return true;
  }
  finish(id: string, lease: string, status: ScriptStatus, error: string | null) {
    this.db.prepare("UPDATE script_tasks SET status=?,error=?,revision=revision+1,updated_at=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=? AND lease_until>? AND status='running'").run(status,error,Date.now(),id,lease,Date.now());
  }
  private row(id: string) { return this.db.prepare('SELECT * FROM script_tasks WHERE id=?').get(id) as Row | undefined; }
}
export const getScriptService = () => new ScriptService(getDatabase());

/** A provider that ignores abort cannot retain an executor slot or deliver late deltas. */
async function* abortableStream(source: AsyncIterable<string>, signal: AbortSignal) {
  const iterator = source[Symbol.asyncIterator]();
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) return;
      signal.throwIfAborted();
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Do not await a stuck adapter's return; the lease/status fence owns writes.
    void iterator.return?.().catch(() => {});
  }
}
