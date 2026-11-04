import { GenerationPermissions } from './permissions';
import { geminiImageParameters } from './gemini-image';
import { validGenerationDimensions } from './dimensions';
import { validReferenceUrl } from './reference-files';
import { validateGenerationConfig } from './config';
import type Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ConnectionConfig, CreateGeneration, GenerationConfig, GenerationInput, GenerationReference, GenerationTask, ModelConfig, PublicModel } from './types';

export class GenerationError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export interface TaskRecord {
  id: string; request_id: string; request_json: string; connection_id: string; snapshot: string; input: string;
  status: GenerationTask['status']; save_status: GenerationTask['saveStatus']; platform_id: string | null;
  created_at: number; updated_at: number; deadline: number | null; next_poll: number; lease_until: number;
  revision: number; lease_token: string | null; query_errors: number; results: string; artifacts: string; error: string | null;
  submission_started: number;
}
export interface TaskSnapshot { model: ModelConfig; connection: ConnectionConfig }

export class GenerationService {
  readonly permissions: GenerationPermissions;
  constructor(readonly db: Database.Database, readonly config: GenerationConfig) {
    validateGenerationConfig(config);
    this.permissions = new GenerationPermissions(db);
    db.pragma('busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS generation_tasks (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL,
      connection_id TEXT NOT NULL, snapshot TEXT NOT NULL, input TEXT NOT NULL,
      status TEXT NOT NULL, save_status TEXT NOT NULL DEFAULT 'pending', platform_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deadline INTEGER,
      next_poll INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT,
      query_errors INTEGER NOT NULL DEFAULT 0, results TEXT NOT NULL DEFAULT '[]',
      artifacts TEXT NOT NULL DEFAULT '[]', error TEXT);
      CREATE INDEX IF NOT EXISTS generation_queue ON generation_tasks(connection_id, status, created_at);
      CREATE TABLE IF NOT EXISTS generation_deleted_nodes (
        canvas_id TEXT NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY(canvas_id, node_id));
      CREATE TABLE IF NOT EXISTS generation_diagnostics (
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, created_at INTEGER NOT NULL, response TEXT NOT NULL);
    `);
    // Serialize migration with the worker: both processes may start together.
    db.transaction(() => {
      const columns = db.pragma('table_info(generation_tasks)') as { name: string }[];
      if (!columns.some(c => c.name === 'revision'))
        db.exec('ALTER TABLE generation_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
      if (!columns.some(c => c.name === 'submission_started'))
        db.exec('ALTER TABLE generation_tasks ADD COLUMN submission_started INTEGER NOT NULL DEFAULT 1');
      db.exec(`CREATE TRIGGER IF NOT EXISTS generation_public_revision
        AFTER UPDATE OF status, save_status, artifacts, error, deadline ON generation_tasks
        WHEN NEW.status IS NOT OLD.status OR NEW.save_status IS NOT OLD.save_status
          OR NEW.artifacts IS NOT OLD.artifacts OR NEW.error IS NOT OLD.error OR NEW.deadline IS NOT OLD.deadline
        BEGIN UPDATE generation_tasks SET revision = OLD.revision + 1 WHERE id = NEW.id; END;`);
    }).immediate();
  }
  models(): PublicModel[] {
    return this.config.models.map(m => ({ id: m.id, name: m.name, category: m.category,
      configured: this.configured(this.config.connections.find(c => c.id === m.connectionId)), capabilities: m.capabilities }));
  }
  private configured(c?: ConnectionConfig): boolean {
    if (!c || !c.baseUrl || !process.env[c.apiKeyEnv]) return false;
    try { const url = new URL(c.baseUrl); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
  }
  validate(value: unknown): CreateGeneration {
    const request = validateRequest(value);
    const model = this.config.models.find(m => m.id === request.modelId);
    if (!model) throw new GenerationError('未知模型');
    if (!this.configured(this.config.connections.find(c => c.id === model.connectionId))) throw new GenerationError('平台连接未配置', 503);
    if (!validGenerationDimensions(model.capabilities.dimensions, request.input.width, request.input.height)) throw new GenerationError('无效的生成尺寸');
    validateModelInput(model, request.input);
    return request;
  }
  cancelRequests(requestIds: string[]) {
    for (const id of requestIds) {
      this.permissions.revoke(id);
      this.db.prepare("UPDATE generation_tasks SET status='cancelled', lease_token=NULL, lease_until=0, updated_at=? WHERE request_id=? AND (status='queued' OR (status='submitting' AND submission_started=0))").run(Date.now(), id);
    }
  }
  /** Both reads share the worker's immediate paid-boundary transaction. */
  submissionPaused(task: TaskRecord): boolean { return this.permissions.paused(task.request_id); }
  authorizeSubmission(task: TaskRecord): boolean { return this.permissions.authorizes(task.request_id, task.request_json); }
  create(value: unknown): GenerationTask {
    const request = validateRequest(value);
    const requestJson = JSON.stringify(request);
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM generation_tasks WHERE request_id = ?').get(request.requestId) as TaskRecord | undefined;
      if (existing) {
        if (existing.request_json !== requestJson) throw new GenerationError('请求标识已用于不同输入', 409);
        return this.publicTask(existing);
      }
      if (this.db.prepare('SELECT 1 FROM generation_deleted_nodes WHERE canvas_id=? AND node_id=?').get(request.canvasId, request.nodeId))
        throw new GenerationError('节点已删除', 409);
      const model = this.config.models.find(m => m.id === request.modelId);
      if (!model) throw new GenerationError('未知模型');
      const connection = this.config.connections.find(c => c.id === model.connectionId);
      if (!connection || !this.configured(connection)) throw new GenerationError('平台连接未配置', 503);
      if (!['runninghub-workflow','gemini-image'].includes(model.adapter)) throw new GenerationError('不支持的适配器');
      const d = model.capabilities.dimensions;
      if (!validGenerationDimensions(d, request.input.width, request.input.height))
        throw new GenerationError(`尺寸必须为 ${d.min}–${d.max} 范围内 ${d.step} 的倍数`);
      validateModelInput(model, request.input);
      const id = randomUUID();
      const now = Date.now();
      // 48 random bits are exactly representable both by JSON and ComfyUI.
      const input = { ...request.input, seed: randomBytes(6).readUIntBE(0, 6) };
      this.db.prepare(`INSERT INTO generation_tasks
        (id, request_id, request_json, connection_id, snapshot, input, status, created_at, updated_at, submission_started)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(id, request.requestId, requestJson,
        connection.id, JSON.stringify({ model, connection }), JSON.stringify(input), now, now, 0);
      return this.get(id);
    }).immediate();
  }
  /** Creation order is authoritative, including manual requests and equal timestamps. */
  isLatestForTarget(id: string): boolean {
    const latest = this.db.prepare(`SELECT id FROM generation_tasks
      WHERE json_extract(request_json, '$.canvasId')=(SELECT json_extract(request_json, '$.canvasId') FROM generation_tasks WHERE id=?)
      AND json_extract(request_json, '$.nodeId')=(SELECT json_extract(request_json, '$.nodeId') FROM generation_tasks WHERE id=?)
      ORDER BY rowid DESC LIMIT 1`).get(id, id) as {id:string}|undefined;
    return latest?.id === id;
  }
  get(id: string): GenerationTask {
    const task = this.db.prepare('SELECT * FROM generation_tasks WHERE id = ?').get(id) as TaskRecord | undefined;
    if (!task) throw new GenerationError('任务不存在', 404);
    return this.publicTask(task);
  }
  getMany(ids: string[]): GenerationTask[] {
    const tasks: GenerationTask[] = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      const rows = this.db.prepare(`SELECT * FROM generation_tasks WHERE id IN (${batch.map(() => '?').join(',')})`)
        .all(...batch) as TaskRecord[];
      tasks.push(...rows.map(row => this.publicTask(row)));
    }
    return tasks;
  }
  deleteNode(canvasId: string, nodeId: string): void {
    text(canvasId); text(nodeId);
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO generation_deleted_nodes VALUES (?,?)').run(canvasId, nodeId);
      this.db.prepare(`UPDATE generation_tasks SET status='cancelled', lease_token=NULL, lease_until=0, updated_at=?
        WHERE (status='queued' OR (status='submitting' AND submission_started=0)) AND json_extract(request_json, '$.canvasId')=?
        AND json_extract(request_json, '$.nodeId')=?`).run(Date.now(), canvasId, nodeId);
    }).immediate();
  }
  retrySave(id: string): GenerationTask {
    return this.db.transaction(() => {
      const task = this.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(id) as TaskRecord | undefined;
      if (!task) throw new GenerationError('任务不存在', 404);
      if (task.status !== 'succeeded' || !JSON.parse(task.results).length)
        throw new GenerationError('任务尚无生成成功的结果，不能重试保存', 409);
      // Pending/saving/saved are idempotent: a click never steals a live lease.
      if (task.save_status === 'failed') {
        this.db.prepare(`UPDATE generation_tasks SET save_status='pending', error=NULL,
          lease_token=NULL, lease_until=0, updated_at=? WHERE id=?`).run(Date.now(), id);
      }
      return this.get(id);
    }).immediate();
  }
  resume(id: string, now = Date.now()): GenerationTask {
    return this.db.transaction(() => {
      const task = this.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(id) as TaskRecord | undefined;
      if (!task) throw new GenerationError('任务不存在', 404);
      if (['timed_out', 'uncertain'].includes(task.status)) {
        if (!task.platform_id) throw new GenerationError('提交结果待核实，尚无可查询的平台任务 ID', 409);
        const snapshot: TaskSnapshot = JSON.parse(task.snapshot);
        this.db.prepare(`UPDATE generation_tasks SET status='running', deadline=?, next_poll=?,
          query_errors=0, error=NULL, updated_at=?, lease_token=NULL, lease_until=0 WHERE id=?`)
          .run(now + snapshot.connection.queryTimeoutMs, now, now, id);
      }
      return this.get(id);
    }).immediate();
  }
  private publicTask(task: TaskRecord): GenerationTask {
    const request: CreateGeneration = JSON.parse(task.request_json);
    const snapshot: TaskSnapshot = JSON.parse(task.snapshot);
    return { ...request, id: task.id, modelVersion: snapshot.model.version, status: task.status,
      saveStatus: task.save_status, revision: task.revision, createdAt: task.created_at, updatedAt: task.updated_at,
      deadline: task.deadline, artifacts: JSON.parse(task.artifacts), error: task.error,
      ...(snapshot.model.category === 'VIDEO' ? { outputType: 'video' as const } : {}) };
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GenerationError('请求格式无效');
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new GenerationError('包含不支持的参数');
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw new GenerationError('缺少或无效的文本参数');
  return value;
}
function validateRequest(value: unknown): CreateGeneration {
  const r = object(value);
  onlyKeys(r, ['requestId', 'modelId', 'input', 'canvasId', 'nodeId']);
  const input = object(r.input);
  onlyKeys(input, ['prompt', 'width', 'height', 'referenceImages', 'duration', 'references', 'instanceType']);
  if (input.instanceType !== undefined && input.instanceType !== 'plus') throw new GenerationError('无效的执行渠道');
  if (input.referenceImages !== undefined && (!Array.isArray(input.referenceImages) || input.referenceImages.length))
    throw new GenerationError('此模型不支持参考图');
  if (typeof input.width !== 'number' || typeof input.height !== 'number') throw new GenerationError('尺寸必须为数字');
  if (input.duration !== undefined && (typeof input.duration !== 'number' || !Number.isFinite(input.duration)))
    throw new GenerationError('时长必须为数字');
  let references: GenerationReference[] | undefined;
  if (input.references !== undefined) {
    if (!Array.isArray(input.references) || input.references.length > 15) throw new GenerationError('参考素材数量超限');
    references = input.references.map(value => {
      const ref = object(value);
      onlyKeys(ref, ['kind', 'url', 'useAudio']);
      if (!['image', 'video', 'audio'].includes(String(ref.kind))) throw new GenerationError('无效的素材类型');
      if (typeof ref.url !== 'string' || !validReferenceUrl(ref.url)) throw new GenerationError('请先将参考素材上传到本项目存储');
      if (ref.useAudio !== undefined && (ref.kind !== 'video' || typeof ref.useAudio !== 'boolean')) throw new GenerationError('无效的参考声音设置');
      return { kind: ref.kind as GenerationReference['kind'], url: ref.url,
        ...(ref.kind === 'video' ? { useAudio: ref.useAudio !== false } : {}) };
    });
  }
  return { requestId: text(r.requestId), modelId: text(r.modelId), canvasId: text(r.canvasId), nodeId: text(r.nodeId),
    input: { prompt: text(input.prompt), width: input.width, height: input.height,
      ...(input.duration !== undefined ? { duration: input.duration as number } : {}),
      ...(references !== undefined ? { references } : {}),
      ...(input.instanceType === 'plus' ? { instanceType: 'plus' as const } : {}) } satisfies GenerationInput };
}

function validateModelInput(model: ModelConfig, input: GenerationInput) {
  if (model.adapter === 'gemini-image') {
    geminiImageParameters(input);
    if (input.duration !== undefined || input.instanceType !== undefined || (input.references ?? []).some(r => r.kind !== 'image') || (input.references?.length ?? 0) > 8) throw new GenerationError('不支持的 Gemini 图片参数');
    return;
  }
  const video = model.capabilities.video;
  if (!video) {
    if (input.duration !== undefined || input.references !== undefined) throw new GenerationError('此模型不支持视频或参考素材参数');
    return;
  }
  if (!Number.isInteger(input.duration) || input.duration! < video.minDuration || input.duration! > video.maxDuration)
    throw new GenerationError(`目标时长须为 ${video.minDuration}–${video.maxDuration} 的整数秒`);
  for (const [kind, limit] of [['image', video.maxImages], ['video', video.maxVideos], ['audio', video.maxAudios]] as const) {
    if ((input.references || []).filter(r => r.kind === kind).length > limit)
      throw new GenerationError(`参考${{ image: '图片', video: '视频', audio: '音频' }[kind]}最多 ${limit} 个`);
  }
}
