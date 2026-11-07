import type { CanvasNode } from '../../types';
import { getWorkflowById } from '../db/workflows';
import { createScriptOutput, finishScriptOutput, ensureScriptShotOutputs } from './output';
import { TextStreamError } from '../ai-services/text/stream-types';
import { scriptPhaseLabel, type ScriptPhase } from './types';
import { migrateScriptSnapshot } from '../canvas/script-migration';
import { hasScriptShotHeading, splitScriptShots } from './shots';
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
  output_node_id: string | null; output_saved: number; text: string; phase: ScriptPhase; revision: number; created_at: number; updated_at: number; error: string | null; lease: string | null; lease_until: number | null };
const publicTask = (r: Row): ScriptTask => ({ id: r.id, requestId: r.request_id, canvasId: r.canvas_id, nodeId: r.node_id,
  input: JSON.parse(r.input), outputNodeId: r.output_node_id || undefined, outputSaved: !!r.output_saved, status: r.status, text: r.text, phase: r.phase, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at, error: r.error || undefined });
const initializedDatabases = new WeakSet<Database.Database>();
export type ScriptStream = (input: TextGenerationInput) => AsyncIterable<string>;

/** SQLite is authoritative. All executor writes are fenced by a renewable lease. */
export class ScriptService {
  constructor(public db: Database.Database) {
    if (initializedDatabases.has(db)) return;
    const existingColumns = db.prepare('PRAGMA table_info(script_tasks)').all() as { name: string }[];
    const existingIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('script_one_active','script_canvas')").all();
    if (['phase', 'output_node_id', 'output_saved'].every(name => existingColumns.some(column => column.name === name)) && existingIndexes.length === 2) {
      initializedDatabases.add(db);
      return;
    }
    db.exec(`CREATE TABLE IF NOT EXISTS script_tasks (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, canvas_id TEXT NOT NULL, node_id TEXT NOT NULL,
      input TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT, lease TEXT, lease_until INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS script_one_active ON script_tasks(canvas_id,node_id) WHERE status IN ('queued','running','stopping');
      CREATE INDEX IF NOT EXISTS script_canvas ON script_tasks(canvas_id,created_at);`);
    db.transaction(() => {
      const columns = db.prepare('PRAGMA table_info(script_tasks)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'phase')) db.exec("ALTER TABLE script_tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'preparing'");
      if (!columns.some(column => column.name === 'output_node_id')) db.exec("ALTER TABLE script_tasks ADD COLUMN output_node_id TEXT");
      if (!columns.some(column => column.name === 'output_saved')) db.exec("ALTER TABLE script_tasks ADD COLUMN output_saved INTEGER NOT NULL DEFAULT 0");
    }).immediate();
    initializedDatabases.add(db);
  }
  get(id: string) { const row = this.row(id); if (!row) throw new ScriptError('脚本任务不存在', 404); return publicTask(row); }
  list(canvasId: string, nodeId?: string): ScriptTask[] {
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
      const task = publicTask(this.row(id)!);
      const outputId = createScriptOutput(task);
      this.db.prepare('UPDATE script_tasks SET output_node_id=? WHERE id=?').run(outputId,id);
      return publicTask(this.row(id)!);
    }).immediate();
  }
  /** Extend input preparation here; serialized snapshots must never contain credentials. */
  validateInput(value: ScriptInput): ScriptInput {
    if (!value || typeof value.requirements !== 'string' || value.requirements.length > 100_000) throw new ScriptError('创作要求格式无效或超过 100000 字');
    if (typeof value.model !== 'string') throw new ScriptError('请选择语言模型');
    const model = getModelDefinition(value.model);
    if (!model || model.category !== 'TEXT' || !['ark','gemini'].includes(model.provider || '')) throw new ScriptError('请选择支持流式生成的语言模型');
    if (!Array.isArray(value.references) || value.references.length > 100) throw new ScriptError('参考列表无效或超过 100 项');
    const references = value.references.map((ref, index) => {
      if (!ref || typeof ref.nodeId !== 'string' || typeof ref.label !== 'string' || !['text','image'].includes(ref.type) || typeof ref.content !== 'string' || !ref.content.trim() || ref.content.length > 200_000) throw new ScriptError(`参考 ${index + 1} 内容为空或无效`);
      return { nodeId: ref.nodeId.slice(0,200), label: ref.label.slice(0,200), type: ref.type, content: ref.content };
    });
    if (!value.requirements.trim() && !references.length) throw new ScriptError('请填写创作要求或连接参考文本、图片');
    const image = references.find(ref => ref.type === 'image');
    if (image && !model.vision) throw new ScriptError(`参考「${image.label}」是图片；模型 ${model.name} 不支持图片，请选择视觉模型`);
    return { ...(value.preset === 'storyboard' && value.outputMode === 'shots' ? { outputMode: 'shots' as const } : {}), model: model.id, requirements: value.requirements, instruction: typeof value.instruction === 'string' ? value.instruction.slice(0,100_000) : '', preset: typeof value.preset === 'string' ? value.preset.slice(0,100) : 'free', references };
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
    const expired = this.db.prepare("SELECT 1 FROM script_tasks WHERE status IN ('running','stopping') AND (lease_until IS NULL OR lease_until<=?) LIMIT 1").get(Date.now());
    if (expired) this.db.prepare("UPDATE script_tasks SET status=CASE WHEN status='stopping' THEN 'stopped' ELSE 'interrupted' END,error='后台执行中断，已保存正文保留；请主动重新生成',revision=revision+1,updated_at=?,lease=NULL,lease_until=NULL WHERE status IN ('running','stopping') AND (lease_until IS NULL OR lease_until<=?)").run(Date.now(), Date.now());
    this.attachLegacyOutputs();
    this.saveFinishedOutputs();
  }
  private attachLegacyOutputs() {
    const rows = this.db.prepare("SELECT * FROM script_tasks WHERE output_node_id IS NULL").all() as Row[];
    const hasDrafts = !!this.db.prepare("SELECT name FROM sqlite_master WHERE name='script_drafts'").get();
    for (const row of rows) {
      const draft = hasDrafts ? this.db.prepare("SELECT text FROM script_drafts WHERE version_id=?").get(row.id) as {text:string} | undefined : undefined;
      const text = draft?.text ?? row.text;
      if (!text && !['queued','running','stopping'].includes(row.status)) continue;
      if (!this.nodeExists(row.canvas_id,row.node_id)) continue;
      this.db.transaction(() => {
        const existing = (getWorkflowById(row.canvas_id)?.nodes as CanvasNode[] | undefined)?.find(node => node.data.scriptSource?.versionId === row.id);
        const task = { ...publicTask(row),text };
        const id = existing?.id || createScriptOutput(task);
        this.db.prepare("UPDATE script_tasks SET output_node_id=?,revision=revision+1 WHERE id=?").run(id,row.id);
        if (existing || !['queued','running','stopping'].includes(row.status)) {
          if (!existing) finishScriptOutput({...task,outputNodeId:id});
          this.db.prepare("UPDATE script_tasks SET output_saved=1,revision=revision+1 WHERE id=?").run(row.id);
        }
      }).immediate();
    }
  }
  private saveFinishedOutputs() {
    const rows = this.db.prepare("SELECT * FROM script_tasks WHERE output_node_id IS NOT NULL AND output_saved=0 AND status IN ('completed','failed','stopped','interrupted')").all() as Row[];
    for (const row of rows) {
      if (this.row(row.id)?.output_saved) continue;
      finishScriptOutput(publicTask(row));
      this.db.prepare('UPDATE script_tasks SET output_saved=1,revision=revision+1 WHERE id=? AND output_saved=0').run(row.id);
    }
  }
  async runNext(stream: ScriptStream = streamText): Promise<boolean> {
    this.recoverExpired();
    // An idle worker must not take the database writer slot just to discover an empty queue.
    if (!this.db.prepare("SELECT 1 FROM script_tasks WHERE status='queued' LIMIT 1").get()) return false;
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
    let timedOut = false;
    let streamedText = task.text;
    let shotCount = splitScriptShots(streamedText).length;
    let phase: ScriptPhase = 'preparing';
    const onPhase = (next: ScriptPhase) => {
      if (next === phase) return;
      phase = next;
      this.db.prepare("UPDATE script_tasks SET phase=?,revision=revision+1,updated_at=? WHERE id=? AND lease=? AND lease_until>? AND status='running'").run(next,Date.now(),task.id,lease,Date.now());
    };
    const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error('生成超时')); }, 180_000);
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
      for await (const delta of abortableStream(stream({ model: input.model, prompt: scriptPrompt(input), images, signal: controller.signal, onPhase }), controller.signal)) {
        controller.signal.throwIfAborted();
        if (!delta) continue;
        streamedText += delta;
        const nextShotCount = task.input.outputMode === 'shots' ? splitScriptShots(streamedText).length : 1;
        const changed = this.db.transaction(() => {
          const result = this.db.prepare("UPDATE script_tasks SET text=text||?,revision=revision+1,updated_at=? WHERE id=? AND lease=? AND lease_until>? AND status='running'").run(delta, Date.now(), task.id, lease, Date.now());
          if (result.changes && nextShotCount > shotCount) ensureScriptShotOutputs({ ...task, text: streamedText });
          return result;
        }).immediate();
        shotCount = nextShotCount;
        if (!changed.changes) { controller.abort(); break; }
      }
      if (!controller.signal.aborted) {
        const text = this.get(task.id).text;
        const error = !text.trim() ? '模型未返回正文'
          : input.outputMode === 'shots' && !hasScriptShotHeading(text) ? '模型未按逐镜头格式输出，原文已保留；请重新生成分镜。' : null;
        this.finish(task.id, lease, error ? 'failed' : 'completed', error);
      }
    } catch (error) {
      const message = timedOut ? `生成超过 180 秒，已停止；最后阶段：${scriptPhaseLabel[phase]}。已保存正文保留，未自动重试。`
        : error instanceof ScriptPreflightError || error instanceof TextStreamError ? error.message
        : '模型连接异常；已保存正文保留，未自动重试。';
      this.finish(task.id, lease, 'failed', message);
    } finally {
      clearInterval(heartbeat); clearInterval(cancellation); clearTimeout(timeout); controller.abort();
      // Stop wins over completion once its persisted transition has happened.
      this.db.prepare("UPDATE script_tasks SET status='stopped',error=NULL,revision=revision+1,updated_at=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=? AND status='stopping'").run(Date.now(), task.id, lease);
      this.recoverExpired();
    }
    return true;
  }
  finish(id: string, lease: string, status: ScriptStatus, error: string | null) {
    this.db.transaction(() => {
    this.db.prepare("UPDATE script_tasks SET status=?,error=?,revision=revision+1,updated_at=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=? AND lease_until>? AND status='running'").run(status,error,Date.now(),id,lease,Date.now());
    }).immediate();
    this.saveFinishedOutputs();
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
