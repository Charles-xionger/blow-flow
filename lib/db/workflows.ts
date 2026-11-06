import { migrateScriptSnapshot } from '../canvas/script-migration';
import { createCanvasHistory } from '../canvas/history';
import { getDatabase } from "./index";
import type { Node, Edge, Viewport } from "@xyflow/react";
import { createHash } from "node:crypto";
import { projectCover } from "../workspace/cover";
import { canonicalJSON, CanvasSaveError, validateSaveOperation, type SaveOperation, type SaveAcknowledgement } from "../canvas/save-protocol";

export interface WorkflowData {
  id: string;
  name: string;
  nodes: Node[];
  edges: Edge[];
  viewport: Viewport;
  createdAt: number;
  updatedAt: number;
  version: number;
  history?: import('../canvas/history').CanvasHistory;
}

interface WorkflowRow {
  id: string;
  name: string;
  data: string;
  created_at: number;
  updated_at: number;
  version: number;
}

export function getAllWorkflows(): WorkflowData[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM workflows WHERE deleted_at IS NULL
    ORDER BY updated_at DESC
  `);

  const rows = stmt.all() as WorkflowRow[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ...migrateScriptSnapshot(JSON.parse(row.data)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }));
}

export function getWorkflowById(id: string): WorkflowData | null {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM workflows WHERE id = ? AND deleted_at IS NULL");
  const row = stmt.get(id) as WorkflowRow | undefined;

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    ...migrateScriptSnapshot(JSON.parse(row.data)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/** The only content writer: content, version and receipt commit atomically. */
export function saveWorkflow(operation: SaveOperation): SaveAcknowledgement {
  validateSaveOperation(operation);
  const { id, requestId, baseVersion } = operation;
  const digest = createHash("sha256").update(canonicalJSON({ baseVersion, snapshot: operation.snapshot })).digest("hex");
  const db = getDatabase();
  return db.transaction(() => {
    // Deletion dominates historical receipts: a replay must never report a
    // tombstoned canvas as a currently saved project.
    if (isWorkflowDeleted(id)) throw new CanvasSaveError("画布已被删除，本地内容已保留，请另存副本", 410);
    const receipt = db.prepare("SELECT digest, version FROM canvas_save_receipts WHERE canvas_id = ? AND request_id = ?")
      .get(id, requestId) as { digest: string; version: number } | undefined;
    if (receipt) {
      if (receipt.digest !== digest) throw new CanvasSaveError("Request ID already used with different content", 409);
      return { id, requestId, version: receipt.version };
    }
    const existing = db.prepare("SELECT version, name, data, cover_url FROM workflows WHERE id = ?").get(id) as { version: number; name: string; data: string; cover_url: string | null } | undefined;
    if ((existing?.version ?? 0) !== baseVersion) throw new CanvasSaveError("Canvas version conflict; local content has been preserved", 409);
    const version = baseVersion + 1;
    const now = Date.now();
    const previous = existing ? JSON.parse(existing.data) : undefined;
    const snapshot = migrateScriptSnapshot(operation.snapshot, previous);
    let history = snapshot.history;
    const present = new Set(snapshot.nodes.map(node => node.id));
    const deletedNode = db.prepare('INSERT OR IGNORE INTO canvas_deleted_nodes VALUES (?,?)');
    for (const node of previous?.nodes ?? []) if (!present.has(node.id)) deletedNode.run(id, node.id);
    // Older writers still use version checks, but cannot silently discard the operation log.
    if (!history && previous?.history) {
      let state = { ...previous, projectName: existing!.name, canvasSession: 0 };
      createCanvasHistory(() => state, update => { state = { ...state, ...update }; })
        .change({ nodes: snapshot.nodes, edges: snapshot.edges, projectName: snapshot.name });
      history = state.history;
    }
    const data = JSON.stringify(migrateScriptSnapshot({ nodes: snapshot.nodes, edges: snapshot.edges, viewport: snapshot.viewport, history }));
    const cover = projectCover(snapshot.nodes, existing ? JSON.parse(existing.data).nodes : [], existing?.cover_url);
    db.prepare(`INSERT INTO workflows (id, name, data, created_at, updated_at, version, cover_url, node_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data,
        updated_at = excluded.updated_at, version = excluded.version, cover_url = excluded.cover_url, node_count = excluded.node_count`)
      .run(id, snapshot.name, data, now, now, version, cover, snapshot.nodes.length);
    db.prepare("INSERT INTO canvas_save_receipts (canvas_id, request_id, digest, version) VALUES (?, ?, ?, ?)")
      .run(id, requestId, digest, version);
    return { id, requestId, version };
  }).immediate();
}

export function isWorkflowDeleted(id: string): boolean {
  return !!getDatabase().prepare("SELECT 1 FROM workflows WHERE id = ? AND deleted_at IS NOT NULL").get(id);
}

export function deleteWorkflow(id: string): boolean {
  const db = getDatabase();
  return db.transaction(() => {
    const result = db.prepare("UPDATE workflows SET deleted_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL")
      .run(Date.now(), id);
    return result.changes > 0 || isWorkflowDeleted(id);
  }).immediate();
}

/** Read-only history projection: don't load current nodes or retained originals. */
export function getWorkflowHistory(id: string) {
  const row = getDatabase().prepare(`SELECT name, version,
    json_extract(json_remove(data, '$.history.assets', '$.history.checkpoint', '$.history.baseline', '$.history.generations'), '$.history') AS history
    FROM workflows WHERE id = ? AND deleted_at IS NULL`).get(id) as { name: string; version: number; history: string | null } | undefined;
  return row ? { name: row.name, version: row.version,
    history: row.history ? JSON.parse(row.history) as import('../canvas/history-view').HistorySource : undefined } : undefined;
}
