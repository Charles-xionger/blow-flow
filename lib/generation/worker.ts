import { resolveImageOptions } from './image-options';
import { ImageGenerationError } from './image-errors';
import { generateImage } from './image-adapters';
import type { GenerationInput } from './types';
import { RunningHubSockets } from './runninghub-sockets';
import { uploadReferences, ReferencePreparationError, referencePreparationLeaseMs } from './reference-upload';
import { ArtifactSaveError, artifactTransferTiming } from './storage';
import { randomUUID } from 'node:crypto';
import { GenerationService, type TaskRecord, type TaskSnapshot } from './service';
import { platformCall, submissionRejections, transientPlatformErrors, PlatformError, redact, submission, type PlatformFetch } from './runninghub';

export interface WorkerIO {
  fetch: PlatformFetch;
  imageFetch?: typeof fetch;
  generateImage?: (snapshot: TaskSnapshot, input: GenerationInput, beforeSubmit: () => void) => Promise<string>;
  save: (url: string, taskId: string, index: number, mediaType?: 'image' | 'video', outputFormat?: 'png' | 'jpeg') => Promise<string>;
  inspectReference?: Parameters<typeof uploadReferences>[4];
  now?: () => number;
}
export class GenerationWorker {
  private now: () => number;
  private sockets = new RunningHubSockets();
  constructor(private service: GenerationService, private io: WorkerIO) { this.now = io.now || Date.now; }

  async tick(): Promise<boolean> {
    try {
      const task = this.claim();
      if (!task) return false;
      const snapshot: TaskSnapshot = JSON.parse(task.snapshot);
      if (task.status === 'submitting') await this.submit(task, snapshot);
      else if (task.status === 'succeeded') await this.saveArtifacts(task);
      else await this.query(task, snapshot);
      return true;
    } finally {
      const running = this.service.db.prepare("SELECT id FROM generation_tasks WHERE status='running' AND deadline > ?")
        .all(this.now()) as { id: string }[];
      this.sockets.retain(new Set(running.map(t => t.id)));
    }
  }

  close() { this.sockets.close(); }

  private track(task: TaskRecord, snapshot: TaskSnapshot, data: unknown) {
    const address = data && typeof data === 'object' && 'netWssUrl' in data ? data.netWssUrl : undefined;
    this.sockets.connect(task.id, address, snapshot.connection.baseUrl, () => {
      // Notifications only move the next query forward. Claim/update retain lease fencing.
      try {
        this.service.db.prepare(`UPDATE generation_tasks SET next_poll=MIN(next_poll, ?)
          WHERE id=? AND status='running' AND deadline > ?`).run(this.now(), task.id, this.now());
      } catch { /* A periodic query or a restarted worker will recover. */ }
    });
  }

  private claim(): TaskRecord | undefined {
    const db = this.service.db;
    const now = this.now();
    return db.transaction(() => {
      // A crashed submitter might already have paid: never reclaim for submission.
      // Preparation has not called create; it may safely restart downloads/uploads.
      db.prepare(`UPDATE generation_tasks SET status='queued', error=NULL, lease_token=NULL, lease_until=0, updated_at=?
        WHERE status='submitting' AND submission_started=0 AND lease_until <= ?`).run(now, now);
      db.prepare(`UPDATE generation_tasks SET status='uncertain', error='提交结果待核实', updated_at=?
        WHERE status='submitting' AND lease_until <= ?`).run(now, now);
      db.prepare(`UPDATE generation_tasks SET status='timed_out', error='等待超时，平台状态未明确', updated_at=?
        WHERE status='running' AND deadline <= ? AND lease_until <= ?`).run(now, now, now);
      let task = db.prepare(`SELECT * FROM generation_tasks WHERE status='running' AND next_poll <= ?
        AND lease_until <= ? ORDER BY next_poll LIMIT 1`).get(now, now) as TaskRecord | undefined;
      if (!task) task = db.prepare(`SELECT * FROM generation_tasks WHERE status='succeeded'
        AND save_status IN ('pending','saving') AND lease_until <= ? ORDER BY updated_at LIMIT 1`).get(now) as TaskRecord | undefined;
      if (!task) {
        const queued = db.prepare(`SELECT * FROM generation_tasks WHERE status='queued' ORDER BY created_at, rowid`).all() as TaskRecord[];
        task = queued.find(candidate => {
          if (this.service.submissionPaused(candidate)) return false;
          const snapshot: TaskSnapshot = JSON.parse(candidate.snapshot);
          const active = db.prepare(`SELECT COUNT(*) AS count FROM generation_tasks WHERE connection_id=?
            AND status IN ('submitting','running','uncertain','timed_out')`).get(candidate.connection_id) as { count: number };
          const current = this.service.config.connections.find(c => c.id === candidate.connection_id);
          return active.count < (current?.concurrency ?? snapshot.connection.concurrency);
        });
        if (task) {
          task.status = 'submitting';
          const snapshot: TaskSnapshot = JSON.parse(task.snapshot);
          task.deadline = now + snapshot.connection.queryTimeoutMs;
        }
      }
      if (!task) return;
      const snapshot: TaskSnapshot = JSON.parse(task.snapshot);
      task.lease_token = randomUUID();
      // Lease exceeds the bounded HTTP request; stale query writers are fenced.
      task.lease_until = now + (task.status === 'succeeded' ? artifactTransferTiming.leaseMs : snapshot.connection.requestTimeoutMs + 30_000);
      db.prepare(`UPDATE generation_tasks SET status=?, deadline=?, lease_token=?, lease_until=?, updated_at=? WHERE id=?`)
        .run(task.status, task.deadline, task.lease_token, task.lease_until, now, task.id);
      return task;
    }).immediate();
  }

