import type Database from 'better-sqlite3';
import { getScriptService, ScriptError, type ScriptService } from './service';
import { scriptActive, type ScriptTask } from './types';

export interface ScriptVersion extends ScriptTask { draft: string; draftRevision: number; edited: boolean }
export interface ScriptVersions { versions: ScriptVersion[]; selectedId: string | null; selectionRevision: number }

/** A task is the immutable identity of a version. Draft writes never update its original or status. */
export class ScriptVersionService {
  constructor(private tasks: ScriptService, public db: Database.Database = tasks.db) {
    db.exec(`CREATE TABLE IF NOT EXISTS script_drafts (
      version_id TEXT PRIMARY KEY REFERENCES script_tasks(id), text TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS script_selections (
      canvas_id TEXT NOT NULL, node_id TEXT NOT NULL, version_id TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(canvas_id,node_id));`);
  }
  get(versionId: string): ScriptVersion {
    const task = this.tasks.get(versionId);
    const draft = this.db.prepare('SELECT text,revision FROM script_drafts WHERE version_id=?').get(versionId) as {text:string;revision:number} | undefined;
    return { ...task, draft:draft?.text ?? task.text, draftRevision:draft?.revision ?? 0, edited:!!draft };
  }
  list(canvasId: string, nodeId: string): ScriptVersions {
    return this.db.transaction(() => {
      const versions = this.tasks.list(canvasId,nodeId).map(task => this.get(task.id));
      const selection = this.db.prepare('SELECT version_id,revision FROM script_selections WHERE canvas_id=? AND node_id=?').get(canvasId,nodeId) as {version_id:string;revision:number} | undefined;
      return { versions, selectedId:selection?.version_id ?? versions[0]?.id ?? null, selectionRevision:selection?.revision ?? 0 };
    })();
  }
  saveDraft(versionId: string, text: string, expectedRevision: number): ScriptVersion {
    if (typeof text !== 'string' || text.length > 2_000_000 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ScriptError('编辑稿或版本身份无效');
    return this.db.transaction(() => {
      const version = this.get(versionId);
      if (scriptActive(version.status)) throw new ScriptError('请等待生成结束后编辑该版本',409);
      if (version.draftRevision !== expectedRevision) throw new ScriptError('编辑稿已在其他窗口更新，请保留当前文字并重新载入后编辑',409);
      this.db.prepare('INSERT INTO script_drafts(version_id,text,revision) VALUES(?,?,1) ON CONFLICT(version_id) DO UPDATE SET text=excluded.text,revision=script_drafts.revision+1').run(versionId,text);
      return this.get(versionId);
    }).immediate();
  }
  select(canvasId: string, nodeId: string, versionId: string, expectedRevision: number): ScriptVersions {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ScriptError('选用版本身份无效');
    return this.db.transaction(() => {
      const version = this.get(versionId);
      if (version.canvasId !== canvasId || version.nodeId !== nodeId) throw new ScriptError('版本不属于该脚本节点',409);
      const current = this.list(canvasId,nodeId);
      if (current.selectionRevision !== expectedRevision) throw new ScriptError('选用版本已在其他窗口更新，请重新选择',409);
      this.db.prepare('INSERT INTO script_selections(canvas_id,node_id,version_id,revision) VALUES(?,?,?,1) ON CONFLICT(canvas_id,node_id) DO UPDATE SET version_id=excluded.version_id,revision=script_selections.revision+1').run(canvasId,nodeId,versionId);
      return this.list(canvasId,nodeId);
    }).immediate();
  }
  /** Call inside publishing's SQLite transaction, with the reviewed draft identity. */
  getPublishableDraft(canvasId: string, nodeId: string, versionId: string, expectedDraftRevision: number): ScriptVersion {
    const state = this.list(canvasId,nodeId);
    const version = state.versions.find(v => v.id === versionId);
    if (!version || state.selectedId !== versionId) throw new ScriptError('请重新确认当前选用版本',409);
    if (version.status !== 'completed') throw new ScriptError('未完成版本不能发布',409);
    if (version.draftRevision !== expectedDraftRevision) throw new ScriptError('编辑稿已更新，请重新确认发布内容',409);
    if (!version.draft.trim()) throw new ScriptError('编辑稿为空，无法发布',409);
    return version;
  }
}
export const getScriptVersionService = () => new ScriptVersionService(getScriptService());