  private update(task: TaskRecord, values: Partial<TaskRecord>): boolean {
    const entries = Object.entries({ ...values, updated_at: this.now() });
    return this.service.db.prepare(`UPDATE generation_tasks SET ${entries.map(([k]) => `${k}=?`).join(',')}
      WHERE id=? AND lease_token=?`).run(...entries.map(([, v]) => v), task.id, task.lease_token).changes > 0;
  }
  private diagnostic(task: TaskRecord, snapshot: TaskSnapshot, response: unknown) {
    const secrets = this.service.config.connections.map(c => process.env[c.apiKeyEnv] || '');
    secrets.push(process.env[snapshot.connection.apiKeyEnv] || '');
    this.service.db.prepare('INSERT INTO generation_diagnostics(task_id,created_at,response) VALUES (?,?,?)')
      .run(task.id, this.now(), redact(response, secrets));
  }
  private startSubmission(task: TaskRecord, snapshot: TaskSnapshot): boolean {
    return this.service.db.transaction(() => {
      if (this.service.submissionPaused(task)) {
        this.update(task, {status:'queued', submission_started:0, lease_until:0, lease_token:null});
        return false;
      }
      if (!this.service.authorizeSubmission(task)) {
        this.update(task, { status: 'cancelled', error: '批准已失效或任务已停止；请重新确认', lease_until: 0, lease_token: null });
        return false;
      }
      return this.update(task, { submission_started: 1, lease_until: this.now() + snapshot.connection.requestTimeoutMs + 30_000,
        deadline: this.now() + snapshot.connection.queryTimeoutMs });
    }).immediate();
  }
  private async submit(task: TaskRecord, snapshot: TaskSnapshot) {
    let started = false;
    try {
      const input = JSON.parse(task.input);
      if (snapshot.model.adapter !== 'runninghub-workflow') {
        const beforeSubmit = () => {
          if (!this.startSubmission(task, snapshot)) throw new Error('Submission cancelled');
          started = true;
        };
        const results = this.io.generateImage
          ? [await this.io.generateImage(snapshot, input, beforeSubmit)]
          : await generateImage(snapshot, input, { beforeSubmit, fetch: this.io.imageFetch,
            renewPreparation: () => {
              if (!this.update(task, { lease_until: this.now() + snapshot.connection.requestTimeoutMs + 30_000 })) throw new Error('Task ownership changed');
            } });
        if (!started) throw new Error('Adapter did not authorize submission');
        if (!this.update(task, {status:'succeeded',results:JSON.stringify(results),save_status:'pending',lease_until:0,error:null})) return;
        task.status = 'succeeded'; task.results = JSON.stringify(results);
        await this.saveArtifacts(task);
        return;
      }
      const references = snapshot.model.category === 'VIDEO'
        ? await uploadReferences(snapshot, input.references || [], this.io.fetch,
          () => this.update(task, { lease_until: this.now() + referencePreparationLeaseMs(snapshot.connection.requestTimeoutMs) }), this.io.inspectReference)
        : [];
      const body = submission(snapshot, input, references);
      // Fence before the paid boundary. An expired owner never submits after takeover.
      if (!this.startSubmission(task, snapshot)) return;
      started = true;
      const result = await platformCall(snapshot, 'create', body, this.io.fetch,
        r => this.diagnostic(task, snapshot, r));
      const data = result.data as { taskId?: unknown; taskStatus?: string } | undefined;
      const platformId = data && ['string', 'number'].includes(typeof data.taskId) && /^\d+$/.test(String(data.taskId))
        ? String(data.taskId) : null;
      if (result.code !== 0 && !platformId) {
        if (!submissionRejections.has(result.code)) throw new PlatformError('unknown');
        this.update(task, { status: 'failed', error: '平台明确拒绝提交', lease_until: 0 });
        return;
      }
      if (!platformId) throw new PlatformError('unknown');
      const accepted = this.update(task, { platform_id: platformId, status: data?.taskStatus === 'FAILED' ? 'failed' : 'running',
        error: data?.taskStatus === 'FAILED' ? '平台生成失败' : null, lease_until: 0, next_poll: this.now() });
      if (accepted && data?.taskStatus !== 'FAILED') this.track(task, snapshot, data);
    } catch (error) {
      if (task.status === 'succeeded') throw error;
      if (error instanceof ImageGenerationError) {
        this.update(task, { status: 'failed', error: error.message, lease_until: 0 });
        return;
      }
      if (error instanceof ReferencePreparationError && error.diagnostic) this.diagnostic(task, snapshot, error.diagnostic);
      this.update(task, started
        ? { status: 'uncertain', error: '提交结果待核实，请勿重复生成', lease_until: 0 }
        : { status: 'failed', error: `${error instanceof ReferencePreparationError ? error.message : '素材准备失败'}；尚未提交生成`, lease_until: 0 });
    }
  }
  private async saveArtifacts(task: TaskRecord) {
    const urls: string[] = JSON.parse(task.results);
    const artifacts: string[] = JSON.parse(task.artifacts);
    try {
      for (let index = artifacts.length; index < urls.length; index++) {
        // Renew for each bounded transfer and stop immediately if a new owner fenced us.
        if (!this.update(task, { save_status: 'saving', lease_until: this.now() + artifactTransferTiming.leaseMs, error: null })) return;
        const snapshot: TaskSnapshot = JSON.parse(task.snapshot);
        artifacts.push(await this.io.save(urls[index], task.id, index, snapshot.model.category === 'VIDEO' ? 'video' : 'image',
          snapshot.model.capabilities.image?.options ? resolveImageOptions((JSON.parse(task.input) as GenerationInput).imageOptions, snapshot.model.capabilities.image).outputFormat : undefined));
        if (!this.update(task, { artifacts: JSON.stringify(artifacts) })) return;
      }
      this.update(task, { save_status: 'saved', lease_until: 0, error: null });
    } catch (error) {
      const reason = error instanceof ArtifactSaveError ? error.reason : 'unknown';
      this.diagnostic(task, JSON.parse(task.snapshot), { stage: 'artifact_save', index: artifacts.length, reason });
      this.update(task, { save_status: 'failed',
        error: `生成成功但结果保存失败：${error instanceof ArtifactSaveError ? error.message : '转存未完成'}；可重试保存`,
        lease_until: 0 });
    }
  }
  private async query(task: TaskRecord, snapshot: TaskSnapshot) {
    try {
      if (snapshot.model.adapter !== 'runninghub-workflow') throw new Error('Image task has no query protocol');
      const model = snapshot.model;
      const result = await platformCall(snapshot, 'outputs', { taskId: task.platform_id }, this.io.fetch,
        r => this.diagnostic(task, snapshot, r));
      const hasAddress = result.data && typeof result.data === 'object' && 'netWssUrl' in result.data;
      if (result.code === 804 || result.code === 813 || (result.code === 0 && hasAddress)) {
        const interval = this.sockets.has(task.id) ? Math.max(30_000, snapshot.connection.pollIntervalMs) : snapshot.connection.pollIntervalMs;
        if (this.update(task, { next_poll: this.now() + interval, lease_until: 0, query_errors: 0 }))
          this.track(task, snapshot, result.data);
        return;
      }
      if (result.code === 805) {
        const reason = (result.data as { failedReason?: { exception_type?: unknown } } | undefined)?.failedReason;
        const outOfMemory = /OutOfMemory/i.test(String(reason?.exception_type ?? ''));
        this.update(task, { status: 'failed', lease_until: 0,
          error: outOfMemory ? '平台生成失败：显存不足，请降低分辨率或时长，或选择高性能渠道' : '平台生成失败' });
        return;
      }
      if (result.code !== 0) throw new PlatformError(transientPlatformErrors.has(result.code) ? 'transient' : 'business');
      if (!Array.isArray(result.data) || !result.data.length) throw new PlatformError('unknown');
      const files = result.data.filter((f: { nodeId?: string; fileType?: string; fileUrl?: string }) => {
        if (String(f.nodeId) !== model.outputNode) return false;
        if (snapshot.model.category !== 'VIDEO') return true;
        return ['mp4', 'video/mp4'].includes(String(f.fileType).toLowerCase())
          || (!f.fileType && typeof f.fileUrl === 'string' && /\.mp4(?:$|\?)/i.test(f.fileUrl));
      });
      const urls: string[] = files.map((f: { fileUrl?: unknown }) => {
        if (typeof f.fileUrl !== 'string' || !/^https?:\/\//.test(f.fileUrl)) throw new PlatformError('unknown');
        return f.fileUrl;
      });
      if (!urls.length) throw new PlatformError('unknown');
      if (!this.update(task, { status: 'succeeded', results: JSON.stringify(urls), save_status: 'saving',
        lease_until: this.now() + artifactTransferTiming.leaseMs, error: null })) return;
      task.status = 'succeeded';
      task.results = JSON.stringify(urls);
      await this.saveArtifacts(task);
    } catch (error) {
      // Persistence failures during transfer must never rewrite generation success.
      if (task.status === 'succeeded') throw error;
      const errors = task.query_errors + 1;
      const retry = error instanceof PlatformError && error.kind === 'transient' && errors < snapshot.connection.maxQueryErrors;
      this.update(task, { query_errors: errors, lease_until: 0,
        next_poll: this.now() + snapshot.connection.pollIntervalMs,
        ...(retry ? {} : { status: 'uncertain', error: '查询结果待核实，已停止自动查询' }) });
    }
  }
}
